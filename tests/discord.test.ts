import { afterEach, describe, expect, test, vi } from "vitest";
import { DiscordAdapter } from "../src/adapters/platform/discord.js";
import { Logger } from "../src/logging.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.emit("close", { code, reason });
  }

  emitMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createAdapter(overrides: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}): DiscordAdapter {
  return new DiscordAdapter(
    {
      botToken: "discord-token",
      allowFrom: "*",
      requireMention: true,
      ...overrides,
    },
    new Logger("error"),
  );
}

function createFetchResponse(options: {
  ok?: boolean;
  status?: number;
  bodyText?: string;
  jsonBody?: unknown;
}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => options.bodyText ?? "",
    json: async () => options.jsonBody,
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

async function waitForSocket(): Promise<FakeWebSocket> {
  await waitForAssertion(() => {
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
  });
  return FakeWebSocket.instances[0]!;
}

describe("discord adapter", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("start identifies to gateway and emits inbound dm messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        jsonBody: {
          url: "wss://gateway.discord.gg",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const handler = vi.fn();
    const adapter = createAdapter();
    const startPromise = adapter.start(handler);

    const socket = await waitForSocket();
    socket.emitMessage({
      op: 10,
      d: {
        heartbeat_interval: 30_000,
      },
    });
    socket.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: {
        user: {
          id: "bot-1",
        },
      },
    });

    await startPromise;

    expect(JSON.parse(socket.sent[0]!)).toEqual({
      op: 2,
      d: {
        token: "discord-token",
        intents: 37376,
        properties: {
          os: process.platform,
          browser: "d-connect",
          device: "d-connect",
        },
      },
    });

    socket.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: {
        id: "msg-1",
        channel_id: "channel-1",
        content: "hello",
        author: {
          id: "user-1",
          username: "Alice",
        },
      },
    });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "discord",
          sessionKey: "discord:channel-1:user-1",
          userId: "user-1",
          userName: "Alice",
          content: "hello",
          replyContext: {
            channelId: "channel-1",
            messageId: "msg-1",
          },
          deliveryTarget: {
            platform: "discord",
            payload: {
              channelId: "channel-1",
              userId: "user-1",
            },
          },
        }),
      );
    });

    await adapter.stop();
  });

  test("guild messages require bot mention by default and strip the mention from content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        jsonBody: {
          url: "wss://gateway.discord.gg",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const handler = vi.fn();
    const adapter = createAdapter();
    const startPromise = adapter.start(handler);

    const socket = await waitForSocket();
    socket.emitMessage({
      op: 10,
      d: {
        heartbeat_interval: 30_000,
      },
    });
    socket.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: {
        user: {
          id: "bot-1",
        },
      },
    });
    await startPromise;

    socket.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: {
        id: "msg-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        content: "hello there",
        mentions: [],
        author: {
          id: "user-1",
          username: "Alice",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();

    socket.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: {
        id: "msg-2",
        channel_id: "channel-1",
        guild_id: "guild-1",
        content: "<@bot-1> summarize this",
        mentions: [{ id: "bot-1" }],
        author: {
          id: "user-1",
          username: "Alice",
        },
      },
    });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "summarize this",
        }),
      );
    });

    await adapter.stop();
  });

  test("attachment-only discord messages are forwarded with attachment metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        jsonBody: {
          url: "wss://gateway.discord.gg",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const handler = vi.fn();
    const adapter = createAdapter();
    const startPromise = adapter.start(handler);

    const socket = await waitForSocket();
    socket.emitMessage({
      op: 10,
      d: {
        heartbeat_interval: 30_000,
      },
    });
    socket.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: {
        user: {
          id: "bot-1",
        },
      },
    });
    await startPromise;

    socket.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: {
        id: "msg-1",
        channel_id: "dm-1",
        content: "",
        author: {
          id: "user-1",
          username: "Alice",
        },
        attachments: [
          {
            filename: "diagram.png",
            content_type: "image/png",
            url: "https://cdn.discordapp.com/attachments/diagram.png",
            size: 2048,
            width: 1200,
            height: 800,
          },
        ],
      },
    });

    await waitForAssertion(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("[Discord image]"),
        }),
      );
    });
    expect(String(handler.mock.calls[0]?.[0]?.content)).toContain("url: https://cdn.discordapp.com/attachments/diagram.png");

    await adapter.stop();
  });

  test("send splits long messages into multiple discord channel posts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse({ jsonBody: { id: "1" } }))
      .mockResolvedValueOnce(createFetchResponse({ jsonBody: { id: "2" } }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    await adapter.send(
      {
        platform: "discord",
        payload: {
          channelId: "channel-1",
        },
      },
      `${"a".repeat(1995)} ${"b".repeat(120)}`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
          "Content-Type": "application/json",
        }),
      }),
    );

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(String(firstBody.content).length).toBeLessThanOrEqual(2000);
    expect(String(secondBody.content).length).toBeLessThanOrEqual(2000);
    expect(firstBody.allowed_mentions).toEqual({
      parse: [],
      replied_user: false,
    });
  });

  test("beginResponse adds a discord reaction and endResponse removes it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse({ status: 204 }))
      .mockResolvedValueOnce(createFetchResponse({ status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    const replyContext = {
      channelId: "channel-1",
      messageId: "message-1",
    };

    await adapter.beginResponse(replyContext);
    await adapter.endResponse(replyContext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-1/messages/message-1/reactions/%F0%9F%91%80/@me",
      expect.objectContaining({
        method: "PUT",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-1/messages/message-1/reactions/%F0%9F%91%80/@me",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  test("reply posts a discord message reference without adding a reaction", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createFetchResponse({
        jsonBody: {
          id: "reply-1",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    await adapter.reply(
      {
        channelId: "channel-1",
        messageId: "message-1",
      },
      "hello",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      content: "hello",
      allowed_mentions: {
        parse: [],
        replied_user: false,
      },
      message_reference: {
        message_id: "message-1",
        fail_if_not_exists: false,
      },
    });
  });

  test("nested beginResponse/endResponse only add and remove one discord reaction", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse({ status: 204 }))
      .mockResolvedValueOnce(createFetchResponse({ status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    const replyContext = {
      channelId: "channel-1",
      messageId: "message-1",
    };

    await adapter.beginResponse(replyContext);
    await adapter.beginResponse(replyContext);
    await adapter.endResponse(replyContext);
    await adapter.endResponse(replyContext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("endResponse skips removing the reaction when beginResponse could not add it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createFetchResponse({
        ok: false,
        status: 403,
        bodyText: "missing permissions",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    const replyContext = {
      channelId: "channel-1",
      messageId: "message-1",
    };

    await adapter.beginResponse(replyContext);
    await adapter.endResponse(replyContext);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
