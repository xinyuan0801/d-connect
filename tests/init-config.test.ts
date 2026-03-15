import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildConfigFromAnswers, defaultInitAnswers, inferProjectNameFromWorkDir, initConfig } from "../src/config/init.js";
import { loadConfig, normalizeConfig } from "../src/config/index.js";

const initMocks = vi.hoisted(() => ({
  runInitTui: vi.fn(),
}));

vi.mock("../src/config/init-tui.js", () => ({
  runConfigWizard: initMocks.runInitTui,
  runInitTui: initMocks.runInitTui,
}));

describe("init config", () => {
  beforeEach(() => {
    initMocks.runInitTui.mockReset();
  });

  test("buildConfigFromAnswers builds dingtalk project config", () => {
    const answers = {
      ...defaultInitAnswers(),
      projectName: "my-service",
      agentType: "claudecode" as const,
      agentCmd: "claude",
      agentWorkDir: "/tmp/repo",
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
    expect(config.projects[0]?.guard).toEqual({
      enabled: false,
    });
  });

  test("buildConfigFromAnswers builds discord project config", () => {
    const config = buildConfigFromAnswers({
      ...defaultInitAnswers(),
      projectName: "discord-service",
      agentType: "iflow",
      agentCmd: "iflow",
      agentWorkDir: "/tmp/repo",
      agentModel: "",
      platformType: "discord",
      allowFrom: "user-1,user-2",
      discordBotToken: "discord-bot-token",
      discordRequireMention: false,
    });

    expect(config.projects[0]?.platforms[0]).toEqual({
      type: "discord",
      options: {
        botToken: "discord-bot-token",
        allowFrom: "user-1,user-2",
        requireMention: false,
      },
    });
  });

  test("buildConfigFromAnswers omits model when using codex defaults", () => {
    const config = buildConfigFromAnswers({
      ...defaultInitAnswers(),
      projectName: "codex-service",
      agentType: "codex",
      agentCmd: "codex",
      agentWorkDir: "/tmp/repo",
      agentModel: "",
      platformType: "dingtalk",
      dingtalkClientId: "ding123",
      dingtalkClientSecret: "secret123",
      dingtalkProcessingNotice: "处理中...",
      allowFrom: "*",
    });

    expect(config.projects[0]?.agent).toEqual({
      type: "codex",
      options: {
        workDir: "/tmp/repo",
        cmd: "codex",
      },
    });
  });

  test("buildConfigFromAnswers supports opencode defaults", () => {
    const config = buildConfigFromAnswers({
      ...defaultInitAnswers(),
      projectName: "opencode-service",
      agentType: "opencode",
      agentCmd: "opencode",
      agentWorkDir: "/tmp/repo",
      agentModel: "",
      platformType: "dingtalk",
      dingtalkClientId: "ding123",
      dingtalkClientSecret: "secret123",
      dingtalkProcessingNotice: "处理中...",
      allowFrom: "*",
    });

    expect(config.projects[0]?.agent).toEqual({
      type: "opencode",
      options: {
        workDir: "/tmp/repo",
        cmd: "opencode",
      },
    });
  });

  test("inferProjectNameFromWorkDir sanitizes workspace name", () => {
    expect(inferProjectNameFromWorkDir("/tmp/my repo")).toBe("my-repo");
    expect(inferProjectNameFromWorkDir("")).toBe("my-backend");
    expect(inferProjectNameFromWorkDir("/", "fallback")).toBe("fallback");
    expect(inferProjectNameFromWorkDir(".", "fallback")).toBe(".");
    expect(inferProjectNameFromWorkDir("\\", "fallback")).toBe("fallback");
  });

  test("buildConfigFromAnswers rejects blank required fields", () => {
    expect(() =>
      buildConfigFromAnswers({
        ...defaultInitAnswers(),
        projectName: "",
        agentCmd: "claude",
        agentWorkDir: "/tmp/repo",
        allowFrom: "u1",
      }),
    ).toThrow('"projectName" cannot be empty');

    expect(() =>
      buildConfigFromAnswers({
        ...defaultInitAnswers(),
        projectName: "demo",
        agentCmd: "",
        agentWorkDir: "/tmp/repo",
        allowFrom: "u1",
      }),
    ).toThrow('"agentCmd" cannot be empty');

    expect(() =>
      buildConfigFromAnswers({
        ...defaultInitAnswers(),
        projectName: "demo",
        agentCmd: "claude",
        agentWorkDir: "",
        allowFrom: "u1",
      }),
    ).toThrow('"agentWorkDir" cannot be empty');
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
    expect(rawFile).not.toContain("\"mode\"");
    expect(rawFile).toContain("\"loop\":");

    const parsed = await loadConfig(configPath);
    const resolved = normalizeConfig(parsed, { configPath });
    expect(resolved.dataDir).toBe(join(root, ".d-connect"));
    expect(parsed.projects[0]?.name).toBe("workspace");
    expect(parsed.projects[0]?.agent.options).toMatchObject({
      workDir: cwd,
      cmd: "claude",
    });
    expect(parsed.projects[0]?.guard).toEqual({
      enabled: false,
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

  test("initConfig calls wizard when --yes is not set", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-init-wizard-"));
    const cwd = join(root, "workspace");
    const configPath = join(root, "config.json");
    const answers = {
      ...defaultInitAnswers({ cwd }),
      projectName: "wizard-demo",
      platformType: "discord" as const,
      discordBotToken: "discord-token",
      discordRequireMention: false,
    };
    initMocks.runInitTui.mockResolvedValue(answers);

    const result = await initConfig({
      explicitConfigPath: configPath,
      yes: false,
      cwd,
      stdin: process.stdin,
      stdout: process.stdout,
    });

    expect(initMocks.runInitTui).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: expect.objectContaining({
          projectName: "workspace",
          platformType: "dingtalk",
        }),
        configPath,
        overwritten: false,
      }),
    );
    expect(result.configPath).toBe(configPath);
    expect(result.overwritten).toBe(false);
  });
});
