import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig, normalizeConfig, resolveConfigPath, resolveConfigPathByProject } from "../src/config/index.js";

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

  test("resolveConfigPathByProject finds unique local config.<name>.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });

    const payload = JSON.parse(validConfigJson());
    payload.projects[0].name = "claudecode-dingtalk";
    const localConfig = join(cwd, "config.claudecode-dingtalk.local.json");
    await writeFile(localConfig, `${JSON.stringify(payload)}\n`, "utf8");

    const result = await resolveConfigPathByProject("claudecode-dingtalk", { cwd, homeDir: home });
    expect(result).toEqual({
      status: "matched",
      path: localConfig,
    });
  });

  test("resolveConfigPathByProject prefers cwd config over home config when both match", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(home, ".d-connect"), { recursive: true });

    const payload = JSON.parse(validConfigJson());
    payload.projects[0].name = "shared-project";

    const localConfig = join(cwd, "config.shared.local.json");
    const homeConfig = join(home, ".d-connect", "config.json");
    await writeFile(localConfig, `${JSON.stringify(payload)}\n`, "utf8");
    await writeFile(homeConfig, `${JSON.stringify(payload)}\n`, "utf8");

    const result = await resolveConfigPathByProject("shared-project", { cwd, homeDir: home });
    expect(result).toEqual({
      status: "matched",
      path: localConfig,
    });
  });

  test("resolveConfigPathByProject reports ambiguity with multiple local matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });

    const payloadA = JSON.parse(validConfigJson());
    payloadA.projects[0].name = "dup-project";
    const payloadB = JSON.parse(validConfigJson());
    payloadB.projects[0].name = "dup-project";

    const configA = join(cwd, "config.a.json");
    const configB = join(cwd, "config.b.json");
    await writeFile(configA, `${JSON.stringify(payloadA)}\n`, "utf8");
    await writeFile(configB, `${JSON.stringify(payloadB)}\n`, "utf8");

    const result = await resolveConfigPathByProject("dup-project", { cwd, homeDir: home });
    expect(result).toEqual({
      status: "ambiguous",
      candidates: [configA, configB],
    });
  });

  test("resolveConfigPathByProject ignores invalid json files", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });

    await writeFile(join(cwd, "config.invalid.json"), "{not valid json}\n", "utf8");

    const payload = JSON.parse(validConfigJson());
    payload.projects[0].name = "valid-only";
    const goodConfig = join(cwd, "config.valid.json");
    await writeFile(goodConfig, `${JSON.stringify(payload)}\n`, "utf8");

    const result = await resolveConfigPathByProject("valid-only", { cwd, homeDir: home });
    expect(result).toEqual({
      status: "matched",
      path: goodConfig,
    });
  });

  test("loadConfig parses valid json and defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    await writeFile(path, validConfigJson(), "utf8");

    const cfg = await loadConfig(path);
    expect(cfg.configVersion).toBe(1);
    expect(cfg.projects).toHaveLength(1);
    expect(cfg.projects[0]?.agent.type).toBe("qoder");
    expect(cfg.projects[0]?.guard).toEqual({
      enabled: false,
    });
    expect(cfg.projects[0]?.platforms[0]?.options).toMatchObject({
      processingNotice: "处理中...",
    });
  });

  test("loadConfig parses discord platform defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].platforms = [
      {
        type: "discord",
        options: {
          botToken: "discord-token",
        },
      },
    ];
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    expect(cfg.projects[0]?.platforms[0]).toEqual({
      type: "discord",
      options: {
        botToken: "discord-token",
        allowFrom: "*",
        requireMention: true,
      },
    });
  });

  test("loadConfig rejects removed feishu platform", async () => {
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

    await expect(loadConfig(path)).rejects.toThrow();
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

  test("loadConfig still accepts legacy agent mode fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].agent.type = "iflow";
    payload.projects[0].agent.options = {
      cmd: "iflow",
      workDir: "/repo",
      mode: "plan",
    };
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    expect(cfg.projects[0]?.agent.options).toMatchObject({
      workDir: "/repo",
      mode: "plan",
    });
  });

  test("loadConfig accepts codex agent type with codex-specific passthrough options", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].agent.type = "codex";
    payload.projects[0].agent.options = {
      cmd: "codex",
      workDir: "/repo",
      mode: "full-auto",
      reasoning_effort: "high",
      search: true,
    };
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    const resolved = normalizeConfig(cfg, { configPath: path });

    expect(resolved.projects[0]?.agent).toEqual({
      type: "codex",
      options: {
        cmd: "codex",
        workDir: "/repo",
        mode: "full-auto",
        reasoning_effort: "high",
        search: true,
      },
    });
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
    expect(resolved.projects[0]?.guard).toEqual({
      enabled: false,
    });
    expect(resolved.dataDir).toBe(join(root, ".d-connect"));
  });

  test("normalizeConfig preserves args and env in agent.options", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].agent.type = "claudecode";
    payload.projects[0].agent.options = {
      workDir: "/repo",
      cmd: "claude",
      args: ["--verbose"],
      env: {
        FOO: "bar",
      },
      allowedTools: ["Read"],
    };
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    const resolved = normalizeConfig(cfg, { configPath: path });

    expect(resolved.projects[0]?.agent.options).toEqual({
      cmd: "claude",
      workDir: "/repo",
      args: ["--verbose"],
      env: {
        FOO: "bar",
      },
      allowedTools: ["Read"],
    });
  });

  test("normalizeConfig preserves custom guard rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-config-"));
    const path = join(root, "config.json");
    const payload = JSON.parse(validConfigJson());
    payload.projects[0].guard = {
      enabled: true,
      rules: "禁止执行 deploy 或生产变更。",
    };
    await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");

    const cfg = await loadConfig(path);
    const resolved = normalizeConfig(cfg, { configPath: path });

    expect(resolved.projects[0]?.guard).toEqual({
      enabled: true,
      rules: "禁止执行 deploy 或生产变更。",
    });
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
