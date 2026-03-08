import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig, normalizeConfig, resolveConfigPath } from "../src/config/index.js";

function validConfigJson(): string {
  return JSON.stringify(
    {
      configVersion: 1,
      log: { level: "info" },
      loop: { silent: false },
      projects: [
        {
          name: "p1",
          agent: {
            type: "qoder",
            options: {
              cmd: "qodercli",
            },
          },
          platforms: [
            {
              type: "dingtalk",
              options: {
                clientId: "ding-id",
                clientSecret: "ding-secret",
                allowFrom: "*",
              },
            },
          ],
        },
      ],
    },
    null,
    2,
  );
}

describe("config loader", () => {
  test("resolveConfigPath respects explicit > local > home", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });

    const explicit = join(root, "explicit.json");
    await writeFile(explicit, "{}\n", "utf8");

    const local = join(cwd, "config.json");
    await writeFile(local, "{}\n", "utf8");

    const homeConfig = join(home, ".d-connect", "config.json");
    await mkdir(join(home, ".d-connect"), { recursive: true });
    await writeFile(homeConfig, "{}\n", "utf8");

    expect(resolveConfigPath(explicit, { cwd, homeDir: home })).toBe(explicit);
    expect(resolveConfigPath(undefined, { cwd, homeDir: home })).toBe(local);

    // remove local to verify fallback to home
    await writeFile(local, "", "utf8");
    const noLocalCwd = join(root, "workspace2");
    await mkdir(noLocalCwd, { recursive: true });
    expect(resolveConfigPath(undefined, { cwd: noLocalCwd, homeDir: home })).toBe(homeConfig);
  });

  test("loadConfig parses valid json and defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    await writeFile(path, validConfigJson(), "utf8");

    const cfg = await loadConfig(path);
    expect(cfg.configVersion).toBe(1);
    expect(cfg.projects).toHaveLength(1);
    expect(cfg.projects[0]?.agent.type).toBe("qoder");
    expect(cfg.projects[0]?.platforms[0]?.options).toMatchObject({
      processingNotice: "处理中...",
    });
  });

  test("loadConfig supports feishu platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].platforms = [
      {
        type: "feishu",
        options: {
          appId: "cli_xxx",
          appSecret: "secret_xxx",
          allowFrom: "*",
          groupReplyAll: false,
        },
      },
    ];
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    expect(cfg.projects[0]?.platforms[0]?.type).toBe("feishu");
    expect(cfg.projects[0]?.platforms[0]?.options).toMatchObject({
      reactionEmoji: "OnIt",
    });
  });

  test("loadConfig rejects invalid agent type", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].agent.type = "unknown";
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("loadConfig rejects deprecated dataDir field", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.dataDir = "/tmp/legacy-d-connect";
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    await expect(loadConfig(path)).rejects.toThrow(/dataDir.*no longer supported/i);
  });

  test("loadConfig rejects duplicate project names", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects.push(payload.projects[0]);
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    await expect(loadConfig(path)).rejects.toThrow(/duplicate project name/i);
  });

  test("normalizeConfig keeps typed agent fields and passthrough extras", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].agent.options = {
      cmd: "claude",
      workDir: "/repo",
      allowedTools: ["Read", "Write"],
    };
    payload.projects[0].agent.type = "claudecode";
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    const resolved = normalizeConfig(cfg, { configPath: path });

    expect(resolved.projects[0]?.agent.options).toMatchObject({
      cmd: "claude",
      workDir: "/repo",
      allowedTools: ["Read", "Write"],
    });
    expect(resolved.dataDir).toBe(join(root, ".d-connect"));
  });

  test("normalizeConfig reuses config directory when config.json is already inside .d-connect", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const configDir = join(root, ".d-connect");
    const path = join(configDir, "config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(path, validConfigJson(), "utf8");

    const cfg = await loadConfig(path);
    const resolved = normalizeConfig(cfg, { configPath: path });

    expect(resolved.dataDir).toBe(configDir);
  });
});
