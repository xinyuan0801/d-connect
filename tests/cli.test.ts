import { beforeEach, describe, expect, test, vi } from "vitest";

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
  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockReset();
    mockState.startDaemon.mockReset();
    mockState.ipcDaemonStop.mockReset();
    mockState.execFile.mockReset();

    mockState.resolveAndLoadConfig.mockResolvedValue({
      config: {
        dataDir: "/tmp/d-connect-test",
      },
      rawConfig: {},
      configPath: "/tmp/config.json",
    });
    mockState.startDaemon.mockResolvedValue(undefined);
  });

  test("restarts daemon through ipc stop then start", async () => {
    mockState.ipcDaemonStop.mockResolvedValue({
      stopping: true,
    });

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", "/tmp/config.json"]);

    expect(mockState.resolveAndLoadConfig).toHaveBeenCalledWith("/tmp/config.json");
    expect(mockState.ipcDaemonStop).toHaveBeenCalledWith("/tmp/d-connect-test/ipc.sock");
    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: "/tmp/config.json",
    });
  });

  test("starts daemon when ipc socket is unavailable", async () => {
    const unavailable = new Error("connect ENOENT /tmp/d-connect-test/ipc.sock") as NodeJS.ErrnoException;
    unavailable.code = "ENOENT";
    mockState.ipcDaemonStop.mockRejectedValue(unavailable);

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", "/tmp/config.json"]);

    expect(mockState.ipcDaemonStop).toHaveBeenCalledWith("/tmp/d-connect-test/ipc.sock");
    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: "/tmp/config.json",
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

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", "/tmp/config.json"]);

    expect(mockState.execFile).toHaveBeenCalledWith("lsof", ["-t", "/tmp/d-connect-test/ipc.sock"], expect.any(Function));
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: "/tmp/config.json",
    });

    killSpy.mockRestore();
  });
});
