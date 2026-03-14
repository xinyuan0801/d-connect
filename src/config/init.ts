import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { fileExists, resolveConfigPath } from "./loader.js";
import type { AppConfig } from "./schema.js";
import { runInitTui } from "./init-tui.js";
import { ensureDir } from "../infra/store-json/atomic.js";

type AgentType = "claudecode" | "qoder" | "iflow";
type PlatformType = "dingtalk" | "discord";
type LogLevel = "debug" | "info" | "warn" | "error";

export interface InitAnswers {
  projectName: string;
  logLevel: LogLevel;
  loopSilent: boolean;
  agentType: AgentType;
  agentCmd: string;
  agentWorkDir: string;
  agentModel: string;
  platformType: PlatformType;
  allowFrom: string;
  dingtalkClientId: string;
  dingtalkClientSecret: string;
  dingtalkProcessingNotice: string;
  discordBotToken: string;
  discordRequireMention: boolean;
}

export interface InitConfigOptions {
  explicitConfigPath?: string;
  force?: boolean;
  yes?: boolean;
  cwd?: string;
  homeDir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface InitConfigResult {
  configPath: string;
  overwritten: boolean;
}

function toNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`"${fieldName}" cannot be empty`);
  }
  return trimmed;
}

export function inferProjectNameFromWorkDir(workDir: string, fallback = "my-backend"): string {
  const trimmed = workDir.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const base = basename(trimmed);
  const candidate = base === "." || base === "/" || base === "\\" ? trimmed : base;
  const normalized = candidate.trim().replace(/\s+/g, "-");
  if (normalized.length === 0 || normalized === "/" || normalized === "\\") {
    return fallback;
  }

  return normalized;
}

export function defaultInitAnswers(opts: { cwd?: string } = {}): InitAnswers {
  const cwd = opts.cwd ?? process.cwd();

  return {
    projectName: inferProjectNameFromWorkDir(cwd),
    logLevel: "info",
    loopSilent: false,
    agentType: "claudecode",
    agentCmd: "claude",
    agentWorkDir: cwd,
    agentModel: "claude-sonnet-4-20250514",
    platformType: "dingtalk",
    allowFrom: "*",
    dingtalkClientId: "dingxxxx",
    dingtalkClientSecret: "xxxx",
    dingtalkProcessingNotice: "处理中...",
    discordBotToken: "",
    discordRequireMention: true,
  };
}

export function buildConfigFromAnswers(answers: InitAnswers): AppConfig {
  const normalized: InitAnswers = {
    ...answers,
    projectName: toNonEmpty(answers.projectName, "projectName"),
    agentCmd: toNonEmpty(answers.agentCmd, "agentCmd"),
    agentWorkDir: toNonEmpty(answers.agentWorkDir, "agentWorkDir"),
    allowFrom: toNonEmpty(answers.allowFrom, "allowFrom"),
    dingtalkClientId: answers.dingtalkClientId.trim(),
    dingtalkClientSecret: answers.dingtalkClientSecret.trim(),
    dingtalkProcessingNotice: answers.dingtalkProcessingNotice.trim(),
    discordBotToken: answers.discordBotToken.trim(),
    discordRequireMention: answers.discordRequireMention,
    agentModel: answers.agentModel.trim(),
  };

  const agentOptions: Record<string, unknown> = {
    workDir: normalized.agentWorkDir,
    cmd: normalized.agentCmd,
  };

  if (normalized.agentModel.length > 0) {
    agentOptions.model = normalized.agentModel;
  }

  const platformOptions =
    normalized.platformType === "discord"
      ? {
        type: "discord" as const,
        options: {
          botToken: toNonEmpty(normalized.discordBotToken, "discordBotToken"),
          allowFrom: normalized.allowFrom,
          requireMention: normalized.discordRequireMention,
        },
      }
      : {
        type: "dingtalk" as const,
        options: {
          clientId: toNonEmpty(normalized.dingtalkClientId, "dingtalkClientId"),
          clientSecret: toNonEmpty(normalized.dingtalkClientSecret, "dingtalkClientSecret"),
          allowFrom: normalized.allowFrom,
          processingNotice: toNonEmpty(normalized.dingtalkProcessingNotice, "dingtalkProcessingNotice"),
        },
      };

  return {
    configVersion: 1,
    log: {
      level: normalized.logLevel,
    },
    loop: {
      silent: normalized.loopSilent,
    },
    projects: [
      {
        name: normalized.projectName,
        agent: {
          type: normalized.agentType,
          options: agentOptions,
        },
        guard: {
          enabled: false,
        },
        platforms: [platformOptions],
      },
    ],
  };
}

export async function initConfig(options: InitConfigOptions = {}): Promise<InitConfigResult> {
  const configPath = resolveConfigPath(options.explicitConfigPath, {
    cwd: options.cwd,
    homeDir: options.homeDir,
  });

  const exists = await fileExists(configPath);
  if (exists && !options.force) {
    throw new Error(`config already exists at ${configPath}; use --force to overwrite`);
  }

  const defaults = defaultInitAnswers({
    cwd: options.cwd,
  });

  const answers = options.yes
    ? defaults
    : await runInitTui({
      defaults,
      configPath,
      overwritten: exists,
      stdin: options.stdin ?? processStdin,
      stdout: options.stdout ?? processStdout,
      deriveProjectName: inferProjectNameFromWorkDir,
    });

  const config = buildConfigFromAnswers(answers);
  await ensureDir(dirname(configPath));
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    configPath,
    overwritten: exists,
  };
}
