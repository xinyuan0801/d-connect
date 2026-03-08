import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Logger } from "../src/logging.js";
import { createSessionStore } from "../src/runtime/session-store.js";
import { createLoopStore, LoopScheduler } from "../src/scheduler/loop.js";
import { ConversationService } from "../src/services/conversation-service.js";
import { CommandService, type CommandResult } from "../src/services/command-service.js";
import type { AgentAdapter, AgentSession, ModeSwitchable } from "../src/runtime/types.js";
import type { ProjectRuntime } from "../src/services/project-registry.js";

class FakeAgent implements AgentAdapter, ModeSwitchable {
  readonly name = "fake";
  private mode = "default";

  async startSession(): Promise<AgentSession> {
    throw new Error("not used");
  }

  async stop(): Promise<void> {
    // noop
  }

  setMode(mode: string): void {
    this.mode = mode;
  }

  getMode(): string {
    return this.mode;
  }

  supportedModes(): string[] {
    return ["default", "plan"];
  }
}

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "d-connect-command-"));
  const sessions = await createSessionStore(dataDir);
  const conversation = new ConversationService(sessions, new Logger("error"));
  const loopStore = await createLoopStore(dataDir);
  const loop = new LoopScheduler(loopStore, new Logger("error"));
  const service = new CommandService(conversation, loop);
  const runtime: ProjectRuntime = {
    config: {
      name: "demo",
      agent: {
        type: "claudecode",
        options: {},
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
  test("handles session lifecycle and mode switching", async () => {
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
        raw: "/mode",
      })),
    ).toContain("supported=default,plan");

    expect(
      expectHandled(await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/mode plan",
      })),
    ).toBe("mode updated: plan");
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
      prompt: expect.stringContaining("d-connect 支持通过命令行添加 loop 任务。"),
    });
    expect(result.kind).toBe("forward_to_agent");
    if (result.kind === "forward_to_agent") {
      expect(result.prompt).toContain('d-connect loop add -p "demo" -s "local:alice" -e "<scheduleExpr>" "<prompt>"');
      expect(result.prompt).not.toContain("pnpm run dev");
      expect(result.prompt).toContain("用户请求：每天早上 9 点提醒我检查构建状态，规则用 0 0 9 * * *");
    }
  });
});
