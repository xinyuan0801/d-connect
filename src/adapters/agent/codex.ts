import { BaseCliAgentAdapter, type BaseAgentOptions } from "./base-cli.js";
import { Logger } from "../../logging.js";

export function createCodexAdapter(options: BaseAgentOptions, logger: Logger): BaseCliAgentAdapter {
  return new BaseCliAgentAdapter("codex", options, logger.child("codex"));
}
