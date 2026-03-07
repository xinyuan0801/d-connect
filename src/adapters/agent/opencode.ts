import { BaseCliAgentAdapter, type BaseAgentOptions } from "./base-cli.js";
import { Logger } from "../../logging.js";

export function createOpenCodeAdapter(options: BaseAgentOptions, logger: Logger): BaseCliAgentAdapter {
  return new BaseCliAgentAdapter("opencode", options, logger.child("opencode"));
}
