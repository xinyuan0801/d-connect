import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const daemonMock = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(),
  fileExists: vi.fn(),
  bootstrapConfig: vi.fn(),
  loadConfig: vi.fn(),
  normalizeConfig: vi.fn(),
}));

vi.mock("../src/config/index.js", () => ({
  resolveConfigPath: daemonMock.resolveConfigPath,
  fileExists: daemonMock.fileExists,
  bootstrapConfig: daemonMock.bootstrapConfig,
  loadConfig: daemonMock.loadConfig,
  normalizeConfig: daemonMock.normalizeConfig,
}));

import { resolveAndLoadConfig } from "../src/bootstrap/daemon.js";

describe("resolveAndLoadConfig", () => {
  const configPath = process.platform === "win32" ? "C:\\tmp\\config.json" : "/tmp/config.json";

  beforeEach(() => {
    daemonMock.resolveConfigPath.mockReset();
    daemonMock.fileExists.mockReset();
    daemonMock.bootstrapConfig.mockReset();
    daemonMock.loadConfig.mockReset();
    daemonMock.normalizeConfig.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("bootstraps config and throws when config file does not exist", async () => {
    daemonMock.resolveConfigPath.mockReturnValue(configPath);
    daemonMock.fileExists.mockResolvedValue(false);
    daemonMock.bootstrapConfig.mockResolvedValue(undefined);

    const error = await resolveAndLoadConfig(configPath).then(
      () => null,
      (value) => value,
    );

    expect(error).toBeInstanceOf(Error);
    expect(daemonMock.resolveConfigPath).toHaveBeenCalledWith(configPath);
    expect(daemonMock.fileExists).toHaveBeenCalledWith(configPath);
    expect(daemonMock.bootstrapConfig).toHaveBeenCalledWith(configPath);
    expect(daemonMock.loadConfig).not.toHaveBeenCalled();
    expect(error?.message).toContain(`已在 ${configPath} 创建配置文件`);
    expect(error?.message).toContain("先改完配置再启动 d-connect");
  });

  test("loads and normalizes existing config", async () => {
    const rawConfig = { some: "config" };
    const normalizedConfig = {
      configVersion: 1,
      projects: [],
      dataDir: "/tmp/.d-connect",
      log: { level: "info" },
      loop: { silent: false },
    };

    daemonMock.resolveConfigPath.mockReturnValue(configPath);
    daemonMock.fileExists.mockResolvedValue(true);
    daemonMock.loadConfig.mockResolvedValue(rawConfig);
    daemonMock.normalizeConfig.mockReturnValue(normalizedConfig);

    const result = await resolveAndLoadConfig(configPath);

    expect(result).toEqual({
      config: normalizedConfig,
      rawConfig,
      configPath,
    });
    expect(daemonMock.loadConfig).toHaveBeenCalledWith(configPath);
    expect(daemonMock.normalizeConfig).toHaveBeenCalledWith(rawConfig, { configPath });
  });
});
