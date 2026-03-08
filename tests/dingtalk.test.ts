import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DWClient, EventAck, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import { DingTalkAdapter } from "../src/adapters/platform/dingtalk.js";
import { Logger } from "../src/logging.js";

function createAdapter(overrides: Partial<ConstructorParameters<typeof DingTalkAdapter>[0]> = {}): DingTalkAdapter {
  return new DingTalkAdapter(
    {
      clientId: "id",
      clientSecret: "secret",
      allowFrom: "*",
      processingNotice: "处理中...",
      ...overrides,
    },
    new Logger("error"),
  );
}

function createRobotMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: "cid",
    chatbotCorpId: "corp",
    chatbotUserId: "bot-user",
    msgId: "msg-1",
    senderNick: "Alice",
    isAdmin: false,
    senderStaffId: "staff-1",
    sessionWebhookExpiredTime: Date.now() + 60_000,
    createAt: Date.now(),
    senderCorpId: "sender-corp",
    conversationType: "2",
    senderId: "sender-1",
    sessionWebhook: "https://example.com/webhook",
    robotCode: "robot-code",
    msgtype: "text",
    text: {
      content: "hello",
    },
    ...overrides,
  };
}

function createDownstream(message: Record<string, unknown>, overrides: Partial<DWClientDownStream["headers"]> = {}): DWClientDownStream {
  return {
    specVersion: "1.0",
    type: "CALLBACK",
    headers: {
      appId: "app",
      connectionId: "conn",
      contentType: "application/json",
      messageId: "stream-1",
      time: new Date().toISOString(),
      topic: TOPIC_ROBOT,
      ...overrides,
    },
    data: JSON.stringify(message),
  };
}

function createFetchResponse(options: {
  ok?: boolean;
  status?: number;
  bodyText?: string;
  jsonBody?: unknown;
  arrayBufferBody?: ArrayBuffer;
  headers?: Record<string, string>;
}) {
  const headers = new Headers(options.headers);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers,
    text: async () => options.bodyText ?? "",
    json: async () => options.jsonBody,
    arrayBuffer: async () => options.arrayBufferBody ?? new ArrayBuffer(0),
  };
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function extractPromptField(content: string, key: string): string | undefined {
  return new RegExp(`${key}: (.+)`).exec(content)?.[1]?.trim();
}

describe("dingtalk adapter", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
  });

  test("onDownstream emits namespaced session keys and persists webhook expiry", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    const result = (adapter as any).onDownstream(createDownstream(createRobotMessage()));

    expect(result).toEqual({ status: EventAck.SUCCESS });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "dingtalk",
        sessionKey: "dingtalk:cid:staff-1",
        userId: "staff-1",
        userName: "Alice",
        content: "hello",
        deliveryTarget: {
          platform: "dingtalk",
          payload: expect.objectContaining({
            sessionWebhook: "https://example.com/webhook",
            sessionWebhookExpiredTime: expect.any(Number),
          }),
        },
        replyContext: expect.objectContaining({
          messageId: "msg-1",
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: expect.any(Number),
        }),
      }),
    );
  });

  test("onDownstream downloads picture messages and passes a local image path to the handler", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const imageBytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-1",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            downloadUrl: "https://files.example.com/image.png",
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: imageBytes.buffer.slice(0),
          headers: {
            "content-type": "image/png",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "picture-msg",
            msgtype: "picture",
            text: undefined,
            content: {
              downloadCode: "dl_img_1",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    const imagePath = extractPromptField(String(message?.content), "image_path");

    expect(message).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("[DingTalk image]"),
      }),
    );
    expect(message.content).toContain("media_mime_type: image/png");
    expect(message.content).toContain("image_mime_type: image/png");
    expect(imagePath).toBeTruthy();
    expect(imagePath?.startsWith(inboundMediaDir)).toBe(true);
    await expect(readFile(String(imagePath))).resolves.toEqual(Buffer.from(imageBytes));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("onDownstream keeps audio recognition text and skips downloading audio media", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "audio-msg",
            msgtype: "audio",
            text: undefined,
            content: {
              downloadCode: "dl_audio_1",
              recognition: "这是语音识别结果",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];

    expect(message.content).toContain("这是语音识别结果");
    expect(message.content).not.toContain("[DingTalk audio]");
    expect(message.content).not.toContain("audio_path:");
    expect(message.content).not.toContain("audio_mime_type:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("onDownstream downloads video messages and passes a local video path", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const videoBytes = Uint8Array.from([11, 12, 13, 14]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-video",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            downloadUrl: "https://files.example.com/video.mp4",
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: videoBytes.buffer.slice(0),
          headers: {
            "content-type": "video/mp4",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "video-msg",
            msgtype: "video",
            text: undefined,
            content: {
              downloadCode: "dl_video_1",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    const videoPath = extractPromptField(String(message?.content), "video_path");

    expect(message.content).toContain("[DingTalk video]");
    expect(message.content).toContain("video_mime_type: video/mp4");
    expect(videoPath).toBeTruthy();
    await expect(readFile(String(videoPath))).resolves.toEqual(Buffer.from(videoBytes));
  });

  test("onDownstream downloads file messages and preserves file metadata", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const fileBytes = Uint8Array.from([21, 22, 23, 24]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-file",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            downloadUrl: "https://files.example.com/spec.pdf",
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: fileBytes.buffer.slice(0),
          headers: {
            "content-type": "application/pdf",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "file-msg",
            msgtype: "file",
            text: undefined,
            content: {
              downloadCode: "dl_file_1",
              fileName: "spec.pdf",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    const filePath = extractPromptField(String(message?.content), "file_path");

    expect(message.content).toContain("[DingTalk file]");
    expect(message.content).toContain("file_name: spec.pdf");
    expect(message.content).toContain("file_mime_type: application/pdf");
    expect(filePath).toBeTruthy();
    await expect(readFile(String(filePath))).resolves.toEqual(Buffer.from(fileBytes));
  });

  test("onDownstream keeps richText text and appends image metadata when a picture part is present", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-2",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            data: {
              downloadUrl: "https://files.example.com/rich.png",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: Uint8Array.from([9, 8, 7]).buffer,
          headers: {
            "content-type": "image/png",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "rich-picture-msg",
            msgtype: "richText",
            text: undefined,
            content: {
              richText: [
                { type: "text", text: "请看这张图" },
                { type: "at", atName: "Bob" },
                { type: "picture", downloadCode: "dl_rich_1" },
              ],
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    expect(message.content).toContain("请看这张图");
    expect(message.content).toContain("@Bob");
    expect(message.content).toContain("[DingTalk image]");
    expect(message.content).toContain("media_path:");
    expect(message.content).toContain("image_path:");
  });

  test("onDownstream falls back to image metadata when picture download fails", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-3",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          ok: false,
          status: 502,
          bodyText: "bad gateway",
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "picture-fail-msg",
            msgtype: "picture",
            text: undefined,
            content: {
              downloadCode: "dl_fail_1",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    expect(message.content).toContain("[DingTalk image]");
    expect(message.content).toContain("media_download_code: dl_fail_1");
    expect(message.content).toContain("image_download_code: dl_fail_1");
    expect(message.content).toContain("media_status: unavailable");
    expect(message.content).toContain("image_status: unavailable");
  });

  test("onDownstream prefixes quoted text as context", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-text-msg",
            text: {
              content: "当前消息",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "text",
                content: {
                  text: "被引用文字",
                },
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("[引用消息: \"被引用文字\"]"),
      }),
    );
    expect(handler.mock.calls[0]?.[0]?.content).toContain("当前消息");
  });

  test("onDownstream downloads quoted picture messages and passes a local image path", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const imageBytes = Uint8Array.from([31, 32, 33, 34]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-quoted-image",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            downloadUrl: "https://files.example.com/quoted.png",
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: imageBytes.buffer.slice(0),
          headers: {
            "content-type": "image/png",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-image-msg",
            text: {
              content: "帮我看看这张图",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "picture",
                msgId: "quoted-picture-origin",
                createdAt: Date.now() - 5_000,
                content: {
                  downloadCode: "dl_quote_img_1",
                },
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    const imagePath = extractPromptField(String(message?.content), "image_path");

    expect(message.content).toContain("[引用图片]");
    expect(message.content).toContain("[Quoted DingTalk image]");
    expect(message.content).toContain("帮我看看这张图");
    expect(imagePath).toBeTruthy();
    await expect(readFile(String(imagePath))).resolves.toEqual(Buffer.from(imageBytes));
  });

  test("onDownstream resolves quoted unknownMsgType media from local cache first", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const handler = vi.fn();
    const cachedFileBytes = Uint8Array.from([41, 42, 43, 44]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-cache",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            downloadUrl: "https://files.example.com/cached.docx",
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: cachedFileBytes.buffer.slice(0),
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    await (adapter as any).rememberInboundMedia(
      createRobotMessage({
        msgId: "origin-file-msg",
        msgtype: "file",
        text: undefined,
        content: {
          downloadCode: "dl_cached_file_1",
          fileName: "cached.docx",
          spaceId: "space-1",
          fileId: "file-1",
        },
      }),
      {
        source: "current",
        kind: "file",
        downloadCode: "dl_cached_file_1",
        fileName: "cached.docx",
      },
    );

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-cache-msg",
            text: {
              content: "看下这个引用文件",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "unknownMsgType",
                msgId: "origin-file-msg",
                createdAt: Date.now() - 10_000,
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    const filePath = extractPromptField(String(message?.content), "file_path");

    expect(message.content).toContain("[引用文件/视频/语音]");
    expect(message.content).toContain("[Quoted DingTalk file]");
    expect(message.content).toContain("file_name: cached.docx");
    expect(filePath).toBeTruthy();
    await expect(readFile(String(filePath))).resolves.toEqual(Buffer.from(cachedFileBytes));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("onDownstream falls back to group file resolution when cached quoted media download expires", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    await (adapter as any).rememberInboundMedia(
      createRobotMessage({
        msgId: "origin-video-msg",
        msgtype: "video",
        text: undefined,
        content: {
          downloadCode: "dl_cached_video_1",
          spaceId: "space-video",
          fileId: "video-file-1",
        },
      }),
      {
        source: "current",
        kind: "video",
        downloadCode: "dl_cached_video_1",
      },
    );

    const downloadSpy = vi
      .spyOn(adapter as any, "downloadMediaByDownloadCode")
      .mockRejectedValue(new Error("expired"));
    const fallbackSpy = vi
      .spyOn(adapter as any, "resolveQuotedMediaFromGroup")
      .mockResolvedValue({
        path: "/tmp/quoted-video-fallback.mp4",
        contentType: "video/mp4",
      });

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-video-msg",
            conversationType: "2",
            text: {
              content: "看看这个引用视频",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "unknownMsgType",
                msgId: "origin-video-msg",
                createdAt: Date.now() - 12_000,
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0];
    expect(downloadSpy).toHaveBeenCalledWith("dl_cached_video_1", "robot-code");
    expect(fallbackSpy).toHaveBeenCalled();
    expect(message.content).toContain("[Quoted DingTalk video]");
    expect(message.content).toContain("video_path: /tmp/quoted-video-fallback.mp4");
    expect(message.content).toContain("video_mime_type: video/mp4");
  });

  test("onDownstream ignores duplicate messages", () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    const downstream = createDownstream(createRobotMessage());
    expect((adapter as any).onDownstream(downstream)).toEqual({ status: EventAck.SUCCESS });
    expect((adapter as any).onDownstream(downstream)).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("onDownstream still ignores duplicate messages after 60 seconds", async () => {
    vi.useFakeTimers();

    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    const downstream = createDownstream(createRobotMessage());
    expect((adapter as any).onDownstream(downstream)).toEqual({ status: EventAck.SUCCESS });

    await vi.advanceTimersByTimeAsync(60_001);
    expect((adapter as any).onDownstream(downstream)).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("onDownstream ignores old startup messages", () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    const downstream = createDownstream(
      createRobotMessage({
        msgId: "old-msg",
        createAt: Date.now() - 60_000,
      }),
    );

    expect((adapter as any).onDownstream(downstream)).toEqual({ status: EventAck.SUCCESS });
    expect(handler).not.toHaveBeenCalled();
  });

  test("onDownstream does not persist expired delivery targets", () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    (adapter as any).onDownstream(
      createDownstream(
        createRobotMessage({
          msgId: "expired-msg",
          sessionWebhookExpiredTime: Date.now() - 1,
        }),
      ),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget: undefined,
        replyContext: expect.objectContaining({
          sessionWebhookExpiredTime: expect.any(Number),
        }),
      }),
    );
  });

  test("send uses persisted delivery target sessionWebhook", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.send(
      {
        platform: "dingtalk",
        payload: {
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
          conversationId: "cid",
          senderId: "uid",
        },
      },
      "hello",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("send uses markdown payload when reply content contains markdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.send(
      {
        platform: "dingtalk",
        payload: {
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
          conversationId: "cid",
          senderId: "uid",
        },
      },
      "## Title\n- item",
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "Title",
        text: "## Title\n- item",
      },
    });
  });

  test("onDownstream sends a delayed processing notice for slow turns", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    let resolveHandler: (() => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const adapter = createAdapter();

    (adapter as { handler?: typeof handler }).handler = handler;

    expect((adapter as any).onDownstream(createDownstream(createRobotMessage()))).toEqual({ status: EventAck.SUCCESS });

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/webhook");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      msgtype: "text",
      text: {
        content: "处理中...",
      },
    });

    resolveHandler?.();
    await Promise.resolve();
  });

  test("onDownstream skips processing notice for fast turns", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    (adapter as { handler?: () => Promise<void> }).handler = vi.fn(async () => {});

    expect((adapter as any).onDownstream(createDownstream(createRobotMessage()))).toEqual({ status: EventAck.SUCCESS });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("onDownstream skips processing notice for slash commands", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    let resolveHandler: (() => void) | undefined;
    const adapter = createAdapter();
    (adapter as { handler?: () => Promise<void> }).handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "cmd-msg",
            text: {
              content: "/session list",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();

    resolveHandler?.();
    await Promise.resolve();
  });

  test("start registers robot callback subscription", async () => {
    let callbackListener: ((downstream: DWClientDownStream) => void) | undefined;
    const registerCallbackListener = vi
      .spyOn(DWClient.prototype, "registerCallbackListener")
      .mockImplementation(function (_topic, callback) {
        callbackListener = callback;
        return this;
      });
    const registerAllEventListener = vi
      .spyOn(DWClient.prototype, "registerAllEventListener")
      .mockImplementation(function (_callback) {
        return this;
      });
    const connect = vi.spyOn(DWClient.prototype, "connect").mockImplementation(async function () {
      (this as unknown as { connected: boolean }).connected = true;
    });
    const socketCallBackResponse = vi
      .spyOn(DWClient.prototype, "socketCallBackResponse")
      .mockImplementation(() => {});
    const disconnect = vi.spyOn(DWClient.prototype, "disconnect").mockImplementation(() => {});

    const handler = vi.fn(async () => {});
    const adapter = createAdapter();
    await adapter.start(handler);

    expect(registerCallbackListener).toHaveBeenCalledWith(TOPIC_ROBOT, expect.any(Function));
    expect(registerAllEventListener).not.toHaveBeenCalled();
    expect(callbackListener).toBeTypeOf("function");

    callbackListener?.(createDownstream(createRobotMessage()));

    expect(socketCallBackResponse).toHaveBeenCalledWith("stream-1", "");
    expect(handler).toHaveBeenCalledTimes(1);

    await adapter.stop();

    connect.mockRestore();
    socketCallBackResponse.mockRestore();
    disconnect.mockRestore();
    registerCallbackListener.mockRestore();
    registerAllEventListener.mockRestore();
  });

  test("send rejects expired persisted delivery target", async () => {
    const adapter = createAdapter();

    await expect(
      adapter.send(
        {
          platform: "dingtalk",
          payload: {
            sessionWebhook: "https://example.com/webhook",
            sessionWebhookExpiredTime: Date.now() - 1,
          },
        },
        "hello",
      ),
    ).rejects.toThrow(/sessionWebhook expired/i);
  });

  test("send converts fetch aborts into timeout errors", async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await expect(
      adapter.send(
        {
          platform: "dingtalk",
          payload: {
            sessionWebhook: "https://example.com/webhook",
            sessionWebhookExpiredTime: Date.now() + 60_000,
          },
        },
        "hello",
      ),
    ).rejects.toThrow(/timed out/i);
  });

  test("waitForConnected resolves once the websocket opens", async () => {
    vi.useFakeTimers();

    const adapter = createAdapter();
    const client = { connected: false };
    const ready = (adapter as any).waitForConnected(client);

    setTimeout(() => {
      client.connected = true;
    }, 200);

    await vi.advanceTimersByTimeAsync(300);
    await expect(ready).resolves.toBeUndefined();
  });

  test("waitForConnected rejects when the websocket never opens", async () => {
    vi.useFakeTimers();

    const adapter = createAdapter();
    const ready = (adapter as any).waitForConnected({ connected: false });
    const assertion = expect(ready).rejects.toThrow(/did not connect/i);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  test("processing notice can be disabled with none", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    let resolveHandler: (() => void) | undefined;
    const adapter = createAdapter({ processingNotice: "none" });
    (adapter as { handler?: () => Promise<void> }).handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );

    expect((adapter as any).onDownstream(createDownstream(createRobotMessage({ msgId: "none-msg" })))).toEqual({
      status: EventAck.SUCCESS,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();

    resolveHandler?.();
    await Promise.resolve();
  });
});
