import { Logger } from "../../logging.js";
import type { AgentAdapter } from "../../runtime/types.js";
import type { ProjectConfig } from "../../config/schema.js";
import { createClaudeCodeAdapter } from "./claudecode.js";
import { createCodexAdapter } from "./codex.js";
import { createQoderAdapter } from "./qoder.js";
import { createOpenCodeAdapter } from "./opencode.js";
import { createIFlowAdapter } from "./iflow.js";
import type { BaseAgentOptions } from "./base-cli.js";

function toBaseOptions(value: Record<string, unknown>): BaseAgentOptions {
  const options: BaseAgentOptions = {};
  if (typeof value.cmd === "string") options.cmd = value.cmd;
  if (Array.isArray(value.args) && value.args.every((v) => typeof v === "string")) {
    options.args = value.args as string[];
  }
  if (typeof value.workDir === "string") options.workDir = value.workDir;
  if (typeof value.mode === "string") options.mode = value.mode;
  if (typeof value.model === "string") options.model = value.model;
  if (typeof value.promptArg === "string") options.promptArg = value.promptArg;
  if (typeof value.stdinPrompt === "boolean") options.stdinPrompt = value.stdinPrompt;

  if (value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.env as Record<string, unknown>)) {
      if (typeof v === "string") {
        env[k] = v;
      }
    }
    if (Object.keys(env).length > 0) {
      options.env = env;
    }
  }

  return options;
}

export function createAgentAdapter(project: ProjectConfig, logger: Logger): AgentAdapter {
  const options = toBaseOptions(project.agent.options as Record<string, unknown>);
  switch (project.agent.type) {
    case "claudecode":
      return createClaudeCodeAdapter(options, logger);
    case "codex":
      return createCodexAdapter(options, logger);
    case "qoder":
      return createQoderAdapter(options, logger);
    case "opencode":
      return createOpenCodeAdapter(options, logger);
    case "iflow":
      return createIFlowAdapter(options, logger);
    default:
      throw new Error(`unsupported agent type: ${project.agent.type}`);
  }
}

export * from "./base-cli.js";
export * from "./parsers.js";
