import { BaseCliAgentAdapter, type BaseAgentOptions } from "./base-cli.js";
import { Logger } from "../../logging.js";

export function createQoderAdapter(options: BaseAgentOptions, logger: Logger): BaseCliAgentAdapter {
  return new BaseCliAgentAdapter("qoder", options, logger.child("qoder"));
}
