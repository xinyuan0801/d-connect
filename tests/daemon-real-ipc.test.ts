import { afterEach, describe, expect, test } from "vitest";
import { ipcLoopAdd, ipcLoopDel, ipcLoopList, ipcSend } from "../src/ipc/client.js";
import {
  PLATFORM_SESSION_KEY,
  PROJECT_NAME,
  REAL_AGENT_E2E_ENABLED,
  RealAgentDaemonHarness,
  resolveRealAgentSpecs,
  waitForCondition,
} from "./helpers/real-agent-daemon.js";

const IPC_AGENT_SPECS = resolveRealAgentSpecs("D_CONNECT_REAL_IPC_AGENT_TYPES");

describe.skipIf(!REAL_AGENT_E2E_ENABLED)("daemon real ipc integration", () => {
  const harnesses: RealAgentDaemonHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
  });

  for (const spec of IPC_AGENT_SPECS) {
    const run = spec.available ? test : test.skip;

    run(
      `${spec.type} serves /send over ipc and keeps multi-turn context`,
      async () => {
        const harness = new RealAgentDaemonHarness(spec, spec.type === "codex" ? { mode: "full-auto" } : {});
        harnesses.push(harness);
        await harness.start();

        const token = `IPC_${spec.type.toUpperCase()}_${Date.now()}`;
        const first = await ipcSend(harness.socketPath, {
          project: PROJECT_NAME,
          sessionKey: "local:ipc-send",
          content: `Reply with the exact token ${token}. You may add no other words.`,
        });

        expect(first.response).toContain(token);

        const second = await ipcSend(harness.socketPath, {
          project: PROJECT_NAME,
          sessionKey: "local:ipc-send",
          content: `Return a JSON object with one field named token whose value is the exact token from your previous answer.`,
        });

        expect(second.response).toContain(token);
        expect(second.response).toContain("token");
      },
      240000,
    );

    run(
      `${spec.type} serves /loop add/list/del and triggers scheduled real-agent jobs`,
      async () => {
        const harness = new RealAgentDaemonHarness(spec, spec.type === "codex" ? { mode: "full-auto" } : {});
        harnesses.push(harness);
        await harness.start();

        await harness.deliverPlatformMessage("/new loop-seed", "seed-1");
        harness.platform?.clear();

        const loopToken = `LOOP_${spec.type.toUpperCase()}_${Date.now()}`;
        const job = await ipcLoopAdd(harness.socketPath, {
          project: PROJECT_NAME,
          sessionKey: PLATFORM_SESSION_KEY,
          scheduleExpr: "*/30 * * * * *",
          prompt: `Reply with the exact token ${loopToken}. You may add no other words.`,
          description: "real agent scheduled smoke test",
          silent: false,
        });

        const listed = await ipcLoopList(harness.socketPath, PROJECT_NAME);
        expect(listed.jobs.some((item) => item.id === job.id)).toBe(true);

        const refreshed = await ipcLoopList(harness.socketPath, PROJECT_NAME);
        let updated = refreshed.jobs.find((item) => item.id === job.id);

        await waitForCondition(
          async () => {
            if (harness.platform?.sends.some((item) => item.content.includes(loopToken)) ?? false) {
              return true;
            }
            const current = await ipcLoopList(harness.socketPath, PROJECT_NAME);
            updated = current.jobs.find((item) => item.id === job.id);
            if (updated?.lastError && updated.lastError.length > 0) {
              throw new Error(
                `loop job failed before emitting token: ${updated.lastError}; sends=${JSON.stringify(harness.platform?.sends ?? [])}`,
              );
            }
            return false;
          },
          {
            timeoutMs: 150000,
            intervalMs: 1000,
            description: `loop job did not emit ${loopToken}; sends=${JSON.stringify(harness.platform?.sends ?? [])}`,
          },
        );

        updated = (await ipcLoopList(harness.socketPath, PROJECT_NAME)).jobs.find((item) => item.id === job.id);
        expect(updated?.lastRun).toBeTypeOf("string");
        expect(updated?.lastError ?? "").toBe("");

        const deleted = await ipcLoopDel(harness.socketPath, job.id);
        expect(deleted).toEqual({ deleted: true, id: job.id });
        expect((await ipcLoopList(harness.socketPath, PROJECT_NAME)).jobs.some((item) => item.id === job.id)).toBe(false);
      },
      300000,
    );
  }
});
