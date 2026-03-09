import { join } from "node:path";
import { bootstrapConfig, fileExists, loadConfig, normalizeConfig, resolveConfigPath } from "../config/index.js";
import type { ResolvedAppConfig } from "../config/index.js";
import { Logger } from "../infra/logging/logger.js";
import { createLoopStore, LoopScheduler } from "../scheduler/loop.js";
import { RuntimeEngine } from "../runtime/engine.js";
import { ensureDir } from "../infra/store-json/atomic.js";
import { resolveIpcEndpoint } from "../ipc/endpoint.js";
import { ensureSocketAvailable, IpcServer } from "../ipc/server.js";

export interface StartAppOptions {
  explicitConfigPath?: string;
}

export interface AllowAllWarningTarget {
  projectName: string;
  platformType: string;
}

export function findAllowAllWarningTargets(config: ResolvedAppConfig): AllowAllWarningTarget[] {
  return config.projects.flatMap((project) =>
    project.platforms.flatMap((platform) => {
      if (platform.options.allowFrom.trim() !== "*") {
        return [];
      }
      return [
        {
          projectName: project.name,
          platformType: platform.type,
        },
      ];
    }),
  );
}

export function formatAllowAllWarning(targets: AllowAllWarningTarget[]): string | undefined {
  if (targets.length === 0) {
    return undefined;
  }

  const exposedTargets = targets.map((target) => `  - ${target.projectName} / ${target.platformType}`).join("\n");
  return [
    "",
    " __        ___    ____  _   _ ___ _   _  ____ ",
    " \\ \\      / / \\  |  _ \\| \\ | |_ _| \\ | |/ ___|",
    "  \\ \\ /\\ / / _ \\ | |_) |  \\| || ||  \\| | |  _ ",
    "   \\ V  V / ___ \\|  _ <| |\\  || || |\\  | |_| |",
    "    \\_/\\_/_/   \\_\\_| \\_\\_| \\_|___|_| \\_|\\____|",
    "",
    "检测到 allowFrom = \"*\"：任何能连到这个机器人的用户都可能直接开聊。",
    "如果这是共享群聊或公共环境，请先收紧 platform.options.allowFrom，再启动守护进程。",
    "",
    "受影响的目标：",
    exposedTargets,
    "",
  ].join("\n");
}

export async function resolveAndLoadConfig(explicitConfigPath?: string) {
  const configPath = resolveConfigPath(explicitConfigPath);
  const exists = await fileExists(configPath);

  if (!exists) {
    await bootstrapConfig(configPath);
    throw new Error(
      `已在 ${configPath} 创建配置文件；先改完配置再启动 d-connect，或者执行 "d-connect init -c ${configPath} --force" 重新生成。`,
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
  const allowAllWarningTargets = findAllowAllWarningTargets(config);
  const allowAllWarning = formatAllowAllWarning(allowAllWarningTargets);
  if (allowAllWarning) {
    console.warn(allowAllWarning);
    logger.warn("allowFrom wildcard detected", {
      targets: allowAllWarningTargets.map((target) => `${target.projectName}/${target.platformType}`),
    });
  }
  logger.info("starting", { configPath, dataDir: config.dataDir, logPath });

  const loopStore = await createLoopStore(config.dataDir);
  const loopScheduler = new LoopScheduler(loopStore, logger.child("loop"), config.loop.silent);
  const runtime = new RuntimeEngine(config, logger.child("runtime"), loopScheduler, {
    configPath,
  });
  const ipcEndpoint = resolveIpcEndpoint(config.dataDir);
  let requestStop = (_signal: string): void => {};
  const ipcServer = new IpcServer({
    socketPath: ipcEndpoint,
    runtime,
    loop: loopScheduler,
    logger: logger.child("ipc"),
    requestStop: (signal) => requestStop(signal),
  });

  await ensureSocketAvailable(ipcEndpoint);
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
