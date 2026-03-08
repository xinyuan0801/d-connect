import { describe, expect, test } from "vitest";
import { createPlatformAdapters } from "../src/adapters/platform/index.js";
import { Logger } from "../src/logging.js";
import type { ResolvedProjectConfig } from "../src/config/normalize.js";

function createProject(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
  return {
    name: "demo",
    agent: {
      type: "iflow",
      options: {
        cmd: "iflow",
        workDir: "/repo/workdir",
      },
    },
    platforms: [
      {
        type: "dingtalk",
        options: {
          clientId: "ding-id",
          clientSecret: "ding-secret",
          allowFrom: "*",
          processingNotice: "处理中...",
        },
      },
    ],
    ...overrides,
  };
}

describe("platform adapters", () => {
  test("defaults DingTalk inbound media dir under agent workDir", () => {
    const [adapter] = createPlatformAdapters(createProject(), new Logger("error"));

    expect((adapter as { inboundMediaDir?: string }).inboundMediaDir).toBe("/repo/workdir/.d-connect/dingtalk-media");
  });

  test("preserves explicit DingTalk inbound media dir", () => {
    const [adapter] = createPlatformAdapters(
      createProject({
        platforms: [
          {
            type: "dingtalk",
            options: {
              clientId: "ding-id",
              clientSecret: "ding-secret",
              allowFrom: "*",
              processingNotice: "处理中...",
              inboundMediaDir: "/custom/media",
            },
          },
        ] as ResolvedProjectConfig["platforms"],
      }),
      new Logger("error"),
    );

    expect((adapter as { inboundMediaDir?: string }).inboundMediaDir).toBe("/custom/media");
  });
});
