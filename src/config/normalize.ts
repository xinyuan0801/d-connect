import { join } from "node:path";
import { homedir } from "node:os";
import type { BaseAgentOptions } from "../core/agent-options.js";
import type { AppConfig, BaseAgentOptionsConfig, ProjectConfig } from "./schema.js";

export interface ResolvedAgentOptions extends BaseAgentOptions {
  cmd?: string;
  args?: string[];
  workDir?: string;
  mode?: string;
  model?: string;
  env?: Record<string, string>;
  promptArg?: string;
  stdinPrompt?: boolean;
}

export interface ResolvedAgentConfig {
  type: ProjectConfig["agent"]["type"];
  options: ResolvedAgentOptions;
}

export type ResolvedPlatformConfig = ProjectConfig["platforms"][number];

export interface ResolvedProjectConfig extends Omit<ProjectConfig, "agent" | "platforms"> {
  agent: ResolvedAgentConfig;
  platforms: ResolvedPlatformConfig[];
}

export interface ResolvedAppConfig extends Omit<AppConfig, "dataDir" | "projects"> {
  dataDir: string;
  projects: ResolvedProjectConfig[];
}

function normalizeAgentOptions(options: BaseAgentOptionsConfig): ResolvedAgentOptions {
  return {
    ...options,
    args: Array.isArray(options.args) ? [...options.args] : undefined,
    env: options.env ? { ...options.env } : undefined,
  };
}

function normalizePlatformConfig(platform: ProjectConfig["platforms"][number]): ResolvedPlatformConfig {
  if (platform.type === "dingtalk") {
    return {
      type: "dingtalk",
      options: {
        ...platform.options,
      },
    };
  }

  return {
    type: "feishu",
    options: {
      ...platform.options,
    },
  };
}

export function normalizeConfig(config: AppConfig): ResolvedAppConfig {
  return {
    ...config,
    dataDir: config.dataDir ?? join(homedir(), ".d-connect"),
    projects: config.projects.map((project) => ({
      ...project,
        agent: {
          type: project.agent.type,
          options: normalizeAgentOptions(project.agent.options),
        },
        platforms: project.platforms.map(normalizePlatformConfig),
      })),
  };
}
