import { execFile } from "node:child_process";
import { Command } from "commander";
import { addProjectConfig, initConfig, resolveConfigPathByProject } from "../config/index.js";
import { ipcDaemonStop, ipcLoopAdd, ipcLoopDel, ipcLoopList, ipcSend } from "../ipc/client.js";
import { isNamedPipeEndpoint, resolveIpcEndpoint } from "../ipc/endpoint.js";
import { ensureSocketAvailable } from "../ipc/server.js";
import { resolveAndLoadConfig, startDaemon } from "./daemon.js";

function formatConfigCandidates(paths: string[]): string {
  return paths.map((path) => `"${path}"`).join(", ");
}

async function resolveSocketPath(options: { configPath?: string; projectName?: string } = {}): Promise<string> {
  let configPath = options.configPath;

  if (!configPath && options.projectName) {
    const resolution = await resolveConfigPathByProject(options.projectName);
    if (resolution.status === "matched") {
      configPath = resolution.path;
    } else if (resolution.status === "ambiguous" && resolution.candidates) {
      throw new Error(
        `有多个配置文件都包含项目 "${options.projectName}"：${formatConfigCandidates(resolution.candidates)}；请用 -c 指定一个。`,
      );
    }
  }

  const { config } = await resolveAndLoadConfig(configPath);
  return resolveIpcEndpoint(config.dataDir);
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
}

function isIpcUnavailableError(error: unknown): boolean {
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT") || message.includes("ECONNREFUSED");
}

function isDaemonStopUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("route not found: POST /daemon/stop") || message.includes("daemon stop is not enabled");
}

async function listSocketOwnerPids(socketPath: string): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    execFile("lsof", ["-t", socketPath], (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException | { code?: unknown }).code;
        if (code === 1) {
          resolve([]);
          return;
        }
        if (code === "ENOENT") {
          reject(new Error("restart 的兼容降级依赖 lsof，但当前环境里没找到它。"));
          return;
        }
        reject(error);
        return;
      }

      const pids = String(stdout)
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(Array.from(new Set(pids)));
    });
  });
}

async function stopLegacyDaemonBySocketOwner(socketPath: string): Promise<boolean> {
  if (isNamedPipeEndpoint(socketPath)) {
    throw new Error("Windows 命名管道不支持通过 socket owner 兜底停止旧 daemon。");
  }
  const pids = await listSocketOwnerPids(socketPath);
  let signaled = false;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      signaled = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | { code?: unknown }).code;
      if (code !== "ESRCH") {
        throw error;
      }
    }
  }
  return signaled;
}

async function waitUntilSocketCanStart(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      await ensureSocketAvailable(socketPath);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ipc server already running")) {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`等待旧 daemon 退出超时（${timeoutMs}ms）。它似乎还不想下班。`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("d-connect")
    .description("Bridge DingTalk to local coding agents")
    .showHelpAfterError();

  program
    .command("start")
    .description("启动守护进程")
    .option("-c, --config <path>", "config.json 路径")
    .action(async (opts: { config?: string }) => {
      await startDaemon({ explicitConfigPath: opts.config });
    });

  program
    .command("restart")
    .description("重启守护进程")
    .option("-c, --config <path>", "config.json 路径")
    .action(async (opts: { config?: string }) => {
      const socketPath = await resolveSocketPath({ configPath: opts.config });
      let stopRequested = false;
      try {
        await ipcDaemonStop(socketPath);
        stopRequested = true;
      } catch (error) {
        if (isDaemonStopUnsupportedError(error)) {
          try {
            stopRequested = await stopLegacyDaemonBySocketOwner(socketPath);
          } catch {
            throw new Error(
              "当前 daemon 版本不支持 stop 接口，兼容降级也失败了；请先手动停止旧进程，再重试 restart。",
            );
          }
          if (!stopRequested) {
            throw new Error(
              "当前 daemon 版本不支持 stop 接口，而且没有进程占用这个 IPC socket；请先确认旧进程状态，再手动处理后重试。",
            );
          }
        } else if (!isIpcUnavailableError(error)) {
          throw error;
        }
      }

      if (stopRequested) {
        await waitUntilSocketCanStart(socketPath);
      }

      await startDaemon({ explicitConfigPath: opts.config });
    });

  program
    .command("init")
    .description("Create config.json with interactive wizard")
    .option("-c, --config <path>", "Path to config.json")
    .option("-f, --force", "Overwrite existing config file")
    .option("-y, --yes", "Use defaults and skip interactive prompts")
    .action(async (opts: { config?: string; force?: boolean; yes?: boolean }) => {
      const result = await initConfig({
        explicitConfigPath: opts.config,
        force: Boolean(opts.force),
        yes: Boolean(opts.yes),
      });
      const operation = result.overwritten ? "updated" : "created";
      console.log(`config ${operation} at ${result.configPath}`);
    });

  program
    .command("add")
    .description("Add one project to existing config.json")
    .option("-c, --config <path>", "Path to config.json")
    .option("-y, --yes", "Use defaults and skip interactive prompts")
    .action(async (opts: { config?: string; yes?: boolean }) => {
      const result = await addProjectConfig({
        explicitConfigPath: opts.config,
        yes: Boolean(opts.yes),
      });
      console.log(`project ${result.projectName} added to ${result.configPath}`);
    });

  program
    .command("send")
    .description("Send one message to a project session")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-s, --session-key <key>", "Session key")
    .option("-c, --config <path>", "Path to config.json")
    .argument("<content...>", "Message content")
    .action(async (contentArgs: string[], opts: { project: string; sessionKey: string; config?: string }) => {
      const socketPath = await resolveSocketPath({
        configPath: opts.config,
        projectName: opts.project,
      });
      const content = contentArgs.join(" ").trim();
      const result = await ipcSend(socketPath, {
        project: opts.project,
        sessionKey: opts.sessionKey,
        content,
      });
      console.log(result.response);
    });

  const loop = program.command("loop").description("Manage loop jobs in daemon");

  loop
    .command("add")
    .description("Add loop job")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-s, --session-key <key>", "Session key")
    .requiredOption("-e, --expr <scheduleExpr>", "Schedule expression")
    .option("-d, --description <text>", "Description", "")
    .option("--silent", "Do not push result back to platform")
    .option("-c, --config <path>", "Path to config.json")
    .argument("<prompt...>", "Prompt for job")
    .action(
      async (
        promptArgs: string[],
        opts: { project: string; sessionKey: string; expr: string; description: string; silent?: boolean; config?: string },
      ) => {
        const socketPath = await resolveSocketPath({
          configPath: opts.config,
          projectName: opts.project,
        });
        const prompt = promptArgs.join(" ").trim();
        const job = await ipcLoopAdd(socketPath, {
          project: opts.project,
          sessionKey: opts.sessionKey,
          scheduleExpr: opts.expr,
          prompt,
          description: opts.description,
          silent: Boolean(opts.silent),
        });
        console.log(job.id);
      },
    );

  loop
    .command("list")
    .description("List loop jobs")
    .option("-p, --project <name>", "Project name")
    .option("-c, --config <path>", "Path to config.json")
    .action(async (opts: { project?: string; config?: string }) => {
      const socketPath = await resolveSocketPath({
        configPath: opts.config,
        projectName: opts.project,
      });
      const result = await ipcLoopList(socketPath, opts.project);
      for (const job of result.jobs) {
        console.log(`${job.id}\t${job.project}\t${job.sessionKey}\t${job.scheduleExpr}\t${job.prompt}`);
      }
    });

  loop
    .command("del")
    .description("Delete loop job")
    .requiredOption("-i, --id <id>", "Loop job id")
    .option("-c, --config <path>", "Path to config.json")
    .action(async (opts: { id: string; config?: string }) => {
      const socketPath = await resolveSocketPath({ configPath: opts.config });
      const result = await ipcLoopDel(socketPath, opts.id);
      if (!result.deleted) {
        throw new Error(`loop job not found: ${opts.id}`);
      }
      console.log(result.id);
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  await createCliProgram().parseAsync(argv);
}

export function handleCliError(error: unknown): never {
  printError(error);
  process.exit(1);
}
