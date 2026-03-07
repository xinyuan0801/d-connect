#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import { ipcCronAdd, ipcCronDel, ipcCronList, ipcSend } from "./ipc/client.js";
import { resolveAndLoadConfig, startApp } from "./app.js";

async function resolveSocketPath(configPath?: string): Promise<string> {
  const { config } = await resolveAndLoadConfig(configPath);
  return join(config.dataDir!, "ipc.sock");
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
}

const program = new Command();
program
  .name("d-connect")
  .description("Bridge DingTalk to local coding agents")
  .showHelpAfterError();

program
  .command("start")
  .description("Start daemon")
  .option("-c, --config <path>", "Path to config.json")
  .action(async (opts: { config?: string }) => {
    await startApp({ explicitConfigPath: opts.config });
  });

program
  .command("send")
  .description("Send one message to a project session")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-s, --session-key <key>", "Session key")
  .option("-c, --config <path>", "Path to config.json")
  .argument("<content...>", "Message content")
  .action(async (contentArgs: string[], opts: { project: string; sessionKey: string; config?: string }) => {
    const socketPath = await resolveSocketPath(opts.config);
    const content = contentArgs.join(" ").trim();
    const result = await ipcSend(socketPath, {
      project: opts.project,
      sessionKey: opts.sessionKey,
      content,
    });
    console.log(result.response);
  });

const cron = program.command("cron").description("Manage cron jobs in daemon");

cron
  .command("add")
  .description("Add cron job")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-s, --session-key <key>", "Session key")
  .requiredOption("-e, --expr <cronExpr>", "Cron expression")
  .option("-d, --description <text>", "Description", "")
  .option("--silent", "Do not push result back to platform")
  .option("-c, --config <path>", "Path to config.json")
  .argument("<prompt...>", "Prompt for job")
  .action(
    async (
      promptArgs: string[],
      opts: { project: string; sessionKey: string; expr: string; description: string; silent?: boolean; config?: string },
    ) => {
      const socketPath = await resolveSocketPath(opts.config);
      const prompt = promptArgs.join(" ").trim();
      const job = await ipcCronAdd(socketPath, {
        project: opts.project,
        sessionKey: opts.sessionKey,
        cronExpr: opts.expr,
        prompt,
        description: opts.description,
        silent: Boolean(opts.silent),
      });
      console.log(job.id);
    },
  );

cron
  .command("list")
  .description("List cron jobs")
  .option("-p, --project <name>", "Project name")
  .option("-c, --config <path>", "Path to config.json")
  .action(async (opts: { project?: string; config?: string }) => {
    const socketPath = await resolveSocketPath(opts.config);
    const result = await ipcCronList(socketPath, opts.project);
    for (const job of result.jobs) {
      console.log(`${job.id}\t${job.project}\t${job.sessionKey}\t${job.cronExpr}\t${job.prompt}`);
    }
  });

cron
  .command("del")
  .description("Delete cron job")
  .requiredOption("-i, --id <id>", "Cron job id")
  .option("-c, --config <path>", "Path to config.json")
  .action(async (opts: { id: string; config?: string }) => {
    const socketPath = await resolveSocketPath(opts.config);
    const result = await ipcCronDel(socketPath, opts.id);
    if (!result.deleted) {
      throw new Error(`cron job not found: ${opts.id}`);
    }
    console.log(result.id);
  });

program.parseAsync(process.argv).catch((error) => {
  printError(error);
  process.exit(1);
});
