import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, DeliveryTarget, InboundMessage, PlatformAdapter } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";

const mockState = vi.hoisted(() => ({
  platformInstances: [] as any[],
  agentInstances: [] as any[],
}));

class FakeSession extends EventEmitter implements AgentSession {
  private readonly id: string;

  constructor(id = "agent-session-1") {
    super();
    this.id = id;
  }

  async send(prompt: string): Promise<void> {
    this.emit("event", {
      type: "text",
      content: `echo:${prompt}`,
      sessionId: this.id,
    } satisfies AgentEvent);
    this.emit("event", {
      type: "result",
      content: `done:${prompt}`,
      sessionId: this.id,
      done: true,
    } satisfies AgentEvent);
  }

  async respondPermission(): Promise<void> {
    // noop
  }

  currentSessionId(): string {
    return this.id;
  }

  isAlive(): boolean {
    return true;
  }

  async close(): Promise<void> {
    // noop
  }
}

class FakeAgent implements AgentAdapter {
  readonly name = "fake-agent";
  public sessions: FakeSession[] = [];

  async startSession(): Promise<AgentSession> {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }

  async stop(): Promise<void> {
    // noop
  }
}

class FakePlatform implements PlatformAdapter {
  readonly name = "feishu";
  public handler?: (message: InboundMessage) => Promise<void> | void;
  public replies: Array<{ replyContext: unknown; content: string }> = [];
  public sends: Array<{ target: DeliveryTarget; content: string }> = [];

  async start(handler: (message: InboundMessage) => Promise<void> | void): Promise<void> {
    this.handler = handler;
  }

  async reply(replyContext: unknown, content: string): Promise<void> {
    this.replies.push({ replyContext, content });
  }

  async send(target: DeliveryTarget, content: string): Promise<void> {
    this.sends.push({ target, content });
  }

  async stop(): Promise<void> {
    // noop
  }

  async deliver(message: InboundMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("handler missing");
    }
    await this.handler(message);
  }
}

vi.mock("../src/adapters/agent/index.js", () => ({
  createAgentAdapter: () => {
    const agent = new FakeAgent();
    mockState.agentInstances.push(agent);
    return agent;
  },
}));

vi.mock("../src/adapters/platform/index.js", () => ({
  createPlatformAdapters: () => {
    const platform = new FakePlatform();
    mockState.platformInstances.push(platform);
    return [platform];
  },
}));

import { RuntimeEngine } from "../src/runtime/engine.js";

describe("runtime integration", () => {
  beforeEach(() => {
    mockState.platformInstances.length = 0;
    mockState.agentInstances.length = 0;
  });

  test("persists delivery target from inbound platform messages and reuses it after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      cron: { silent: false },
      projects: [
        {
          name: "demo",
          agent: {
            type: "claudecode" as const,
            options: {
              cmd: "fake",
            },
          },
          platforms: [
            {
              type: "feishu" as const,
              options: {
                appId: "app-id",
                appSecret: "app-secret",
                allowFrom: "*",
                groupReplyAll: false,
                reactionEmoji: "none",
              },
            },
          ],
        },
      ],
    };

    const runtime = new RuntimeEngine(config, new Logger("error"));
    await runtime.start();

    const platform1 = mockState.platformInstances[0];
    expect(platform1).toBeTruthy();

    await platform1?.deliver({
      platform: "feishu",
      sessionKey: "feishu:chat-1:user-1",
      userId: "user-1",
      userName: "User 1",
      content: "ping",
      replyContext: {
        messageId: "om_1",
        chatId: "chat-1",
      },
      deliveryTarget: {
        platform: "feishu",
        payload: {
          chatId: "chat-1",
        },
      },
    });

    expect(platform1?.replies.map((item) => item.content)).toContain("echo:ping");
    await runtime.stop();

    const restarted = new RuntimeEngine(config, new Logger("error"));
    await restarted.start();

    const platform2 = mockState.platformInstances[1];
    expect(platform2).toBeTruthy();

    await restarted.executeJob({
      id: "job-1",
      project: "demo",
      sessionKey: "feishu:chat-1:user-1",
      cronExpr: "* * * * * *",
      prompt: "status",
      description: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      silent: false,
    });

    expect(platform2?.sends).toEqual([
      {
        target: {
          platform: "feishu",
          payload: {
            chatId: "chat-1",
          },
        },
        content: "echo:status",
      },
      {
        target: {
          platform: "feishu",
          payload: {
            chatId: "chat-1",
          },
        },
        content: "done:status",
      },
    ]);

    await restarted.stop();
  });
});
