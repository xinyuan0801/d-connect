import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import cron from "node-cron";
import { writeJsonAtomic, ensureDir } from "../infra/store-json/atomic.js";
import type { LoopJob, JobExecutor } from "../core/types.js";
import { Logger } from "../logging.js";

interface LoopSnapshot {
  jobs: LoopJob[];
}

export class LoopStore {
  private jobs = new Map<string, LoopJob>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as LoopSnapshot;
      this.jobs.clear();
      for (const job of parsed.jobs ?? []) {
        this.jobs.set(job.id, job);
      }
    } catch {
      // ignore empty
    }
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.path, {
      jobs: [...this.jobs.values()],
    });
  }

  list(): LoopJob[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  listByProject(project: string): LoopJob[] {
    return this.list().filter((job) => job.project === project);
  }

  get(id: string): LoopJob | undefined {
    return this.jobs.get(id);
  }

  async add(job: LoopJob): Promise<void> {
    this.jobs.set(job.id, job);
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.jobs.delete(id);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  async markRun(id: string, err?: Error): Promise<void> {
    const found = this.jobs.get(id);
    if (!found) {
      return;
    }
    found.lastRun = new Date().toISOString();
    found.lastError = err ? err.message : "";
    this.jobs.set(id, found);
    await this.save();
  }
}

export class LoopScheduler {
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private readonly executors = new Map<string, JobExecutor>();

  constructor(
    private readonly store: LoopStore,
    private readonly logger: Logger,
    private readonly defaultSilent = false,
  ) {}

  registerExecutor(project: string, executor: JobExecutor): void {
    this.executors.set(project, executor);
  }

  async start(): Promise<void> {
    const jobs = this.store.list().filter((job) => job.enabled);
    for (const job of jobs) {
      this.schedule(job);
    }
    this.logger.info("loop scheduler started", { jobs: jobs.length });
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
      task.destroy();
    }
    this.tasks.clear();
  }

  private schedule(job: LoopJob): void {
    const old = this.tasks.get(job.id);
    if (old) {
      old.stop();
      old.destroy();
    }

    const task = cron.schedule(job.scheduleExpr, () => {
      void this.execute(job.id);
    });

    this.tasks.set(job.id, task);
  }

  async addJob(input: Omit<LoopJob, "id" | "createdAt" | "enabled">): Promise<LoopJob> {
    if (!cron.validate(input.scheduleExpr)) {
      throw new Error(`invalid schedule expression: ${input.scheduleExpr}`);
    }

    const job: LoopJob = {
      ...input,
      id: randomBytes(4).toString("hex"),
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await this.store.add(job);
    this.schedule(job);
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      task.destroy();
      this.tasks.delete(id);
    }
    return this.store.remove(id);
  }

  list(project?: string): LoopJob[] {
    if (!project) {
      return this.store.list();
    }
    return this.store.listByProject(project);
  }

  async runJobNow(id: string): Promise<void> {
    await this.execute(id);
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job || !job.enabled) {
      return;
    }

    const executor = this.executors.get(job.project);
    if (!executor) {
      await this.store.markRun(id, new Error(`project not found: ${job.project}`));
      return;
    }

    const silent = job.silent ?? this.defaultSilent;

    try {
      await executor.executeJob({
        ...job,
        silent,
      });
      await this.store.markRun(id);
    } catch (error) {
      await this.store.markRun(id, error as Error);
      this.logger.error("loop job failed", {
        id,
        error: (error as Error).message,
      });
    }
  }
}

export async function createLoopStore(dataDir: string): Promise<LoopStore> {
  const dir = join(dataDir, "loops");
  await ensureDir(dir);
  const store = new LoopStore(join(dir, "jobs.json"));
  await store.load();
  return store;
}
