import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildConfigFromAnswers, defaultInitAnswers, inferProjectNameFromWorkDir, initConfig } from "../src/config/init.js";
import { loadConfig, normalizeConfig } from "../src/config/index.js";

describe("init config", () => {
  test("buildConfigFromAnswers builds dingtalk project config", () => {
    const answers = {
      ...defaultInitAnswers(),
      projectName: "my-service",
      agentType: "claudecode" as const,
      agentCmd: "claude",
      agentWorkDir: "/tmp/repo",
      agentMode: "default",
      agentModel: "claude-sonnet-4-20250514",
      platformType: "dingtalk" as const,
      dingtalkClientId: "ding123",
      dingtalkClientSecret: "secret123",
      dingtalkProcessingNotice: "处理中...",
      allowFrom: "u1,u2",
    };

    const config = buildConfigFromAnswers(answers);
    expect(config).not.toHaveProperty("dataDir");
    expect(config.projects[0]?.agent.type).toBe("claudecode");
    expect(config.projects[0]?.agent.options).toMatchObject({
      workDir: "/tmp/repo",
      cmd: "claude",
      mode: "default",
      model: "claude-sonnet-4-20250514",
    });
    expect(config.projects[0]?.platforms[0]).toEqual({
      type: "dingtalk",
      options: {
        clientId: "ding123",
        clientSecret: "secret123",
        allowFrom: "u1,u2",
        processingNotice: "处理中...",
      },
    });
  });

  test("buildConfigFromAnswers builds feishu project config", () => {
    const answers = {
      ...defaultInitAnswers(),
      projectName: "feishu-service",
      agentType: "qoder" as const,
      agentCmd: "qodercli",
      agentWorkDir: "/tmp/repo2",
      agentMode: "default",
      agentModel: "",
      platformType: "feishu" as const,
      feishuAppId: "cli_123",
      feishuAppSecret: "app_secret",
      feishuGroupReplyAll: true,
      feishuReactionEmoji: "OnIt",
      allowFrom: "*",
    };

    const config = buildConfigFromAnswers(answers);
    expect(config).not.toHaveProperty("dataDir");
    expect(config.projects[0]?.agent.type).toBe("qoder");
    expect(config.projects[0]?.agent.options).toEqual({
      workDir: "/tmp/repo2",
      cmd: "qodercli",
      mode: "default",
    });
    expect(config.projects[0]?.platforms[0]).toEqual({
      type: "feishu",
      options: {
        appId: "cli_123",
        appSecret: "app_secret",
        allowFrom: "*",
        groupReplyAll: true,
        reactionEmoji: "OnIt",
      },
    });
  });

  test("inferProjectNameFromWorkDir sanitizes workspace name", () => {
    expect(inferProjectNameFromWorkDir("/tmp/my repo")).toBe("my-repo");
    expect(inferProjectNameFromWorkDir("")).toBe("my-backend");
    expect(inferProjectNameFromWorkDir("/", "fallback")).toBe("fallback");
  });

  test("initConfig writes default config with --yes", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-init-"));
    const homeDir = join(root, "home");
    const cwd = join(root, "workspace");
    const configPath = join(root, "config.json");

    const result = await initConfig({
      explicitConfigPath: configPath,
      yes: true,
      cwd,
      homeDir,
    });

    expect(result.overwritten).toBe(false);
    expect(result.configPath).toBe(configPath);

    const rawFile = await readFile(configPath, "utf8");
    expect(rawFile).not.toContain("\"dataDir\"");

    const parsed = await loadConfig(configPath);
    const resolved = normalizeConfig(parsed, { configPath });
    expect(resolved.dataDir).toBe(join(root, ".d-connect"));
    expect(parsed.projects[0]?.name).toBe("workspace");
    expect(parsed.projects[0]?.agent.options).toMatchObject({
      workDir: cwd,
      cmd: "claude",
    });
  });

  test("initConfig rejects existing file unless force=true", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-init-"));
    const configPath = join(root, "config.json");
    await writeFile(configPath, "{\n  \"old\": true\n}\n", "utf8");

    await expect(
      initConfig({
        explicitConfigPath: configPath,
        yes: true,
      }),
    ).rejects.toThrow(/already exists/i);

    const forced = await initConfig({
      explicitConfigPath: configPath,
      yes: true,
      force: true,
    });
    expect(forced.overwritten).toBe(true);

    const file = await readFile(configPath, "utf8");
    expect(file).toContain("\"configVersion\": 1");
  });
});
