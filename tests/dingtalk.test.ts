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
            openConversationId: "cid",
            conversationId: "cid",
            conversationType: "2",
            robotCode: "robot-code",
            sessionWebhook: "https://example.com/webhook",
            sessionWebhookExpiredTime: expect.any(Number),
            userId: "staff-1",
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

  test("onDownstream uses quoted audio recognition as context and skips downloading quoted audio", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-audio-msg",
            text: {
              content: "帮我处理这段语音",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "audio",
                msgId: "quoted-audio-origin",
                createdAt: Date.now() - 5_000,
                content: {
                  recognition: "这是被引用语音的识别文本",
                  downloadCode: "dl_quote_audio_1",
                },
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("[引用语音: \"这是被引用语音的识别文本\"]"),
      }),
    );
    expect(handler.mock.calls[0]?.[0]?.content).toContain("帮我处理这段语音");
    expect(handler.mock.calls[0]?.[0]?.content).not.toContain("[Quoted DingTalk audio]");
    expect(handler.mock.calls[0]?.[0]?.content).not.toContain("audio_path:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("onDownstream uses local audio cache by createdAt for quoted unknownMsgType audio", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();
    const fetchMock = vi.fn();
    const originalCreatedAt = Date.now();

    vi.stubGlobal("fetch", fetchMock);
    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            conversationId: "group-cid",
            msgId: "origin-audio-msg",
            createAt: originalCreatedAt,
            msgtype: "audio",
            text: undefined,
            content: {
              downloadCode: "dl_cached_audio_1",
              recognition: "缓存里的群聊语音识别",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    handler.mockClear();

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            conversationId: "group-cid",
            msgId: "quoted-unknown-audio-msg",
            text: {
              content: "这段语音说了什么",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "unknownMsgType",
                msgId: "quoted-alias-msg-id",
                createdAt: originalCreatedAt,
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const content = String(handler.mock.calls[0]?.[0]?.content);
    expect(content).toContain("[引用语音: \"缓存里的群聊语音识别\"]");
    expect(content).toContain("这段语音说了什么");
    expect(content).not.toContain("[Quoted DingTalk file]");
    expect(content).not.toContain("media_status: unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
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

  test("onDownstream persists openConversationId even when sessionWebhook is expired", () => {
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
        deliveryTarget: {
          platform: "dingtalk",
          payload: {
            openConversationId: "cid",
            conversationId: "cid",
            conversationType: "2",
            robotCode: "robot-code",
            userId: "staff-1",
          },
        },
        replyContext: expect.objectContaining({
          sessionWebhookExpiredTime: expect.any(Number),
        }),
      }),
    );
  });

  test("send ignores persisted delivery targets without proactive send identifiers", async () => {
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
          conversationId: "cid",
          senderId: "staff-1",
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
        },
      },
      "hello",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("send uses robot group send api even when persisted sessionWebhook is fresh", async () => {
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
            result: {},
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.send(
      {
        platform: "dingtalk",
        payload: {
          openConversationId: "cid",
          conversationType: "2",
          robotCode: "robot-code",
          userId: "staff-1",
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
        },
      },
      "hello",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": "token-1",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      openConversationId: "cid",
      robotCode: "robot-code",
      msgKey: "sampleText",
      msgParam: JSON.stringify({
        content: "hello",
      }),
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.anything(),
    );
  });

  test("send uses markdown template payload for robot group sends", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            accessToken: "token-1",
            expireIn: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            result: {},
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.send(
      {
        platform: "dingtalk",
        payload: {
          openConversationId: "cid-open",
          conversationType: "2",
          robotCode: "robot-code",
        },
      },
      "## Title\n- item",
    );

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      openConversationId: "cid-open",
      robotCode: "robot-code",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "Title",
        text: "## Title\n- item",
      }),
    });
  });

  test("send uses robot direct send api for direct conversations", async () => {
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
            result: {},
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.send(
      {
        platform: "dingtalk",
        payload: {
          conversationType: "1",
          openConversationId: "cid-direct",
          robotCode: "robot-code",
          userId: "staff-1",
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
        },
      },
      "hello",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": "token-1",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      robotCode: "robot-code",
      msgKey: "sampleText",
      msgParam: JSON.stringify({
        content: "hello",
      }),
      userIds: ["staff-1"],
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.anything(),
    );
  });

  test("reply uses markdown payload when reply content contains markdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.reply(
      {
        sessionWebhook: "https://example.com/webhook",
        sessionWebhookExpiredTime: Date.now() + 60_000,
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

  test("reply renders tool status messages as fenced code markdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "ok",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await adapter.reply(
      {
        sessionWebhook: "https://example.com/webhook",
        sessionWebhookExpiredTime: Date.now() + 60_000,
      },
      "🛠️ Agent\n`Explore | Explore codebase structure`",
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "🛠️ Agent",
        text: "🛠️ Agent\n```json\nExplore | Explore codebase structure\n```",
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

  test("send ignores expired persisted delivery target without active send identifiers", async () => {
    const adapter = createAdapter();

    await expect(adapter.send(
      {
        platform: "dingtalk",
        payload: {
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() - 1,
        },
      },
      "hello",
    )).resolves.toBeUndefined();
  });

  test("reply converts fetch aborts into timeout errors", async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();

    await expect(
      adapter.reply(
        {
          sessionWebhook: "https://example.com/webhook",
          sessionWebhookExpiredTime: Date.now() + 60_000,
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

  test("extracts quoted rich text when replied message carries richText content", () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "quoted-richtext-msg",
            text: {
              content: "请继续",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "",
                msgId: "quoted-msg-id",
                content: {
                  richText: [
                    {
                      type: "text",
                      content: "引用内容",
                    },
                    {
                      type: "emoji",
                      content: "😊",
                    },
                    {
                      type: "at",
                      atName: "Alice",
                    },
                    {
                      type: "picture",
                    },
                    {
                      content: "尾巴",
                    },
                  ],
                },
              },
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "[引用消息: \"引用内容😊@Alice[图片]尾巴\"]",
        ),
      }),
    );
  });

  test("uses [DingTalk text] when inbound text is blank and has no media", () => {
    const adapter = createAdapter();
    const handler = vi.fn();

    (adapter as any).handler = handler;

    expect(
      (adapter as any).onDownstream(
        createDownstream(
          createRobotMessage({
            msgId: "blank-text-msg",
            text: {
              content: "   ",
            },
          }),
        ),
      ),
    ).toEqual({ status: EventAck.SUCCESS });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "[text]",
      }),
    );
  });

  test("caches union id lookup results", async () => {
    const adapter = createAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-union",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            errcode: 0,
            result: {
              unionid: "union-staff-1",
            },
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const first = await (adapter as any).getUnionIdByStaffId("staff-1");
    const second = await (adapter as any).getUnionIdByStaffId("staff-1");

    expect(first).toBe("union-staff-1");
    expect(second).toBe("union-staff-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("caches dingtalk group space lookup results", async () => {
    const adapter = createAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-space",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            space: {
              spaceId: "space-1",
            },
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const first = await (adapter as any).getGroupFileSpaceId("conversation-1", "union-1");
    const second = await (adapter as any).getGroupFileSpaceId("conversation-1", "union-1");

    expect(first).toBe("space-1");
    expect(second).toBe("space-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("finds a group file close to quoted message creation time", async () => {
    const adapter = createAdapter();
    const targetCreatedAt = Date.parse("2026-03-14T10:00:10+0800");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-space-list",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            dentries: [
              {
                id: "skip-not-file",
                type: "FOLDER",
                name: "folder",
                createTime: "Mon Mar 14 2026 10:00:08 CST",
              },
              {
                id: "broken-time",
                type: "FILE",
                name: "broken.txt",
                createTime: "not-a-time",
              },
              {
                id: "matched-file",
                type: "FILE",
                name: "matched.txt",
                createTime: "2026-03-14T10:00:11+0800",
              },
            ],
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await (adapter as any).findGroupFileByTimestamp(
      "space-1",
      "union-1",
      targetCreatedAt,
    );

    expect(result).toEqual({
      dentryId: "matched-file",
      name: "matched.txt",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("resolves group quoted media through cached space id and file id", async () => {
    const adapter = createAdapter();
    const unionIdSpy = vi.spyOn(adapter as any, "getUnionIdByStaffId").mockResolvedValue("union-1");
    const downloadSpy = vi.spyOn(adapter as any, "downloadGroupFile").mockResolvedValue({
      path: "/tmp/resolved.bin",
      contentType: "application/octet-stream",
    });

    const result = await (adapter as any).resolveQuotedMediaFromGroup(
      createRobotMessage({
        conversationType: "2",
        senderStaffId: "staff-1",
      }),
      {
        source: "quoted",
        kind: "file",
        spaceId: "space-1",
        fileId: "file-1",
        quotedMsgId: "quoted-1",
        quotedCreatedAt: Date.parse("Mon Mar 14 2026 10:00:10 CST"),
      },
      {
        downloadCode: "cached-dl",
        msgType: "file",
        createdAt: Date.parse("Mon Mar 14 2026 10:00:00 CST"),
        expiresAt: Date.parse("Mon Mar 14 2026 10:10:00 CST"),
        spaceId: "space-1",
        fileId: "file-1",
      },
    );

    expect(unionIdSpy).toHaveBeenCalledWith("staff-1");
    expect(downloadSpy).toHaveBeenCalledWith("space-1", "file-1", "union-1");
    expect(result).toEqual({
      path: "/tmp/resolved.bin",
      contentType: "application/octet-stream",
    });
  });

  test("resolves group quoted media via listAll when cache has no file id", async () => {
    const adapter = createAdapter();
    vi.spyOn(adapter as any, "getUnionIdByStaffId").mockResolvedValue("union-2");
    vi.spyOn(adapter as any, "getGroupFileSpaceId").mockResolvedValue("space-2");
    vi.spyOn(adapter as any, "findGroupFileByTimestamp").mockResolvedValue({
      dentryId: "dentry-2",
      name: "group.txt",
    });
    const downloadSpy = vi.spyOn(adapter as any, "downloadGroupFile").mockResolvedValue({
      path: "/tmp/group.txt",
      contentType: "text/plain",
    });

    const result = await (adapter as any).resolveQuotedMediaFromGroup(
      createRobotMessage({
        conversationType: "2",
        senderStaffId: "staff-2",
      }),
      {
        source: "quoted",
        kind: "file",
        quotedMsgId: "quoted-2",
        quotedCreatedAt: 1_700_000_000_000,
      },
      {
        downloadCode: "cached-dl-2",
        msgType: "file",
        createdAt: 1_699_999_000_000,
        expiresAt: 1_700_000_600_000,
      },
    );

    expect(result).toEqual({
      path: "/tmp/group.txt",
      contentType: "text/plain",
    });
  });

  test("does not resolve group quoted media for direct conversations", async () => {
    const adapter = createAdapter();

    const result = await (adapter as any).resolveQuotedMediaFromGroup(
      createRobotMessage({
        conversationType: "1",
        senderStaffId: "staff-1",
      }),
      {
        source: "quoted",
        kind: "file",
      },
    );

    expect(result).toBeNull();
  });

  test("returns null when group quoted media has no resolved file id and no timestamp", async () => {
    const adapter = createAdapter();

    const result = await (adapter as any).resolveQuotedMediaFromGroup(
      createRobotMessage({
        conversationType: "2",
        senderStaffId: "",
      }),
      {
        source: "quoted",
        kind: "file",
        quotedMsgId: "quoted-1",
      },
      {
        downloadCode: "cached-dl",
        msgType: "file",
        createdAt: Date.parse("Mon Mar 14 2026 10:00:00 CST"),
        expiresAt: Date.parse("Mon Mar 14 2026 10:10:00 CST"),
      },
    );

    expect(result).toBeNull();
  });

  test("downloads group files by dentry and saves to inbound media directory", async () => {
    const inboundMediaDir = await mkdtemp(join(tmpdir(), "d-connect-dingtalk-"));
    tempDirs.push(inboundMediaDir);

    const adapter = createAdapter({ inboundMediaDir });
    const fileBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-group-file",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            headerSignatureInfo: {
              resourceUrls: ["https://files.example.com/group.doc"],
              headers: {
                "content-type": "video/mp4",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          arrayBufferBody: fileBytes,
          headers: {
            "content-type": "video/mp4",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await (adapter as any).downloadGroupFile("space-1", "file-1", "union-1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.contentType).toBe("video/mp4");
    expect(result.path).toContain(inboundMediaDir);
    await expect(readFile(result.path)).resolves.toEqual(Buffer.from(fileBytes));
  });

  test("throws when group file downloadInfos result lacks resource URL", async () => {
    const adapter = createAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            access_token: "token-group-file-empty",
            expires_in: 7200,
          },
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          jsonBody: {
            headerSignatureInfo: {},
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect((adapter as any).downloadGroupFile("space-1", "file-1", "union-1")).rejects.toThrow(
      "storage downloadInfos/query returned no resourceUrl",
    );
  });
});
