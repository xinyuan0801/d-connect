import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import {
  ClaudeTeamWatcher,
  findClaudeTeamStateByLeadSessionId,
  readClaudeTeamState,
} from "../src/adapters/agent/claudecode-team.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function createTeamFixture(homeDir: string): Promise<void> {
  await writeJson(join(homeDir, ".claude", "teams", "alpha-team", "config.json"), {
    name: "alpha-team",
    leadAgentId: "lead-1",
    leadSessionId: "session-123",
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

  await writeJson(join(homeDir, ".claude", "teams", "alpha-team", "inboxes", "team-lead.json"), [
    {
      from: "Alice",
      text: "{\"type\":\"idle_notification\",\"from\":\"Alice\",\"idleReason\":\"available\"}",
      timestamp: "2026-03-15T10:00:00.000Z",
      color: "blue",
    },
    {
      from: "Alice",
      text: "Investigated the failure path and isolated the root cause.",
      summary: "Root cause isolated",
      timestamp: "2026-03-15T10:01:00.000Z",
      color: "blue",
    },
  ]);

  await writeJson(join(homeDir, ".claude", "tasks", "alpha-team", "1.json"), {
    id: "1",
    subject: "Alice",
    description: "Investigate the failure path",
    status: "in_progress",
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("claudecode team helpers", () => {
  test("reads team state from claude files and suppresses idle mailbox noise", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-claude-team-"));
    await createTeamFixture(homeDir);

    const state = await readClaudeTeamState("alpha-team", { homeDir });

    expect(state).toBeDefined();
    expect(state?.teamName).toBe("alpha-team");
    expect(state?.leadAgentId).toBe("lead-1");
    expect(state?.messages).toEqual([
      expect.objectContaining({
        memberName: "Alice",
        summary: "Root cause isolated",
        content: "Investigated the failure path and isolated the root cause.",
      }),
    ]);
    expect(state?.members["agent-alice"]).toEqual(
      expect.objectContaining({
        memberName: "Alice",
        status: "working",
        agentType: "research",
      }),
    );
    expect(state?.tasks["1"]).toEqual(
      expect.objectContaining({
        taskId: "1",
        memberName: "Alice",
        status: "in_progress",
      }),
    );
  });

  test("rehydrates team state from lead session id", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-claude-team-"));
    await createTeamFixture(homeDir);

    const state = await findClaudeTeamStateByLeadSessionId("session-123", { homeDir });

    expect(state?.teamName).toBe("alpha-team");
    expect(state?.leadAgentId).toBe("lead-1");
    expect(state?.messages).toHaveLength(1);
  });

  test("watcher emits task completion and new teammate messages without replaying history", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "d-connect-claude-team-"));
    await createTeamFixture(homeDir);

    const events: AgentEvent[] = [];
    const watcher = new ClaudeTeamWatcher(new Logger("error"), (event) => events.push(event), {
      homeDir,
      pollIntervalMs: 20,
    });

    watcher.observe([{ type: "text", sessionId: "session-123" }]);
    await watcher.start();

    await writeJson(join(homeDir, ".claude", "tasks", "alpha-team", "1.json"), {
      id: "1",
      subject: "Alice",
      description: "Investigate the failure path",
      status: "completed",
    });
    await writeJson(join(homeDir, ".claude", "teams", "alpha-team", "inboxes", "team-lead.json"), [
      {
        from: "Alice",
        text: "{\"type\":\"idle_notification\",\"from\":\"Alice\",\"idleReason\":\"available\"}",
        timestamp: "2026-03-15T10:00:00.000Z",
        color: "blue",
      },
      {
        from: "Alice",
        text: "Investigated the failure path and isolated the root cause.",
        summary: "Root cause isolated",
        timestamp: "2026-03-15T10:01:00.000Z",
        color: "blue",
      },
      {
        from: "Alice",
        text: "Patched the failing edge case and verified the output.",
        summary: "Patch ready",
        timestamp: "2026-03-15T10:02:00.000Z",
        color: "blue",
      },
    ]);

    await waitFor(() => {
      const hasCompleted = events.some((event) => event.type === "team_event" && event.team?.kind === "task_completed");
      const hasMessage = events.some((event) => event.type === "team_message" && event.team?.summary === "Patch ready");
      return hasCompleted && hasMessage;
    });

    await watcher.stop();

    expect(events.filter((event) => event.type === "team_message")).toEqual([
      expect.objectContaining({
        type: "team_message",
        content: "Patched the failing edge case and verified the output.",
        team: expect.objectContaining({
          kind: "message",
          memberName: "Alice",
          summary: "Patch ready",
        }),
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "team_event",
        content: "Alice",
        team: expect.objectContaining({
          kind: "task_completed",
          memberName: "Alice",
          taskId: "1",
          taskStatus: "completed",
        }),
      }),
    );
  });
});
