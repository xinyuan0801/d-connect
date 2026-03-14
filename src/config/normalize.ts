import { basename, dirname, join } from "node:path";
import type { BaseAgentOptions } from "../core/agent-options.js";
import type { AppConfig, BaseAgentOptionsConfig, ProjectConfig } from "./schema.js";

export interface ResolvedAgentOptions extends BaseAgentOptions {
  cmd?: string;
  args?: string[];
  workDir?: string;
  model?: string;
  env?: Record<string, string>;
  promptArg?: string;
  stdinPrompt?: boolean;
}

export interface ResolvedAgentConfig {
  type: ProjectConfig["agent"]["type"];
  options: ResolvedAgentOptions;
}

export interface ResolvedGuardConfig {
  enabled: boolean;
  rules?: string;
}

export type ResolvedPlatformConfig = ProjectConfig["platforms"][number];

export interface ResolvedProjectConfig extends Omit<ProjectConfig, "agent" | "platforms" | "guard"> {
  agent: ResolvedAgentConfig;
  guard: ResolvedGuardConfig;
  platforms: ResolvedPlatformConfig[];
}

export interface ResolvedAppConfig extends Omit<AppConfig, "projects"> {
  dataDir: string;
  projects: ResolvedProjectConfig[];
}

export interface NormalizeConfigOptions {
  configPath?: string;
  cwd?: string;
}

function normalizeAgentOptions(options: BaseAgentOptionsConfig): ResolvedAgentOptions {
  return {
    ...options,
    args: Array.isArray(options.args) ? [...options.args] : undefined,
    env: options.env ? { ...options.env } : undefined,
  };
}

function normalizePlatformConfig(platform: ProjectConfig["platforms"][number]): ResolvedPlatformConfig {
  switch (platform.type) {
    case "dingtalk":
      return {
        type: "dingtalk",
        options: {
          ...platform.options,
        },
      };
    case "discord":
      return {
        type: "discord",
        options: {
          ...platform.options,
        },
      };
    default:
      throw new Error(`unsupported platform type: ${String((platform as { type: unknown }).type)}`);
  }
}

function normalizeGuardConfig(project: ProjectConfig): ResolvedGuardConfig {
  return {
    enabled: project.guard.enabled,
    rules: project.guard.rules,
  };
}

export function resolveDataDir(configPath?: string, cwd = process.cwd()): string {
  const baseDir = configPath ? dirname(configPath) : cwd;
  if (basename(baseDir) === ".d-connect") {
    return baseDir;
  }
  return join(baseDir, ".d-connect");
}

export function normalizeConfig(config: AppConfig, options: NormalizeConfigOptions = {}): ResolvedAppConfig {
  return {
    ...config,
    dataDir: resolveDataDir(options.configPath, options.cwd),
    projects: config.projects.map((project) => ({
      ...project,
      agent: {
        type: project.agent.type,
        options: normalizeAgentOptions(project.agent.options),
      },
      guard: normalizeGuardConfig(project),
      platforms: project.platforms.map(normalizePlatformConfig),
    })),
  };
}
