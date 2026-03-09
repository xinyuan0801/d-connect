import { join } from "node:path";
import { bootstrapConfig, fileExists, loadConfig, normalizeConfig, resolveConfigPath } from "../config/index.js";
import { Logger } from "../infra/logging/logger.js";
import { createLoopStore, LoopScheduler } from "../scheduler/loop.js";
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
  const config = normalizeConfig(rawConfig, { configPath });
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

  const loopStore = await createLoopStore(config.dataDir);
  const loopScheduler = new LoopScheduler(loopStore, logger.child("loop"), config.loop.silent);
  const runtime = new RuntimeEngine(config, logger.child("runtime"), loopScheduler, {
    configPath,
  });
  let requestStop = (_signal: string): void => {};
  const ipcServer = new IpcServer({
    socketPath: join(config.dataDir, "ipc.sock"),
    runtime,
    loop: loopScheduler,
    logger: logger.child("ipc"),
    requestStop: (signal) => requestStop(signal),
  });

  await ensureSocketAvailable(join(config.dataDir, "ipc.sock"));
  await runtime.start();
  await loopScheduler.start();
  await ipcServer.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("stopping", { signal });

    try {
      loopScheduler.stop();
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

  requestStop = (signal) => {
    void stop(signal).finally(() => process.exit(0));
  };

  process.on("SIGINT", () => {
    requestStop("SIGINT");
  });
  process.on("SIGTERM", () => {
    requestStop("SIGTERM");
  });

  await new Promise<void>(() => {
    // keep daemon alive
  });
}
