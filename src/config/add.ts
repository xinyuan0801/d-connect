import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { defaultInitAnswers, buildConfigFromAnswers, inferProjectNameFromWorkDir, type InitAnswers } from "./init.js";
import { fileExists, loadConfig, resolveConfigPath } from "./loader.js";
import type { AppConfig, ProjectConfig } from "./schema.js";
import { runConfigWizard } from "./init-tui.js";
import { ensureDir } from "../infra/store-json/atomic.js";

export interface AddConfigOptions {
  explicitConfigPath?: string;
  yes?: boolean;
  cwd?: string;
  homeDir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface AddConfigResult {
  configPath: string;
  projectName: string;
  reusedPlatformConfig: boolean;
  reusedDingTalkConfig: boolean;
}

interface DingTalkDefaults {
  platformType: "dingtalk";
  allowFrom: string;
  dingtalkClientId: string;
  dingtalkClientSecret: string;
  dingtalkProcessingNotice: string;
}

interface DiscordDefaults {
  platformType: "discord";
  allowFrom: string;
  discordBotToken: string;
  discordRequireMention: boolean;
}

type ReusablePlatformDefaults = DingTalkDefaults | DiscordDefaults;

export function ensureUniqueProjectName(projectName: string, existingNames: Iterable<string>): string {
  const usedNames = new Set(existingNames);
  if (!usedNames.has(projectName)) {
    return projectName;
  }

  let suffix = 2;
  while (usedNames.has(`${projectName}-${suffix}`)) {
    suffix += 1;
  }
  return `${projectName}-${suffix}`;
}

export function findReusablePlatformDefaults(config: AppConfig): ReusablePlatformDefaults | undefined {
  for (const project of config.projects) {
    for (const platform of project.platforms) {
      switch (platform.type) {
        case "dingtalk":
          return {
            platformType: "dingtalk",
            allowFrom: platform.options.allowFrom,
            dingtalkClientId: platform.options.clientId,
            dingtalkClientSecret: platform.options.clientSecret,
            dingtalkProcessingNotice: platform.options.processingNotice,
          };
        case "discord":
          return {
            platformType: "discord",
            allowFrom: platform.options.allowFrom,
            discordBotToken: platform.options.botToken,
            discordRequireMention: platform.options.requireMention,
          };
        default:
          break;
      }
    }
  }

  return undefined;
}

function buildProjectFromAnswers(answers: InitAnswers): ProjectConfig {
  return buildConfigFromAnswers(answers).projects[0]!;
}

export async function addProjectConfig(options: AddConfigOptions = {}): Promise<AddConfigResult> {
  const configPath = resolveConfigPath(options.explicitConfigPath, {
    cwd: options.cwd,
    homeDir: options.homeDir,
  });

  const exists = await fileExists(configPath);
  if (!exists) {
    throw new Error(`config file not found at ${configPath}; run "d-connect init -c ${configPath}" first`);
  }

  const config = await loadConfig(configPath);
  const existingNames = new Set(config.projects.map((project) => project.name));
  const deriveProjectName = (workDir: string, fallback?: string): string =>
    ensureUniqueProjectName(inferProjectNameFromWorkDir(workDir, fallback), existingNames);

  const defaults: InitAnswers = {
    ...defaultInitAnswers({ cwd: options.cwd }),
    projectName: deriveProjectName(options.cwd ?? process.cwd()),
  };

  const reusablePlatform = findReusablePlatformDefaults(config);
  if (reusablePlatform) {
    defaults.platformType = reusablePlatform.platformType;
    defaults.allowFrom = reusablePlatform.allowFrom;

    if (reusablePlatform.platformType === "dingtalk") {
      defaults.dingtalkClientId = reusablePlatform.dingtalkClientId;
      defaults.dingtalkClientSecret = reusablePlatform.dingtalkClientSecret;
      defaults.dingtalkProcessingNotice = reusablePlatform.dingtalkProcessingNotice;
    } else {
      defaults.discordBotToken = reusablePlatform.discordBotToken;
      defaults.discordRequireMention = reusablePlatform.discordRequireMention;
    }
  }

  const answers = options.yes
    ? defaults
    : await runConfigWizard({
      defaults,
      configPath,
      overwritten: true,
      stdin: options.stdin ?? processStdin,
      stdout: options.stdout ?? processStdout,
      deriveProjectName,
      mode: "add",
      promptDingTalkCredentials: reusablePlatform?.platformType !== "dingtalk",
      promptDiscordCredentials: reusablePlatform?.platformType !== "discord",
    });

  const nextConfig: AppConfig = {
    ...config,
    projects: [...config.projects, buildProjectFromAnswers(answers)],
  };

  await ensureDir(dirname(configPath));
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    configPath,
    projectName: answers.projectName,
    reusedPlatformConfig: Boolean(reusablePlatform),
    reusedDingTalkConfig: reusablePlatform?.platformType === "dingtalk",
  };
}
