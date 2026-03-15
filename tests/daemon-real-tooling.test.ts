import { afterEach, describe, expect, test } from "vitest";
import { ipcSend } from "../src/ipc/client.js";
import {
  PROJECT_NAME,
  REAL_AGENT_E2E_ENABLED,
  RealAgentDaemonHarness,
  resolveRealAgentSpecs,
} from "./helpers/real-agent-daemon.js";

const TOOL_AGENT_SPECS = resolveRealAgentSpecs("D_CONNECT_REAL_TOOL_AGENT_TYPES");

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
});
