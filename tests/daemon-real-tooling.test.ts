import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ipcSend } from "../src/ipc/client.js";
import { readClaudeTeamState } from "../src/adapters/agent/claudecode-team.js";
import {
  PLATFORM_SESSION_KEY,
  PROJECT_NAME,
  REAL_AGENT_E2E_ENABLED,
  RealAgentDaemonHarness,
  resolveRealAgentSpecs,
  waitForCondition,
} from "./helpers/real-agent-daemon.js";

const TOOL_AGENT_SPECS = resolveRealAgentSpecs("D_CONNECT_REAL_TOOL_AGENT_TYPES");
const CLAUDE_TEAM_SPECS = TOOL_AGENT_SPECS.filter((spec) => spec.type === "claudecode");

describe.skipIf(!REAL_AGENT_E2E_ENABLED)("daemon real agent tooling", () => {
  const harnesses: RealAgentDaemonHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
  });

  for (const spec of TOOL_AGENT_SPECS) {
    const run = spec.available ? test : test.skip;

    run(
      `${spec.type} surfaces tool execution and complex multi-turn output through daemon ipc`,
      async () => {
        const harness = new RealAgentDaemonHarness(spec, spec.type === "codex" ? { mode: "full-auto" } : {});
        harnesses.push(harness);
        await harness.start();

        const token = `TOOL_${spec.type.toUpperCase()}_${Date.now()}`;
        const first = await ipcSend(harness.socketPath, {
          project: PROJECT_NAME,
          sessionKey: "local:tooling",
          content: [
            "You must use at least one tool.",
            "Do not answer from memory.",
            "Use a shell command or another available tool to determine the basename of the current working directory.",
            `Then reply with exactly two lines: TOKEN:${token} and DIR:<basename>.`,
          ].join(" "),
        });

        expect(first.response).toContain("🛠️");
        expect(first.response).toContain(token);
        expect(first.response).toContain("DIR:");

        const second = await ipcSend(harness.socketPath, {
          project: PROJECT_NAME,
          sessionKey: "local:tooling",
          content: "Based on your previous answer only, return valid JSON with keys token and dir.",
        });

        expect(second.response).toContain(token);
        expect(second.response).toContain("token");
        expect(second.response).toContain("dir");
        expect(second.response.includes("{") || second.response.includes("```json")).toBe(true);
      },
      300000,
    );
  }

  for (const spec of CLAUDE_TEAM_SPECS) {
    const run = spec.available ? test : test.skip;

    run(
      "claudecode surfaces real agent team lifecycle and serves /team tasks from Claude snapshots",
      async () => {
        const harness = new RealAgentDaemonHarness(spec);
        harnesses.push(harness);
        await harness.start();

        const teamName = `dconnect-smoke-${Date.now()}`;
        const teamRoot = join(process.env.HOME ?? homedir(), ".claude");

        try {
          await harness.deliverPlatformMessage(
            [
              `Use the TeamCreate tool to create a Claude agent team named ${teamName}.`,
              `Then use the Agent tool to spawn exactly one teammate named tester in the ${teamName} team.`,
              "Assign tester exactly this task:",
              "- run a shell command that prints the basename of the current working directory",
              "- send one mailbox update back to the lead containing exactly TEAM_SMOKE_RESULT:<basename>",
              "After spawning tester, do not wait for the task to finish.",
              "Do not inspect the mailbox.",
              `Reply with exactly one line: TEAM_SMOKE_LEAD_READY:${teamName}`,
            ].join(" "),
            `team-${Date.now()}`,
          );

          const replyText = harness.platform?.replies.map((item) => item.content).join("\n") ?? "";
          expect(replyText).toContain(`🤝 Team ${teamName} 已创建`);
          expect(replyText).toContain("👤 tester");
          expect(replyText).toContain("📌 tester 开始：");

          await waitForCondition(
            async () => {
              const state = await readClaudeTeamState(teamName);
              if (!state) {
                return false;
              }
              const hasTester = Object.values(state.members).some((member) => member.memberName === "tester");
              const hasTask = Object.values(state.tasks).some((task) => task.memberName === "tester");
              return hasTester && hasTask;
            },
            {
              timeoutMs: 120000,
              intervalMs: 1000,
              description: `Claude team snapshot for ${teamName} was not materialized in time`,
            },
          );

          const tasks = await ipcSend(harness.socketPath, {
            project: PROJECT_NAME,
            sessionKey: PLATFORM_SESSION_KEY,
            content: "/team tasks",
          });
          expect(tasks.response).toContain(`Team ${teamName} 任务：`);
          expect(tasks.response).toContain("tester");
        } finally {
          await rm(join(teamRoot, "teams", teamName), { recursive: true, force: true });
          await rm(join(teamRoot, "tasks", teamName), { recursive: true, force: true });
        }
      },
      300000,
    );
  }
});
