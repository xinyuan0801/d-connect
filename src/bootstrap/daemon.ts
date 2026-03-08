import { join } from "node:path";
import { bootstrapConfig, fileExists, loadConfig, normalizeConfig, resolveConfigPath } from "../config/index.js";
import { Logger } from "../infra/logging/logger.js";
import { createCronStore, CronScheduler } from "../scheduler/cron.js";
import { RuntimeEngine } from "../runtime/engine.js";
import { ensureDir } from "../infra/store-json/atomic.js";
import { ensureSocketAvailable, IpcServer } from "../ipc/server.js";

export interface StartAppOptions {
  explicitConfigPath?: string;
}

export async function resolveAndLoadConfig(explicitConfigPath?: string) {
  const configPath = resolveConfigPath(explicitConfigPath);
  const exists = await fileExists(configPath);

  if (!exists) {
    await bootstrapConfig(configPath);
    throw new Error(
      `config file created at ${configPath}; edit it before starting d-connect, or run \"d-connect init -c ${configPath} --force\"`,
    );
  }

  const rawConfig = await loadConfig(configPath);
  const config = normalizeConfig(rawConfig);
  return {
    config,
    rawConfig,
    configPath,
  };
}

export async function startDaemon(options: StartAppOptions = {}): Promise<void> {
  const { config, configPath } = await resolveAndLoadConfig(options.explicitConfigPath);
  await ensureDir(config.dataDir);
  const logDir = join(config.dataDir, "logs");
  const logPath = join(logDir, "d-connect.log");
  await ensureDir(logDir);
  await Logger.configureFile(logPath);

  const logger = new Logger(config.log.level).child("d-connect");
  logger.info("starting", { configPath, dataDir: config.dataDir, logPath });

  const cronStore = await createCronStore(config.dataDir);
  const cronScheduler = new CronScheduler(cronStore, logger.child("cron"), config.cron.silent);
  const runtime = new RuntimeEngine(config, logger.child("runtime"), cronScheduler);
  const ipcServer = new IpcServer({
    socketPath: join(config.dataDir, "ipc.sock"),
    runtime,
    cron: cronScheduler,
    logger: logger.child("ipc"),
  });

  await ensureSocketAvailable(join(config.dataDir, "ipc.sock"));
  await runtime.start();
  await cronScheduler.start();
  await ipcServer.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("stopping", { signal });

    try {
      cronScheduler.stop();
      await ipcServer.stop();
      await runtime.stop();
      logger.info("stopped");
    } catch (error) {
      logger.error("failed to stop cleanly", {
        error: (error as Error).message,
      });
    } finally {
      await Logger.closeFile();
    }
  };

  process.on("SIGINT", () => {
    void stop("SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM").finally(() => process.exit(0));
  });

  await new Promise<void>(() => {
    // keep daemon alive
  });
}
