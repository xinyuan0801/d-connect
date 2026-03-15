import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { defaultInitAnswers } from "../src/config/init.js";
import { addProjectConfig, ensureUniqueProjectName, findReusablePlatformDefaults } from "../src/config/add.js";
import { loadConfig } from "../src/config/index.js";

const addConfigMocks = vi.hoisted(() => ({
  runConfigWizard: vi.fn(),
}));

vi.mock("../src/config/init-tui.js", () => ({
  runConfigWizard: addConfigMocks.runConfigWizard,
}));

describe("add config", () => {
  beforeEach(() => {
    addConfigMocks.runConfigWizard.mockReset();
  });

  test("ensureUniqueProjectName appends numeric suffix when base name is taken", () => {
    const existing = ["api", "api-2", "api-3"];
    expect(ensureUniqueProjectName("api", existing)).toBe("api-4");
    expect(ensureUniqueProjectName("new", existing)).toBe("new");
  });

  test("findReusablePlatformDefaults returns first dingtalk or discord defaults", () => {
    const result = findReusablePlatformDefaults({
      configVersion: 1,
      log: { level: "info" },
      loop: { silent: false },
      projects: [
        {
          name: "demo-a",
          agent: { type: "claudecode", options: { workDir: "/tmp/a", cmd: "claude" } },
          guard: { enabled: false },
          platforms: [
            {
              type: "discord",
              options: {
                botToken: "discord-token",
                allowFrom: "user-a",
                requireMention: false,
              },
            },
          ],
        },
      ],
    } as const);

    expect(result).toEqual({
      platformType: "discord",
      allowFrom: "user-a",
      discordBotToken: "discord-token",
      discordRequireMention: false,
    });
  });

  test("findReusablePlatformDefaults returns undefined when projects have no platforms", () => {
    expect(
      findReusablePlatformDefaults({
        configVersion: 1,
        log: { level: "info" },
        loop: { silent: false },
        projects: [],
      }),
    ).toBeUndefined();
  });

  test("addProjectConfig appends a new project and reuses existing DingTalk settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-add-"));
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          configVersion: 1,
          log: { level: "warn" },
          loop: { silent: true },
          projects: [
            {
              name: "repo",
              agent: {
                type: "claudecode",
                options: {
                  workDir: "/srv/repo",
                  cmd: "claude",
                },
              },
              platforms: [
                {
                  type: "dingtalk",
                  options: {
                    clientId: "ding-app",
                    clientSecret: "ding-secret",
                    allowFrom: "u1,u2",
                    processingNotice: "处理中...",
                  },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await addProjectConfig({
      explicitConfigPath: configPath,
      yes: true,
      cwd: "/srv/repo",
    });

    expect(result.projectName).toBe("repo-2");
    expect(result.reusedPlatformConfig).toBe(true);
    expect(result.reusedDingTalkConfig).toBe(true);

    const updated = await loadConfig(configPath);
    expect(updated.projects).toHaveLength(2);
    expect(updated.projects[1]).toEqual({
      name: "repo-2",
      agent: {
        type: "claudecode",
        options: {
          workDir: "/srv/repo",
          cmd: "claude",
          model: "claude-sonnet-4-20250514",
        },
      },
      guard: {
        enabled: false,
      },
      platforms: [
        {
          type: "dingtalk",
          options: {
            clientId: "ding-app",
            clientSecret: "ding-secret",
            allowFrom: "u1,u2",
            processingNotice: "处理中...",
          },
        },
      ],
    });
  });

  test("addProjectConfig reuses existing Discord settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-add-"));
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          configVersion: 1,
          log: { level: "info" },
          loop: { silent: false },
          projects: [
            {
              name: "discord-repo",
              agent: {
                type: "iflow",
                options: {
                  workDir: "/srv/discord-repo",
                  cmd: "iflow",
                },
              },
              platforms: [
                {
                  type: "discord",
                  options: {
                    botToken: "discord-token",
                    allowFrom: "user-1",
                    requireMention: true,
                  },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await addProjectConfig({
      explicitConfigPath: configPath,
      yes: true,
      cwd: "/srv/discord-repo",
    });

    expect(result.projectName).toBe("discord-repo-2");
    expect(result.reusedPlatformConfig).toBe(true);
    expect(result.reusedDingTalkConfig).toBe(false);

    const updated = await loadConfig(configPath);
    expect(updated.projects[1]?.platforms[0]).toEqual({
      type: "discord",
      options: {
        botToken: "discord-token",
        allowFrom: "user-1",
        requireMention: true,
      },
    });
  });

  test("addProjectConfig rejects missing config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-add-"));
    const configPath = join(root, "missing.json");

    await expect(
      addProjectConfig({
        explicitConfigPath: configPath,
        yes: true,
      }),
    ).rejects.toThrow(/run "d-connect init/i);
  });

  test("addProjectConfig runs wizard path and reuses defaults for reused platforms", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-add-wizard-"));
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          configVersion: 1,
          log: { level: "info" },
          loop: { silent: false },
          projects: [
            {
              name: "repo",
              agent: {
                type: "codex",
                options: {
                  workDir: "/srv/repo",
                  cmd: "codex",
                },
              },
              platforms: [
                {
                  type: "dingtalk",
                  options: {
                    clientId: "ding-app",
                    clientSecret: "ding-secret",
                    allowFrom: "*",
                    processingNotice: "处理中...",
                  },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const wizardAnswers = {
      ...defaultInitAnswers({ cwd: "/srv/repo-new" }),
      projectName: "repo-new",
    };
    addConfigMocks.runConfigWizard.mockResolvedValue(wizardAnswers);

    const result = await addProjectConfig({
      explicitConfigPath: configPath,
      yes: false,
      cwd: "/srv/repo-new",
    });

    expect(result.projectName).toBe("repo-new");
    expect(result.reusedPlatformConfig).toBe(true);
    expect(addConfigMocks.runConfigWizard).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: expect.objectContaining({
          projectName: "repo-new",
        }),
        promptDingTalkCredentials: false,
        promptDiscordCredentials: true,
      }),
    );

    const updated = await loadConfig(configPath);
    expect(updated.projects.at(-1)?.platforms.at(0)?.type).toBe("dingtalk");
  });

  test("findReusablePlatformDefaults ignores unsupported platform types", () => {
    expect(
      findReusablePlatformDefaults({
        configVersion: 1,
        log: { level: "info" },
        loop: { silent: false },
        projects: [
          {
            name: "legacy",
            agent: {
              type: "claudecode",
              options: {
                workDir: "/srv/legacy",
                cmd: "claude",
              },
            },
            platforms: [
              {
                // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                type: "legacy" as any,
                // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                options: {},
              },
            ],
            guard: {
              enabled: false,
            },
          },
        ],
      } as any),
    ).toBeUndefined();
  });
});
