import type { ResolvedProjectConfig } from "../../config/normalize.js";
import { Logger } from "../../logging.js";
import type { PlatformAdapter } from "../../core/types.js";
import { DingTalkAdapter, type DingTalkOptions } from "./dingtalk.js";
import { FeishuAdapter, type FeishuOptions } from "./feishu.js";

export function createPlatformAdapters(project: ResolvedProjectConfig, logger: Logger): PlatformAdapter[] {
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
