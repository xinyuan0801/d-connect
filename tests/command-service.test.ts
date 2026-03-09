import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { Logger } from "../src/logging.js";
import { createSessionStore } from "../src/runtime/session-store.js";
import { createLoopStore, LoopScheduler } from "../src/scheduler/loop.js";
import { ConversationService } from "../src/services/conversation-service.js";
import { CommandService, type CommandResult } from "../src/services/command-service.js";
import type { AgentAdapter, AgentSession, PermissionResult } from "../src/runtime/types.js";
import type { ProjectRuntime } from "../src/services/project-registry.js";

class FakeAgent implements AgentAdapter {
  readonly name = "fake";

  async startSession(): Promise<AgentSession> {
    throw new Error("not used");
  }

  async stop(): Promise<void> {
    // noop
  }
}

class MockRuntimeSession extends EventEmitter implements AgentSession {
  private closed = false;
  public closeCalls = 0;

  async send(_prompt: string): Promise<void> {
    throw new Error("not used");
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // noop
  }

  currentSessionId(): string {
    return "mock-agent-session";
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
    this.emit("close");
  }
}

class MockSlowRuntimeSession extends EventEmitter implements AgentSession {
  private closed = false;
  public closeCalls = 0;

  async send(_prompt: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.emit("event", {
      type: "result",
      content: "slow-result",
      sessionId: "slow-session-id",
      done: true,
    });
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // noop
  }

  currentSessionId(): string {
    return "slow-session-id";
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
    this.emit("close");
  }
}

async function createHarness(configPath?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "d-connect-command-"));
  const sessions = await createSessionStore(dataDir);
  const conversation = new ConversationService(sessions, new Logger("error"));
  const loopStore = await createLoopStore(dataDir);
  const loop = new LoopScheduler(loopStore, new Logger("error"));
  const service = new CommandService(conversation, loop, configPath);
  const runtime: ProjectRuntime = {
    config: {
      name: "demo",
      agent: {
        type: "claudecode",
        options: {},
      },
      guard: {
        enabled: false,
      },
      platforms: [],
    },
    agent: new FakeAgent(),
    platforms: [],
    platformMap: new Map(),
    sessions: new Map(),
  };

  return {
    service,
    conversation,
    loop,
    runtime,
  };
}

function expectHandled(result: CommandResult): string {
  expect(result.kind).toBe("handled");
  return result.kind === "handled" ? result.response : "";
}

describe("command service", () => {
  test("handles session lifecycle without exposing mode commands", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const created = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/new review",
    }));
    expect(created).toMatch(/created session/);

    const list = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/list",
    }));
    expect(list).toContain("review");

    const switchTarget = list
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("review"))
      ?.split(/\s+/)[1];
    expect(switchTarget).toBeTruthy();

    const switched = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: `/switch ${switchTarget}`,
    }));
    expect(switched).toContain("active session");

    expect(
      expectHandled(await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/help",
      })),
    ).not.toContain("/mode");
    expect(
      expectHandled(await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/help",
      })),
    ).toContain("/stop");

    expect(
      expectHandled(await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/mode",
      })),
    ).toBe("unknown command: mode. use /help");
  });

  test("handles /stop by closing runtime session and clearing agent session id", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.agentSessionId = "resume-123";

    const runtimeSession = new MockRuntimeSession();
    runtime.sessions.set(session.id, runtimeSession);

    const stopped = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/stop",
    }));
    expect(stopped).toBe(`stopped session ${session.id}`);
    expect(runtimeSession.closeCalls).toBe(1);
    expect(runtime.sessions.has(session.id)).toBe(false);
    expect(session.agentSessionId).toBe("");

    const stoppedAgain = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/stop",
    }));
    expect(stoppedAgain).toBe(`session already stopped: ${session.id}`);
  });

  test("keeps agent session id cleared when /stop races with an in-flight turn", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const runtimeSession = new MockSlowRuntimeSession();
    runtime.sessions.set(session.id, runtimeSession);

    const turn = conversation.runTurn(runtime, "demo", "local:alice", session, "hello");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const stopped = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/stop",
    }));
    expect(stopped).toBe(`stopped session ${session.id}`);

    await expect(turn).resolves.toEqual({
      response: "slow-result",
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "result",
          content: "slow-result",
          sessionId: "slow-session-id",
        }),
      ]),
    });
    expect(runtimeSession.closeCalls).toBe(1);
    expect(runtime.sessions.has(session.id)).toBe(false);
    expect(session.agentSessionId).toBe("");
  });

  test("handles loop add/list/del through command registry", async () => {
    const { service, conversation, runtime, loop } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const created = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop add */10 * * * * * check status",
    }));
    expect(created).toMatch(/loop created:/);

    const id = created.split(": ")[1];
    expect(id).toBeTruthy();

    const listed = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop list",
    }));
    expect(listed).toContain("check status");

    const removed = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: `/loop del ${id}`,
    }));
    expect(removed).toBe(`loop removed: ${id}`);
    expect(loop.list("demo")).toHaveLength(0);
  });

  test("forwards natural language loop requests to agent with cli instructions", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const result = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop 每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *",
    });

    expect(result).toEqual({
      kind: "forward_to_agent",
      prompt: expect.stringContaining("d-connect 支持通过命令行管理 loop 任务。"),
    });
    expect(result.kind).toBe("forward_to_agent");
    if (result.kind === "forward_to_agent") {
      expect(result.prompt).toContain('d-connect loop add -p "demo" -s "local:alice" -e "<scheduleExpr>" "<prompt>"');
      expect(result.prompt).toContain('d-connect loop list -p "demo"');
      expect(result.prompt).toContain('d-connect loop del -i "<jobId>" -c <configPath>');
      expect(result.prompt).toContain("`<prompt>` 只能写任务动作本身");
      expect(result.prompt).toContain('示例：用户请求“每天晚上8点22介绍一下自己” -> d-connect loop add -p "demo" -s "local:alice" -e "22 20 * * *" "介绍一下自己"');
      expect(result.prompt).not.toContain("pnpm run dev");
      expect(result.prompt).toContain("用户请求：每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *");
    }
  });

  test("injects explicit config path into natural language loop instructions", async () => {
    const configPath = "/tmp/d-connect/config.qoder.json";
    const { service, conversation, runtime } = await createHarness(configPath);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const result = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop 每天晚上8点29介绍一下自己",
    });

    expect(result.kind).toBe("forward_to_agent");
    if (result.kind === "forward_to_agent") {
      expect(result.prompt).toContain(`当前 configPath: ${configPath}`);
      expect(result.prompt).toContain(`d-connect loop add -p "demo" -s "local:alice" -e "<scheduleExpr>" -c "${configPath}" "<prompt>"`);
      expect(result.prompt).toContain(`d-connect loop list -p "demo" -c "${configPath}"`);
      expect(result.prompt).toContain(`d-connect loop del -i "<jobId>" -c "${configPath}"`);
      expect(result.prompt).toContain(`固定为 "${configPath}"`);
    }
  });

  test("normalizes relative config path into absolute path in loop instructions", async () => {
    const relativePath = "./config.qodercli-dingtalk.local.json";
    const absolutePath = resolve(relativePath);
    const { service, conversation, runtime } = await createHarness(relativePath);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const result = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop 每天晚上8点29介绍一下自己",
    });

    expect(result.kind).toBe("forward_to_agent");
    if (result.kind === "forward_to_agent") {
      expect(result.prompt).toContain(`当前 configPath: ${absolutePath}`);
      expect(result.prompt).toContain(`d-connect loop add -p "demo" -s "local:alice" -e "<scheduleExpr>" -c "${absolutePath}" "<prompt>"`);
      expect(result.prompt).toContain(`d-connect loop list -p "demo" -c "${absolutePath}"`);
      expect(result.prompt).toContain(`d-connect loop del -i "<jobId>" -c "${absolutePath}"`);
    }
  });
});
