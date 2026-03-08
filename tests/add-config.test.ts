import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addProjectConfig } from "../src/config/add.js";
import { loadConfig } from "../src/config/index.js";

describe("add config", () => {
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

  test("addProjectConfig falls back to default DingTalk placeholders when config has no DingTalk project", async () => {
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
              name: "chat-bot",
              agent: {
                type: "qoder",
                options: {
                  workDir: "/srv/chat-bot",
                  cmd: "qodercli",
                },
              },
              platforms: [
                {
                  type: "feishu",
                  options: {
                    appId: "cli_123",
                    appSecret: "secret_123",
                    allowFrom: "*",
                    groupReplyAll: false,
                    reactionEmoji: "OnIt",
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
      cwd: "/srv/new-bot",
    });

    expect(result.projectName).toBe("new-bot");
    expect(result.reusedDingTalkConfig).toBe(false);

    const file = await readFile(configPath, "utf8");
    expect(file).toContain("\"clientId\": \"dingxxxx\"");
    expect(file).toContain("\"clientSecret\": \"xxxx\"");
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
});
