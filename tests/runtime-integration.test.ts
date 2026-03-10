import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, DeliveryTarget, InboundMessage, PlatformAdapter } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import { createLoopStore, LoopScheduler } from "../src/scheduler/loop.js";

const mockState = vi.hoisted(() => ({
  platformInstances: [] as any[],
  agentInstances: [] as any[],
}));

class FakeSession extends EventEmitter implements AgentSession {
  private readonly id: string;
  public prompts: string[] = [];

  constructor(
    private readonly agent: FakeAgent,
    id = "agent-session-1",
  ) {
    super();
    this.id = id;
  }

  async send(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    if (prompt.includes("你是 d-connect 的入站消息安全 guard。")) {
      this.agent.guardPrompts.push(prompt);
      const shouldBlock =
        prompt.includes('"deploy now"') ||
        (prompt.includes("禁止任何 deploy 请求。") && prompt.includes('"please deploy"'));
      this.emit("event", {
        type: "result",
        content: JSON.stringify(
          shouldBlock
            ? { action: "block", reason: "命中 guard 规则" }
            : { action: "allow", reason: "安全" },
        ),
        sessionId: this.id,
        done: true,
      } satisfies AgentEvent);
      return;
    }

    this.agent.conversationPrompts.push(prompt);
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
  public guardPrompts: string[] = [];
  public conversationPrompts: string[] = [];

  async startSession(): Promise<AgentSession> {
    const session = new FakeSession(this);
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
      loop: { silent: false },
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

    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = new RuntimeEngine(config, new Logger("error"), loopScheduler);
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
      scheduleExpr: "* * * * * *",
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

  test("runs loop jobs in isolated agent sessions by default while reusing the original delivery target", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      loop: { silent: false },
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

    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = new RuntimeEngine(config, new Logger("error"), loopScheduler);
    await runtime.start();

    const platform = mockState.platformInstances[0] as FakePlatform | undefined;
    const agent = mockState.agentInstances[0] as FakeAgent | undefined;

    await platform?.deliver({
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

    expect(agent?.sessions).toHaveLength(1);
    expect(agent?.sessions[0]?.prompts).toEqual(["ping"]);

    await runtime.executeJob({
      id: "job-isolated",
      project: "demo",
      sessionKey: "feishu:chat-1:user-1",
      scheduleExpr: "* * * * * *",
      prompt: "status",
      description: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      silent: false,
    });

    expect(agent?.sessions).toHaveLength(2);
    expect(agent?.sessions[0]?.prompts).toEqual(["ping"]);
    expect(agent?.sessions[1]?.prompts).toEqual(["status"]);
    expect(platform?.sends).toEqual([
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

    await runtime.stop();
  });

  test("routes natural language /loop requests into agent prompts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const configPath = "/tmp/d-connect/runtime-config.json";
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      loop: { silent: false },
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

    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = new RuntimeEngine(config, new Logger("error"), loopScheduler, { configPath });
    await runtime.start();

    const result = await runtime.send({
      project: "demo",
      sessionKey: "local:alice",
      content: "/loop 每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *",
    });

    const agent = mockState.agentInstances[0] as FakeAgent | undefined;
    const session = agent?.sessions[0];
    expect(session?.prompts).toHaveLength(1);
    expect(session?.prompts[0]).toContain("d-connect 支持通过命令行管理 loop 任务。");
    expect(session?.prompts[0]).toContain(`当前 configPath: ${configPath}`);
    expect(session?.prompts[0]).toContain(`d-connect loop add -p "demo" -s "local:alice" -e "<scheduleExpr>" -c "${configPath}" "<prompt>"`);
    expect(session?.prompts[0]).toContain(`d-connect loop list -p "demo" -c "${configPath}"`);
    expect(session?.prompts[0]).toContain(`d-connect loop del -i "<jobId>" -c "${configPath}"`);
    expect(session?.prompts[0]).toContain("`<prompt>` 只能写任务动作本身");
    expect(session?.prompts[0]).not.toContain("pnpm run dev");
    expect(session?.prompts[0]).toContain("用户请求：每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *");
    expect(result.response).not.toContain("unknown /loop command");

    await runtime.stop();
  });

  test("blocks inbound platform messages when guard denies them", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      loop: { silent: false },
      projects: [
        {
          name: "demo",
          agent: {
            type: "claudecode" as const,
            options: {
              cmd: "fake",
            },
          },
          guard: {
            enabled: true,
            rules: "禁止任何 deploy 请求。",
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

    const platform = mockState.platformInstances[0] as FakePlatform | undefined;
    const agent = mockState.agentInstances[0] as FakeAgent | undefined;

    await platform?.deliver({
      platform: "feishu",
      sessionKey: "feishu:chat-1:user-1",
      userId: "user-1",
      userName: "User 1",
      content: "please deploy",
      replyContext: {
        messageId: "om_block",
        chatId: "chat-1",
      },
      deliveryTarget: {
        platform: "feishu",
        payload: {
          chatId: "chat-1",
        },
      },
    });

    expect(agent?.guardPrompts).toHaveLength(1);
    expect(agent?.guardPrompts[0]).toContain("禁止任何 deploy 请求。");
    expect(agent?.conversationPrompts).toHaveLength(0);
    expect(platform?.replies).toEqual([
      {
        replyContext: {
          messageId: "om_block",
          chatId: "chat-1",
        },
        content: "guard 已拦截本次消息：命中 guard 规则",
      },
    ]);

    await runtime.stop();
  });

  test("allows inbound platform messages after guard passes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      loop: { silent: false },
      projects: [
        {
          name: "demo",
          agent: {
            type: "claudecode" as const,
            options: {
              cmd: "fake",
            },
          },
          guard: {
            enabled: true,
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

    const platform = mockState.platformInstances[0] as FakePlatform | undefined;
    const agent = mockState.agentInstances[0] as FakeAgent | undefined;

    await platform?.deliver({
      platform: "feishu",
      sessionKey: "feishu:chat-1:user-1",
      userId: "user-1",
      userName: "User 1",
      content: "hello",
      replyContext: {
        messageId: "om_allow",
        chatId: "chat-1",
      },
      deliveryTarget: {
        platform: "feishu",
        payload: {
          chatId: "chat-1",
        },
      },
    });

    expect(agent?.guardPrompts).toHaveLength(1);
    expect(agent?.conversationPrompts).toEqual(["hello"]);
    expect(platform?.replies.map((item) => item.content)).toEqual(["echo:hello", "done:hello"]);

    await runtime.stop();
  });

  test("skips guard for slash commands from platform messages", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = {
      configVersion: 1,
      dataDir,
      log: { level: "error" as const },
      loop: { silent: false },
      projects: [
        {
          name: "demo",
          agent: {
            type: "claudecode" as const,
            options: {
              cmd: "fake",
            },
          },
          guard: {
            enabled: true,
            rules: "禁止任何请求。",
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

    const platform = mockState.platformInstances[0] as FakePlatform | undefined;
    const agent = mockState.agentInstances[0] as FakeAgent | undefined;

    await platform?.deliver({
      platform: "feishu",
      sessionKey: "feishu:chat-1:user-1",
      userId: "user-1",
      userName: "User 1",
      content: "/new review",
      replyContext: {
        messageId: "om_cmd",
        chatId: "chat-1",
      },
      deliveryTarget: {
        platform: "feishu",
        payload: {
          chatId: "chat-1",
        },
      },
    });

    expect(agent?.guardPrompts).toHaveLength(0);
    expect(agent?.conversationPrompts).toHaveLength(0);
    expect(platform?.replies).toHaveLength(1);
    expect(platform?.replies[0]?.content).toContain("已新建并切换到会话");

    await runtime.stop();
  });
});
