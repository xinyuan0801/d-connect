import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrapConfig, loadConfig, normalizeConfig } from "../src/config/index.js";

describe("bootstrap config template", () => {
  test("bootstrapConfig writes a complete default config that can be loaded and normalized", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-bootstrap-"));
    const configPath = join(root, "config.json");

    await bootstrapConfig(configPath);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.configVersion).toBe(1);
    expect(parsed.log).toEqual({ level: "info" });
    expect(parsed.loop).toEqual({ silent: false });
    expect(parsed.projects).toHaveLength(1);

    const loaded = await loadConfig(configPath);
    const normalized = normalizeConfig(loaded, { configPath });
    expect(normalized.dataDir).toBe(join(root, ".d-connect"));
    expect(normalized.projects[0]?.guard).toEqual({ enabled: false });
    expect(normalized.projects[0]?.platforms[0]?.type).toBe("dingtalk");
    expect(normalized.projects[0]?.agent.type).toBe("claudecode");
  });
});
