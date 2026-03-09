import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveIpcEndpoint } from "../src/ipc/endpoint.js";

const mockState = vi.hoisted(() => ({
  resolveAndLoadConfig: vi.fn(),
  startDaemon: vi.fn(),
  ipcDaemonStop: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/bootstrap/daemon.js", () => ({
  resolveAndLoadConfig: mockState.resolveAndLoadConfig,
  startDaemon: mockState.startDaemon,
}));

vi.mock("../src/ipc/client.js", () => ({
  ipcDaemonStop: mockState.ipcDaemonStop,
  ipcLoopAdd: vi.fn(),
  ipcLoopDel: vi.fn(),
  ipcLoopList: vi.fn(),
  ipcSend: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockState.execFile,
}));

import { createCliProgram } from "../src/bootstrap/cli.js";

describe("cli restart command", () => {
  const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-test" : "/tmp/d-connect-test";
  const configPath = process.platform === "win32" ? "C:\\tmp\\config.json" : "/tmp/config.json";
  const endpoint = resolveIpcEndpoint(dataDir);

  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockReset();
    mockState.startDaemon.mockReset();
    mockState.ipcDaemonStop.mockReset();
    mockState.execFile.mockReset();

    mockState.resolveAndLoadConfig.mockResolvedValue({
      config: {
        dataDir,
      },
      rawConfig: {},
      configPath,
    });
    mockState.startDaemon.mockResolvedValue(undefined);
  });

  test("restarts daemon through ipc stop then start", async () => {
    mockState.ipcDaemonStop.mockResolvedValue({
      stopping: true,
    });

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath]);

    expect(mockState.resolveAndLoadConfig).toHaveBeenCalledWith(configPath);
    expect(mockState.ipcDaemonStop).toHaveBeenCalledWith(endpoint);
    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
    });
  });

  test("starts daemon when ipc socket is unavailable", async () => {
    const unavailable = new Error(`connect ENOENT ${endpoint}`) as NodeJS.ErrnoException;
    unavailable.code = "ENOENT";
    mockState.ipcDaemonStop.mockRejectedValue(unavailable);

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath]);

    expect(mockState.ipcDaemonStop).toHaveBeenCalledWith(endpoint);
    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
    });
  });

  test("falls back to killing daemon socket owner when stop endpoint is unsupported", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("route not found: POST /daemon/stop"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "12345\n", "");
        return {} as any;
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
      expect(mockState.execFile).not.toHaveBeenCalled();
      expect(mockState.startDaemon).not.toHaveBeenCalled();
    } else {
      await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath]);

      expect(mockState.execFile).toHaveBeenCalledWith("lsof", ["-t", endpoint], expect.any(Function));
      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
      expect(mockState.startDaemon).toHaveBeenCalledWith({
        explicitConfigPath: configPath,
      });
    }

    killSpy.mockRestore();
  });
});

describe("cli start command", () => {
  const configPath = process.platform === "win32" ? "C:\\tmp\\config.json" : "/tmp/config.json";

  beforeEach(() => {
    mockState.startDaemon.mockReset();
    mockState.startDaemon.mockResolvedValue(undefined);
  });

  test("starts daemon with explicit config path", async () => {
    await createCliProgram().parseAsync(["node", "d-connect", "start", "-c", configPath]);

    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
    });
  });
});
