import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createLoopStore, LoopScheduler, LoopStore } from "../src/scheduler/loop.js";
import { Logger } from "../src/logging.js";
import type { LoopJob, JobExecutor } from "../src/runtime/types.js";

class MockExecutor implements JobExecutor {
  public calls: LoopJob[] = [];

  async executeJob(job: LoopJob): Promise<void> {
    this.calls.push(job);
  }
}

describe("loop scheduler", () => {
  test("starts and stops scheduled jobs cleanly", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-start-"));
    const store = await createLoopStore(dataDir);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as const;
    const scheduler = new LoopScheduler(store, logger);

    const executor = new class implements JobExecutor {
      public calls: LoopJob[] = [];

      async executeJob(job: LoopJob): Promise<void> {
        this.calls.push(job);
      }
    }();

    scheduler.registerExecutor("demo", executor);
    await scheduler.addJob({
      project: "demo",
      sessionKey: "s-user",
      scheduleExpr: "*/10 * * * * *",
      prompt: "check status",
      description: "test",
      silent: false,
    });

    await scheduler.start();
    await scheduler.runJobNow(scheduler.list("demo")[0]!.id);
    expect(executor.calls).toHaveLength(1);

    await scheduler.stop();
    expect(logger.info).toHaveBeenCalledWith("loop scheduler started", { jobs: 1 });
  });

  test("covers shared context mode and invalid id execute path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-shared-"));
    const store = await createLoopStore(dataDir);
    const scheduler = new LoopScheduler(store, new Logger("error"));
    const executor = new class implements JobExecutor {
      public calls: LoopJob[] = [];

      async executeJob(job: LoopJob): Promise<void> {
        this.calls.push(job);
      }
    }();

    scheduler.registerExecutor("demo", executor);
    const job = await scheduler.addJob({
      project: "demo",
      sessionKey: "s-user",
      scheduleExpr: "*/10 * * * * *",
      prompt: "check status",
      description: "shared",
      silent: false,
      contextMode: "shared",
    });

    await scheduler.runJobNow("missing-id");
    expect(executor.calls).toHaveLength(0);
    expect(job.contextMode).toBe("shared");
  });

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

  test("validates cron expression before creating job", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-invalid-"));
    const store = await createLoopStore(dataDir);
    const scheduler = new LoopScheduler(store, new Logger("error"));

    await expect(
      scheduler.addJob({
        project: "demo",
        sessionKey: "s-user",
        scheduleExpr: "bad expr",
        prompt: "ping",
        description: "invalid",
        silent: false,
      }),
    ).rejects.toThrow("invalid schedule expression");
  });

  test("run now records error when executor is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-miss-"));
    const store = await createLoopStore(dataDir);
    const scheduler = new LoopScheduler(store, new Logger("error"));

    const job = await scheduler.addJob({
      project: "demo",
      sessionKey: "s-user",
      scheduleExpr: "*/10 * * * * *",
      prompt: "check status",
      description: "missing executor",
      silent: false,
    });

    await scheduler.runJobNow(job.id);

    const updated = scheduler.list().find((item) => item.id === job.id);
    expect(updated?.lastError).toBe("project not found: demo");
    expect(updated?.lastRun).toBeTypeOf("string");
  });

  test("run now records error for executor failure and keeps project alive", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-fail-"));
    const store = await createLoopStore(dataDir);

    class FailingExecutor implements JobExecutor {
      public calls = 0;

      async executeJob(): Promise<void> {
        this.calls += 1;
        throw new Error("boom");
      }
    }

    const scheduler = new LoopScheduler(store, new Logger("error"));
    const executor = new FailingExecutor();
    scheduler.registerExecutor("demo", executor);

    const job = await scheduler.addJob({
      project: "demo",
      sessionKey: "s-user",
      scheduleExpr: "*/10 * * * * *",
      prompt: "check status",
      description: "executor fail",
      silent: false,
    });

    await scheduler.runJobNow(job.id);

    const updated = scheduler.list().find((item) => item.id === job.id);
    expect(executor.calls).toBe(1);
    expect(updated?.lastError).toContain("boom");
  });

  test("ignores invalid loop snapshot files without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d-connect-loop-invalid-store-"));
    const loopsDir = join(dir, "loops");
    await mkdir(loopsDir, { recursive: true });
    const snapshot = join(loopsDir, "jobs.json");
    await writeFile(snapshot, "{", "utf8");

    const store = new LoopStore(snapshot);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test("removing a missing job returns false and keeps scheduler stable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-loop-miss2-"));
    const store = await createLoopStore(dataDir);
    const scheduler = new LoopScheduler(store, new Logger("error"));

    const removed = await scheduler.removeJob("missing-id");
    expect(removed).toBe(false);
  });
});
