import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createLoopStore, LoopScheduler } from "../src/scheduler/loop.js";
import { Logger } from "../src/logging.js";
import type { LoopJob, JobExecutor } from "../src/runtime/types.js";

class MockExecutor implements JobExecutor {
  public calls: LoopJob[] = [];

  async executeJob(job: LoopJob): Promise<void> {
    this.calls.push(job);
  }
}

describe("loop scheduler", () => {
  test("add/list/del and run now", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-"));
    const store = await createLoopStore(dataDir);
    const scheduler = new LoopScheduler(store, new Logger("error"));

    const executor = new MockExecutor();
    scheduler.registerExecutor("demo", executor);

    const job = await scheduler.addJob({
      project: "demo",
      sessionKey: "s-user",
      scheduleExpr: "*/10 * * * * *",
      prompt: "check status",
      description: "test",
      silent: false,
    });

    const listed = scheduler.list("demo");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(job.id);

    await scheduler.runJobNow(job.id);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.project).toBe("demo");
    expect(executor.calls[0]?.sessionKey).toBe("s-user");
    expect(executor.calls[0]?.contextMode).toBe("isolated");

    const removed = await scheduler.removeJob(job.id);
    expect(removed).toBe(true);
    expect(scheduler.list("demo")).toHaveLength(0);

    scheduler.stop();
  });
});
