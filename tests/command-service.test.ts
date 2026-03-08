import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Logger } from "../src/logging.js";
import { createSessionStore } from "../src/runtime/session-store.js";
import { createCronStore, CronScheduler } from "../src/scheduler/cron.js";
import { ConversationService } from "../src/services/conversation-service.js";
import { CommandService } from "../src/services/command-service.js";
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
  const cronStore = await createCronStore(dataDir);
  const cron = new CronScheduler(cronStore, new Logger("error"));
  const service = new CommandService(conversation, cron);
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
    cron,
    runtime,
  };
}

describe("command service", () => {
  test("handles session lifecycle and mode switching", async () => {
    const { service, conversation, runtime } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const created = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/new review",
    });
    expect(created).toMatch(/created session/);

    const list = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/list",
    });
    expect(list).toContain("review");

    const switchTarget = list
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("review"))
      ?.split(/\s+/)[1];
    expect(switchTarget).toBeTruthy();

    const switched = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: `/switch ${switchTarget}`,
    });
    expect(switched).toContain("active session");

    expect(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/mode",
      }),
    ).toContain("supported=default,plan");

    expect(
      await service.handle({
        runtime,
        project: "demo",
        sessionKey: "local:alice",
        session,
        raw: "/mode plan",
      }),
    ).toBe("mode updated: plan");
  });

  test("handles cron add/list/del through command registry", async () => {
    const { service, conversation, runtime, cron } = await createHarness();
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const created = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/cron add */10 * * * * * check status",
    });
    expect(created).toMatch(/cron created:/);

    const id = created.split(": ")[1];
    expect(id).toBeTruthy();

    const listed = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: "/cron list",
    });
    expect(listed).toContain("check status");

    const removed = await service.handle({
      runtime,
      project: "demo",
      sessionKey: "local:alice",
      session,
      raw: `/cron del ${id}`,
    });
    expect(removed).toBe(`cron removed: ${id}`);
    expect(cron.list("demo")).toHaveLength(0);
  });
});
