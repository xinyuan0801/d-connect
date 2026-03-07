import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import cron from "node-cron";
import { writeJsonAtomic, ensureDir } from "../infra/store-json/atomic.js";
import type { CronExecutor, CronJob } from "../runtime/types.js";
import { Logger } from "../logging.js";

interface CronSnapshot {
  jobs: CronJob[];
}

export class CronStore {
  private jobs = new Map<string, CronJob>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as CronSnapshot;
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

  list(): CronJob[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  listByProject(project: string): CronJob[] {
    return this.list().filter((job) => job.project === project);
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  async add(job: CronJob): Promise<void> {
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

export class CronScheduler {
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private readonly executors = new Map<string, CronExecutor>();

  constructor(
    private readonly store: CronStore,
    private readonly logger: Logger,
    private readonly defaultSilent = false,
  ) {}

  registerExecutor(project: string, executor: CronExecutor): void {
    this.executors.set(project, executor);
  }

  async start(): Promise<void> {
    const jobs = this.store.list().filter((job) => job.enabled);
    for (const job of jobs) {
      this.schedule(job);
    }
    this.logger.info("cron scheduler started", { jobs: jobs.length });
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
      task.destroy();
    }
    this.tasks.clear();
  }

  private schedule(job: CronJob): void {
    const old = this.tasks.get(job.id);
    if (old) {
      old.stop();
      old.destroy();
    }

    const task = cron.schedule(job.cronExpr, () => {
      void this.execute(job.id);
    });

    this.tasks.set(job.id, task);
  }

  async addJob(input: Omit<CronJob, "id" | "createdAt" | "enabled">): Promise<CronJob> {
    if (!cron.validate(input.cronExpr)) {
      throw new Error(`invalid cron expression: ${input.cronExpr}`);
    }

    const job: CronJob = {
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

  list(project?: string): CronJob[] {
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
      await executor.executeCronJob({
        ...job,
        silent,
      });
      await this.store.markRun(id);
    } catch (error) {
      await this.store.markRun(id, error as Error);
      this.logger.error("cron job failed", {
        id,
        error: (error as Error).message,
      });
    }
  }
}

export async function createCronStore(dataDir: string): Promise<CronStore> {
  const dir = join(dataDir, "crons");
  await ensureDir(dir);
  const store = new CronStore(join(dir, "jobs.json"));
  await store.load();
  return store;
}
