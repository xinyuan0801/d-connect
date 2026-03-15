import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function createClaudeTeamFiles(homeDir: string): Promise<void> {
  await writeJson(join(homeDir, ".claude", "teams", "alpha-team", "config.json"), {
    name: "alpha-team",
    leadAgentId: "lead-1",
    leadSessionId: "lead-session-1",
    members: [
      {
        agentId: "agent-alice",
        name: "Alice",
        agentType: "research",
        model: "claude-sonnet-4-5",
        color: "blue",
      },
      {
        agentId: "agent-bob",
        name: "Bob",
        agentType: "implementer",
        model: "claude-opus-4-1",
        color: "green",
        planModeRequired: true,
      },
    ],
  });
  await writeJson(join(homeDir, ".claude", "teams", "alpha-team", "inboxes", "team-lead.json"), [
    {
      from: "Alice",
      text: "Root cause isolated.",
      summary: "Root cause isolated",
      timestamp: "2026-03-15T10:00:00.000Z",
      color: "blue",
    },
  ]);
  await writeJson(join(homeDir, ".claude", "tasks", "alpha-team", "1.json"), {
    id: "1",
    subject: "Alice",
    description: "Investigate failing build",
    status: "in_progress",
  });
  await writeJson(join(homeDir, ".claude", "tasks", "alpha-team", "2.json"), {
    id: "2",
    subject: "Bob",
    description: "Patch retry path",
    status: "completed",
  });
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
    expect(created).toContain("已新建并切换到会话");
    expect(created).toContain("（review）");

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
    expect(switched).toContain("已切换到会话");

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
    ).toBe("不认识命令：mode。先试试 /help，别让斜杠白挨一下。");
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
    expect(stopped).toBe(`已停止会话 ${session.id}。风扇声应该会礼貌一点。`);
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
    expect(stoppedAgain).toBe(`会话 ${session.id} 早就停了。鞭尸对进程管理帮助不大。`);
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
    expect(stopped).toBe(`已停止会话 ${session.id}。风扇声应该会礼貌一点。`);

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
    expect(created).toContain("已创建 loop：");

    const id = created.match(/^已创建 loop：([^。]+)。/)?.[1];
    expect(id).toBeTruthy();

    const listed = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/loop list",
    }));
    expect(listed).toContain("check status");
    expect(loop.list("demo")[0]?.contextMode).toBe("isolated");

    const removed = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: `/loop del ${id}`,
    }));
    expect(removed).toBe(`已删除 loop：${id}。又一个准时添堵的家伙退场了。`);
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
      expect(result.prompt).toContain('d-connect loop del -i "<jobId>"');
      expect(result.prompt).not.toContain("<configPath>");
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

  test("returns handled output when loop feature is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-command-no-loop-"));
    const sessions = await createSessionStore(dataDir);
    const conversation = new ConversationService(sessions, new Logger("error"));
    const service = new CommandService(conversation);
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
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const output = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop add */10 * * * * * check status",
      }),
    );

    expect(output).toBe("当前没启用 loop 调度器。这台机器暂时还不会自己惦记事情。");
  });

  test("reports loop parse errors when no schedule can be resolved", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const output = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop add",
      }),
    );

    expect(output).toBe("用法：/loop add <expr> <prompt>。cron 不写对，时间也只会装作路过。");
  });

  test("rejects invalid one-token loop schedule input before scheduling", async () => {
    const { service, conversation, runtime, loop } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const output = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop add every check status",
      }),
    );

    expect(output).toBe("用法：/loop add <expr> <prompt>。cron 不写对，时间也只会装作路过。");
    expect(loop.list("demo")).toHaveLength(0);
  });

  test("uses five-part cron expression branch for natural language loop parse", async () => {
    const { service, conversation, runtime, loop } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const output = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop add 0 9 * * * check build status",
      }),
    );
    expect(output).toContain("已创建 loop：");

    const jobs = loop.list("demo");
    const job = jobs.find((item) => item.prompt === "check build status");
    expect(job?.scheduleExpr).toBe("0 9 * * *");
  });

  test("returns usage when list is called but no jobs exist", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const output = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop list",
      }),
    );

    expect(output).toBe("当前没有 loop 任务。说明定时打扰功能还算克制。");
  });

  test("returns usage for /loop del without id and error for unknown target", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const delUsage = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/loop del",
      }),
    );
    expect(delUsage).toBe("用法：/loop del <id>。不给 ID，我也不敢乱删，毕竟还想活。");

    const delMissing = expectHandled(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/switch missing-session",
      }),
    );
    expect(delMissing).toContain("没找到会话：missing-session。它可能改名了，也可能从没存在过。");
  });

  test("reads active Claude team status, members and tasks from local snapshots", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-command-team-"));
    await createClaudeTeamFiles(homeDir);

    const { service, conversation, runtime } = await createHarness();
    runtime.config.agent.options.env = {
      HOME: homeDir,
    };
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.agentSessionId = "lead-session-1";

    const status = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team",
    }));
    expect(status).toContain("Team alpha-team");
    expect(status).toContain("成员：2");
    expect(status).toContain("任务：2（进行中 1，已完成 1）");

    const members = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team members",
    }));
    expect(members).toContain("Alice\t执行中\tresearch/claude-sonnet-4-5");
    expect(members).toContain("Bob\t可接单\timplementer/claude-opus-4-1\tplan-mode");

    const tasks = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team tasks",
    }));
    expect(tasks).toContain("1\t进行中\tAlice\tAlice");
    expect(tasks).toContain("2\t已完成\tBob\tBob");
    expect(session.teamState?.teamName).toBe("alpha-team");
    expect(session.teamState?.active).toBe(true);
  });

  test("returns no-active-team response when no Claude team is available", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.teamState = {
      active: true,
      teamName: "alpha-team",
      members: {},
      tasks: {},
      messages: [],
      updatedAt: "2026-03-15T10:00:00.000Z",
    };

    const status = expectHandled(await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team",
    }));

    expect(status).toBe("当前没有活跃的 Claude agent team。最近一次 team：alpha-team（已结束）。");
    expect(session.teamState?.active).toBe(false);
  });

  test("forwards /team ask, /team stop and /team cleanup to the lead agent", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-command-team-"));
    await createClaudeTeamFiles(homeDir);

    const { service, conversation, runtime } = await createHarness();
    runtime.config.agent.options.env = {
      HOME: homeDir,
    };
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.agentSessionId = "lead-session-1";

    const ask = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team ask Alice 请检查失败的构建",
    });
    expect(ask.kind).toBe("forward_to_agent");
    if (ask.kind === "forward_to_agent") {
      expect(ask.prompt).toContain("当前 team: alpha-team");
      expect(ask.prompt).toContain("teammate Alice");
      expect(ask.prompt).toContain("任务内容：请检查失败的构建");
    }

    const stop = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team stop Bob",
    });
    expect(stop.kind).toBe("forward_to_agent");
    if (stop.kind === "forward_to_agent") {
      expect(stop.prompt).toContain("当前 team: alpha-team");
      expect(stop.prompt).toContain("teammate Bob 停止当前任务");
    }

    const cleanup = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/team cleanup",
    });
    expect(cleanup.kind).toBe("forward_to_agent");
    if (cleanup.kind === "forward_to_agent") {
      expect(cleanup.prompt).toContain("当前 team: alpha-team");
      expect(cleanup.prompt).toContain("请清理当前 agent team");
      expect(cleanup.prompt).toContain("删除这个 team");
    }
  });
});
