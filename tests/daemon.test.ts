import { describe, expect, test } from "vitest";
import { findAllowAllWarningTargets, formatAllowAllWarning } from "../src/bootstrap/daemon.js";
import type { ResolvedAppConfig } from "../src/config/index.js";

function createConfig(allowFrom: string): ResolvedAppConfig {
  return {
    configVersion: 1,
    log: { level: "info" },
    loop: { silent: false },
    dataDir: "/tmp/.d-connect",
    projects: [
      {
        name: "demo-project",
        agent: {
          type: "qoder",
          options: {},
        },
        guard: {
          enabled: false,
        },
        platforms: [
          {
            type: "dingtalk",
            options: {
              clientId: "ding-id",
              clientSecret: "ding-secret",
              allowFrom,
              processingNotice: "处理中...",
            },
          },
          {
            type: "feishu",
            options: {
              appId: "cli_xxx",
              appSecret: "secret_xxx",
              allowFrom: "user-1,user-2",
              groupReplyAll: false,
              reactionEmoji: "OnIt",
            },
          },
        ],
      },
    ],
  };
}

describe("allowFrom wildcard warning", () => {
  test("collects platforms configured with allowFrom wildcard", () => {
    expect(findAllowAllWarningTargets(createConfig("*"))).toEqual([
      {
        projectName: "demo-project",
        platformType: "dingtalk",
      },
    ]);
  });

  test("formats an ascii warning block for wildcard targets", () => {
    const warning = formatAllowAllWarning([
      {
        projectName: "demo-project",
        platformType: "dingtalk",
      },
      {
        projectName: "ops-bot",
        platformType: "feishu",
      },
    ]);

    expect(warning).toContain("____  _   _ ___ _   _  ____");
    expect(warning).toContain("检测到 allowFrom = \"*\"：任何能连到这个机器人的用户都可能直接开聊。");
    expect(warning).toContain("如果这是共享群聊或公共环境，请先收紧 platform.options.allowFrom，再启动守护进程。");
    expect(warning).toContain("受影响的目标：");
    expect(warning).toContain("  - demo-project / dingtalk");
    expect(warning).toContain("  - ops-bot / feishu");
  });

  test("does not produce a warning when no wildcard target exists", () => {
    expect(findAllowAllWarningTargets(createConfig("user-1,user-2"))).toEqual([]);
    expect(formatAllowAllWarning([])).toBeUndefined();
  });
});
