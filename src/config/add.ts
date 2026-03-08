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
  reusedDingTalkConfig: boolean;
}

interface DingTalkDefaults {
  allowFrom: string;
  dingtalkClientId: string;
  dingtalkClientSecret: string;
  dingtalkProcessingNotice: string;
}

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

export function findReusableDingTalkDefaults(config: AppConfig): DingTalkDefaults | undefined {
  for (const project of config.projects) {
    for (const platform of project.platforms) {
      if (platform.type === "dingtalk") {
        return {
          allowFrom: platform.options.allowFrom,
          dingtalkClientId: platform.options.clientId,
          dingtalkClientSecret: platform.options.clientSecret,
          dingtalkProcessingNotice: platform.options.processingNotice,
        };
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

  const reusableDingTalk = findReusableDingTalkDefaults(config);
  if (reusableDingTalk) {
    defaults.allowFrom = reusableDingTalk.allowFrom;
    defaults.dingtalkClientId = reusableDingTalk.dingtalkClientId;
    defaults.dingtalkClientSecret = reusableDingTalk.dingtalkClientSecret;
    defaults.dingtalkProcessingNotice = reusableDingTalk.dingtalkProcessingNotice;
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
      promptDingTalkCredentials: !reusableDingTalk,
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
    reusedDingTalkConfig: Boolean(reusableDingTalk),
  };
}
