import type { ProjectConfig } from "../../config/schema.js";
import { Logger } from "../../logging.js";
import type { PlatformAdapter } from "../../runtime/types.js";
import { DingTalkAdapter, type DingTalkOptions } from "./dingtalk.js";
import { FeishuAdapter, type FeishuOptions } from "./feishu.js";

export function createPlatformAdapters(project: ProjectConfig, logger: Logger): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];
  for (const platform of project.platforms) {
    switch (platform.type) {
      case "dingtalk": {
        adapters.push(new DingTalkAdapter(platform.options as DingTalkOptions, logger.child(`platform:${platform.type}`)));
        break;
      }
      case "feishu": {
        adapters.push(new FeishuAdapter(platform.options as FeishuOptions, logger.child(`platform:${platform.type}`)));
        break;
      }
      default:
        throw new Error(`unsupported platform type: ${String((platform as { type: unknown }).type)}`);
    }
  }
  return adapters;
}

export * from "./dingtalk.js";
export * from "./feishu.js";
