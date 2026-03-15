import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ResolvedAppConfig, ResolvedGuardConfig } from "../src/config/normalize.js";
import { Logger } from "../src/logging.js";
import { createLoopStore, LoopScheduler } from "../src/scheduler/loop.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  DeliveryTarget,
  InboundMessage,
  PermissionResult,
  PlatformAdapter,
  PlatformResponseResult,
} from "../src/runtime/types.js";
import { RuntimeEngine } from "../src/runtime/engine.js";
import type { ProjectRegistryOptions } from "../src/services/project-registry.js";

const TEST_PLATFORM_NAME = "test-platform";
const CHAT_ID = "chat-1";
const CHAT_SESSION_KEY = `${TEST_PLATFORM_NAME}:${CHAT_ID}:user-1`;
const CHAT_TARGET: DeliveryTarget = {
  platform: TEST_PLATFORM_NAME,
  payload: {
    chatId: CHAT_ID,
  },
};

function createResolvedConfig(dataDir: string, guard: ResolvedGuardConfig = { enabled: false }): ResolvedAppConfig {
  return {
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
        guard,
        platforms: [],
      },
    ],
  };
}

function createInboundPlatformMessage(content: string, messageId: string): InboundMessage {
  return {
    platform: TEST_PLATFORM_NAME,
    sessionKey: CHAT_SESSION_KEY,
    userId: "user-1",
    userName: "User 1",
    content,
    replyContext: {
      messageId,
      chatId: CHAT_ID,
    },
    deliveryTarget: CHAT_TARGET,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

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
        prompt.includes("\"deploy now\"") ||
        (prompt.includes("禁止任何 deploy 请求。") && prompt.includes("\"please deploy\""));
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

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
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

  async startSession(_sessionId?: string): Promise<AgentSession> {
    const session = new FakeSession(this);
    this.sessions.push(session);
    return session;
  }

  async stop(): Promise<void> {
    // noop
  }
}

class FakeTeamSession extends EventEmitter implements AgentSession {
  public prompts: string[] = [];

  constructor(
    private readonly homeDir: string,
    private readonly id = "lead-session-1",
  ) {
    super();
  }

  private async writeTeamFiles(): Promise<void> {
    await writeJson(join(this.homeDir, ".claude", "teams", "alpha-team", "config.json"), {
      name: "alpha-team",
      leadAgentId: "lead-1",
      leadSessionId: this.id,
      members: [
        {
          agentId: "agent-alice",
          name: "Alice",
          agentType: "research",
          model: "claude-sonnet-4-5",
          color: "blue",
        },
      ],
    });
    await writeJson(join(this.homeDir, ".claude", "teams", "alpha-team", "inboxes", "team-lead.json"), [
      {
        from: "Alice",
        text: "Pinned the issue to retry path.",
        summary: "Retry path isolated",
        timestamp: "2026-03-15T10:00:00.000Z",
        color: "blue",
      },
    ]);
    await writeJson(join(this.homeDir, ".claude", "tasks", "alpha-team", "1.json"), {
      id: "1",
      subject: "Alice",
      description: "retry path investigation",
      status: "completed",
    });
  }

  async send(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    await this.writeTeamFiles();

    this.emit("event", {
      type: "team_event",
      sessionId: this.id,
      team: {
        kind: "team_created",
        teamName: "alpha-team",
        leadAgentId: "lead-1",
      },
    } satisfies AgentEvent);
    this.emit("event", {
      type: "team_event",
      sessionId: this.id,
      team: {
        kind: "member_spawned",
        teamName: "alpha-team",
        memberName: "Alice",
        memberId: "agent-alice",
        agentType: "research",
        model: "claude-sonnet-4-5",
      },
    } satisfies AgentEvent);
    this.emit("event", {
      type: "team_event",
      sessionId: this.id,
      team: {
        kind: "task_started",
        teamName: "alpha-team",
        memberName: "Alice",
        taskId: "1",
        taskStatus: "in_progress",
        taskDescription: "Alice: investigate failing build",
      },
    } satisfies AgentEvent);
    this.emit("event", {
      type: "team_message",
      sessionId: this.id,
      content: "Pinned the issue to retry path.",
      team: {
        kind: "message",
        teamName: "alpha-team",
        memberName: "Alice",
        summary: "Retry path isolated",
      },
    } satisfies AgentEvent);
    this.emit("event", {
      type: "team_event",
      sessionId: this.id,
      team: {
        kind: "task_completed",
        teamName: "alpha-team",
        memberName: "Alice",
        taskId: "1",
        taskStatus: "completed",
        taskSubject: "retry path investigation",
      },
    } satisfies AgentEvent);
    this.emit("event", {
      type: "result",
      sessionId: this.id,
      content: `lead summary:${prompt}`,
      done: true,
    } satisfies AgentEvent);
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
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

class FakeTeamAgent implements AgentAdapter {
  readonly name = "fake-team-agent";
  public sessions: FakeTeamSession[] = [];

  constructor(private readonly homeDir: string) {}

  async startSession(): Promise<AgentSession> {
    const session = new FakeTeamSession(this.homeDir);
    this.sessions.push(session);
    return session;
  }

  async stop(): Promise<void> {
    // noop
  }
}

class FakePlatform implements PlatformAdapter {
  readonly name = TEST_PLATFORM_NAME;
  public handler?: (message: InboundMessage) => Promise<void> | void;
  public replies: Array<{ replyContext: unknown; content: string }> = [];
  public sends: Array<{ target: DeliveryTarget; content: string }> = [];
  public lifecycleEvents: string[] = [];

  async start(handler: (message: InboundMessage) => Promise<void> | void): Promise<void> {
    this.handler = handler;
  }

  async beginResponse(replyContext: unknown): Promise<void> {
    this.lifecycleEvents.push(`begin:${String((replyContext as { messageId?: string }).messageId ?? "")}`);
  }

  async endResponse(replyContext: unknown, result: PlatformResponseResult): Promise<void> {
    this.lifecycleEvents.push(`end:${String((replyContext as { messageId?: string }).messageId ?? "")}:${result.status}`);
  }

  async reply(replyContext: unknown, content: string): Promise<void> {
    this.lifecycleEvents.push(`reply:${content}`);
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

interface RuntimeFixtureState {
  platforms: FakePlatform[];
  agents: FakeAgent[];
}

function createRuntimeFixtureState(): RuntimeFixtureState {
  return {
    platforms: [],
    agents: [],
  };
}

function createProjectRegistryOptions(state: RuntimeFixtureState): ProjectRegistryOptions {
  return {
    createAgentAdapter: () => {
      const agent = new FakeAgent();
      state.agents.push(agent);
      return agent;
    },
    createPlatformAdapters: () => {
      const platform = new FakePlatform();
      state.platforms.push(platform);
      return [platform];
    },
  };
}

function createRuntimeEngine(
  config: ResolvedAppConfig,
  state: RuntimeFixtureState,
  loopScheduler?: LoopScheduler,
  configPath?: string,
): RuntimeEngine {
  return new RuntimeEngine(config, new Logger("error"), loopScheduler, {
    configPath,
    projectRegistry: createProjectRegistryOptions(state),
  });
}

describe("runtime integration", () => {
  test("persists delivery target from inbound platform messages and reuses it after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = createResolvedConfig(dataDir);
    const state = createRuntimeFixtureState();
    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = createRuntimeEngine(config, state, loopScheduler);
    await runtime.start();

    const platform1 = state.platforms[0];
    expect(platform1).toBeTruthy();

    await platform1?.deliver(createInboundPlatformMessage("ping", "om_1"));

    expect(platform1?.replies.map((item) => item.content)).toContain("echo:ping");
    await runtime.stop();

    const restarted = createRuntimeEngine(config, state);
    await restarted.start();

    const platform2 = state.platforms[1];
    expect(platform2).toBeTruthy();

    await restarted.executeJob({
      id: "job-1",
      project: "demo",
      sessionKey: CHAT_SESSION_KEY,
      scheduleExpr: "* * * * * *",
      prompt: "status",
      description: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      silent: false,
    });

    expect(platform2?.sends).toEqual([
      {
        target: CHAT_TARGET,
        content: "echo:status",
      },
      {
        target: CHAT_TARGET,
        content: "done:status",
      },
    ]);

    await restarted.stop();
  });

  test("runs loop jobs in isolated agent sessions by default while reusing the original delivery target", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = createResolvedConfig(dataDir);
    const state = createRuntimeFixtureState();
    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = createRuntimeEngine(config, state, loopScheduler);
    await runtime.start();

    const platform = state.platforms[0];
    const agent = state.agents[0];

    await platform?.deliver(createInboundPlatformMessage("ping", "om_1"));

    expect(agent?.sessions).toHaveLength(1);
    expect(agent?.sessions[0]?.prompts).toEqual(["ping"]);

    await runtime.executeJob({
      id: "job-isolated",
      project: "demo",
      sessionKey: CHAT_SESSION_KEY,
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
        target: CHAT_TARGET,
        content: "echo:status",
      },
      {
        target: CHAT_TARGET,
        content: "done:status",
      },
    ]);

    await runtime.stop();
  });

  test("routes natural language /loop requests into agent prompts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const configPath = "/tmp/d-connect/runtime-config.json";
    const config = createResolvedConfig(dataDir);
    const state = createRuntimeFixtureState();
    const loopStore = await createLoopStore(dataDir);
    const loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    const runtime = createRuntimeEngine(config, state, loopScheduler, configPath);
    await runtime.start();

    const result = await runtime.send({
      project: "demo",
      sessionKey: "local:alice",
      content: "/loop 每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *",
    });

    const agent = state.agents[0];
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

  test("wraps inbound replies with platform response lifecycle hooks", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = createResolvedConfig(dataDir);
    const state = createRuntimeFixtureState();
    const runtime = createRuntimeEngine(config, state);
    await runtime.start();

    const platform = state.platforms[0];
    await platform?.deliver(createInboundPlatformMessage("ping", "om_1"));

    expect(platform?.lifecycleEvents).toEqual([
      "begin:om_1",
      "reply:echo:ping",
      "reply:done:ping",
      "end:om_1:completed",
    ]);

    await runtime.stop();
  });

  test("streams structured team timeline and serves /team tasks from local claude snapshots", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-home-"));
    const config = createResolvedConfig(dataDir);
    config.projects[0]!.agent.options.env = {
      HOME: homeDir,
    };

    const state = createRuntimeFixtureState();
    const runtime = new RuntimeEngine(config, new Logger("error"), undefined, {
      projectRegistry: {
        createAgentAdapter: () => new FakeTeamAgent(homeDir),
        createPlatformAdapters: () => {
          const platform = new FakePlatform();
          state.platforms.push(platform);
          return [platform];
        },
      },
    });
    await runtime.start();

    const platform = state.platforms[0];
    await platform?.deliver(createInboundPlatformMessage("start team", "om_team"));

    expect(platform?.replies.map((item) => item.content)).toEqual([
      "🤝 Team alpha-team 已创建",
      "👤 Alice · research/claude-sonnet-4-5 已加入",
      "📌 Alice 开始：Alice: investigate failing build",
      "👤 Alice\n摘要：Retry path isolated\nPinned the issue to retry path.",
      "✅ Alice 完成：retry path investigation",
      "lead summary:start team",
    ]);

    const tasks = await runtime.send({
      project: "demo",
      sessionKey: CHAT_SESSION_KEY,
      content: "/team tasks",
    });
    expect(tasks.response).toContain("Team alpha-team 任务：");
    expect(tasks.response).toContain("1\t已完成\tAlice\tAlice");

    await runtime.stop();
  });

  test("blocks inbound platform messages when guard denies them", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = createResolvedConfig(dataDir, {
      enabled: true,
      rules: "禁止任何 deploy 请求。",
    });
    const state = createRuntimeFixtureState();
    const runtime = createRuntimeEngine(config, state);
    await runtime.start();

    const platform = state.platforms[0];
    const agent = state.agents[0];

    await platform?.deliver(createInboundPlatformMessage("please deploy", "om_block"));

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
    const config = createResolvedConfig(dataDir, {
      enabled: true,
    });
    const state = createRuntimeFixtureState();
    const runtime = createRuntimeEngine(config, state);
    await runtime.start();

    const platform = state.platforms[0];
    const agent = state.agents[0];

    await platform?.deliver(createInboundPlatformMessage("hello", "om_allow"));

    expect(agent?.guardPrompts).toHaveLength(1);
    expect(agent?.conversationPrompts).toEqual(["hello"]);
    expect(platform?.replies.map((item) => item.content)).toEqual(["echo:hello", "done:hello"]);

    await runtime.stop();
  });

  test("skips guard for slash commands from platform messages", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-runtime-"));
    const config = createResolvedConfig(dataDir, {
      enabled: true,
      rules: "禁止任何请求。",
    });
    const state = createRuntimeFixtureState();
    const runtime = createRuntimeEngine(config, state);
    await runtime.start();

    const platform = state.platforms[0];
    const agent = state.agents[0];

    await platform?.deliver(createInboundPlatformMessage("/new review", "om_cmd"));

    expect(agent?.guardPrompts).toHaveLength(0);
    expect(agent?.conversationPrompts).toHaveLength(0);
    expect(platform?.replies).toHaveLength(1);
    expect(platform?.replies[0]?.content).toContain("已新建并切换到会话");

    await runtime.stop();
  });
});
