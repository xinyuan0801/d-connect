import { BaseCliAgentAdapter, type BaseAgentOptions } from "./base-cli.js";
import { Logger } from "../../logging.js";

export function createClaudeCodeAdapter(options: BaseAgentOptions, logger: Logger): BaseCliAgentAdapter {
  return new BaseCliAgentAdapter("claudecode", options, logger.child("claudecode"));
}
