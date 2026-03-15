import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveIpcEndpoint } from "../src/ipc/endpoint.js";

const mockState = vi.hoisted(() => ({
  resolveAndLoadConfig: vi.fn(),
  startDaemon: vi.fn(),
  ipcDaemonStop: vi.fn(),
  resolveConfigPathByProject: vi.fn(),
  initConfig: vi.fn(),
  addProjectConfig: vi.fn(),
  ipcSend: vi.fn(),
  ipcLoopAdd: vi.fn(),
  ipcLoopList: vi.fn(),
  ipcLoopDel: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/bootstrap/daemon.js", () => ({
  resolveAndLoadConfig: mockState.resolveAndLoadConfig,
  startDaemon: mockState.startDaemon,
}));

vi.mock("../src/config/index.js", () => ({
  resolveAndLoadConfig: mockState.resolveAndLoadConfig,
  resolveConfigPathByProject: mockState.resolveConfigPathByProject,
  initConfig: mockState.initConfig,
  addProjectConfig: mockState.addProjectConfig,
}));

vi.mock("../src/ipc/client.js", () => ({
  ipcSend: mockState.ipcSend,
  ipcDaemonStop: mockState.ipcDaemonStop,
  ipcLoopAdd: mockState.ipcLoopAdd,
  ipcLoopList: mockState.ipcLoopList,
  ipcLoopDel: mockState.ipcLoopDel,
}));

vi.mock("node:child_process", () => ({
  execFile: mockState.execFile,
}));

import { createCliProgram, handleCliError, runCli } from "../src/bootstrap/cli.js";

describe("cli restart command", () => {
  const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-test" : "/tmp/d-connect-test";
  const configPath = process.platform === "win32" ? "C:\\tmp\\config.json" : "/tmp/config.json";
  const endpoint = resolveIpcEndpoint(dataDir);

  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockReset();
    mockState.startDaemon.mockReset();
    mockState.ipcDaemonStop.mockReset();
    mockState.resolveConfigPathByProject.mockReset();
    mockState.initConfig.mockReset();
    mockState.addProjectConfig.mockReset();
    mockState.ipcSend.mockReset();
    mockState.ipcLoopAdd.mockReset();
    mockState.ipcLoopList.mockReset();
    mockState.ipcLoopDel.mockReset();
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

  test("fails restart if legacy stop fallback finds no socket owner", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("route not found: POST /daemon/stop"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "", "");
        return {} as any;
      },
    );

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
      return;
    }

    await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
      /没有进程占用这个 IPC socket/,
    );
  });

  test("treats lsof exit code 1 as no socket owner", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("route not found: POST /daemon/stop"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        const error = new Error("no entries") as NodeJS.ErrnoException;
        error.code = 1;
        callback(error, "", "");
        return {} as any;
      },
    );

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
      return;
    }

    await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
      /没有进程占用这个 IPC socket/,
    );
    expect(mockState.execFile).toHaveBeenCalledWith("lsof", ["-t", endpoint], expect.any(Function));
    expect(mockState.startDaemon).not.toHaveBeenCalled();
  });

  test("surfaces compatible fallback error when lsof missing", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("daemon stop is not enabled"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        const error = new Error("missing lsof") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error, "", "");
        return {} as any;
      },
    );

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
      return;
    }

    await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
      /兼容降级也失败了/,
    );
    expect(mockState.execFile).toHaveBeenCalledWith("lsof", ["-t", endpoint], expect.any(Function));
  });

  test("rejects restart when stop endpoint error is unexpected", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("service unavailable"));

    await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
      "service unavailable",
    );
  });

  test("throws a compatible error when legacy stop fallback cannot signal owners", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("route not found: POST /daemon/stop"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "99\n", "");
        return {} as any;
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
    } else {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /兼容降级也失败了/,
      );
    }

    killSpy.mockRestore();
  });
});

describe("cli error handling", () => {
  test("handleCliError prints and exits", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    handleCliError(new Error("fatal"));

    expect(logSpy).toHaveBeenCalledWith("fatal");
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("cli send command", () => {
  const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-send" : "/tmp/d-connect-send";
  const configPath = process.platform === "win32" ? "C:\\tmp\\config-send.json" : "/tmp/config-send.json";
  const endpoint = resolveIpcEndpoint(dataDir);

  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockResolvedValue({
      config: {
        dataDir,
      },
      rawConfig: {},
      configPath,
    });
  });

  test("sends joined content through ipc and prints response", async () => {
    mockState.ipcSend.mockResolvedValue({
      project: "demo",
      sessionKey: "s1",
      sessionId: "sid-1",
      response: "pong",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createCliProgram().parseAsync(["node", "d-connect", "send", "-p", "demo", "-s", "s1", "-c", configPath, "hello", "world"]);

    expect(mockState.ipcSend).toHaveBeenCalledWith(endpoint, {
      project: "demo",
      sessionKey: "s1",
      content: "hello world",
    });
    expect(logSpy).toHaveBeenCalledWith("pong");
    logSpy.mockRestore();
  });

  test("resolves config path by project when config is omitted", async () => {
    mockState.resolveConfigPathByProject.mockResolvedValue({
      status: "matched",
      path: configPath,
    });
    mockState.ipcSend.mockResolvedValue({
      project: "demo",
      sessionKey: "s1",
      sessionId: "sid-1",
      response: "ok",
    });

    await createCliProgram().parseAsync(["node", "d-connect", "send", "-p", "demo", "-s", "s1", "hello"]);

    expect(mockState.resolveConfigPathByProject).toHaveBeenCalledWith("demo");
    expect(mockState.resolveAndLoadConfig).toHaveBeenCalledWith(configPath);
    expect(mockState.ipcSend).toHaveBeenCalledWith(endpoint, {
      project: "demo",
      sessionKey: "s1",
      content: "hello",
    });
  });

  test("fails when project config lookup is ambiguous", async () => {
    mockState.resolveConfigPathByProject.mockResolvedValue({
      status: "ambiguous",
      candidates: ["/tmp/config-a.json", "/tmp/config-b.json"],
    });

    await expect(
      createCliProgram().parseAsync(["node", "d-connect", "send", "-p", "demo", "-s", "s1", "hello"]),
    ).rejects.toThrow(/有多个配置文件都包含项目 "demo"/);
  });
});

describe("cli loop command", () => {
  const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-loop" : "/tmp/d-connect-loop";
  const configPath = process.platform === "win32" ? "C:\\tmp\\config-loop.json" : "/tmp/config-loop.json";
  const endpoint = resolveIpcEndpoint(dataDir);

  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockResolvedValue({
      config: {
        dataDir,
      },
      rawConfig: {},
      configPath,
    });
    mockState.ipcLoopAdd.mockResolvedValue({
      id: "job-1",
      project: "demo",
      sessionKey: "s1",
      scheduleExpr: "*/5 * * * * *",
      prompt: "ping",
      description: "",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("adds a loop job and prints its id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createCliProgram().parseAsync([
      "node",
      "d-connect",
      "loop",
      "add",
      "-p",
      "demo",
      "-s",
      "s1",
      "-e",
      "*/5 * * * * *",
      "--description",
      "test job",
      "--silent",
      "-c",
      configPath,
      "ping",
    ]);

    expect(mockState.ipcLoopAdd).toHaveBeenCalledWith(endpoint, {
      project: "demo",
      sessionKey: "s1",
      scheduleExpr: "*/5 * * * * *",
      prompt: "ping",
      description: "test job",
      silent: true,
    });
    expect(logSpy).toHaveBeenCalledWith("job-1");
    logSpy.mockRestore();
  });

  test("lists loop jobs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockState.ipcLoopList.mockResolvedValue({
      jobs: [
        {
          id: "job-1",
          project: "demo",
          sessionKey: "s1",
          scheduleExpr: "*/5 * * * * *",
          prompt: "ping",
          description: "",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await createCliProgram().parseAsync(["node", "d-connect", "loop", "list", "-p", "demo", "-c", configPath]);

    expect(mockState.ipcLoopList).toHaveBeenCalledWith(endpoint, "demo");
    expect(logSpy).toHaveBeenCalledWith("job-1\tdemo\ts1\t*/5 * * * * *\tping");
    logSpy.mockRestore();
  });

  test("deletes loop job", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockState.ipcLoopDel.mockResolvedValue({
      deleted: true,
      id: "job-1",
    });

    await createCliProgram().parseAsync(["node", "d-connect", "loop", "del", "-i", "job-1", "-c", configPath]);

    expect(mockState.ipcLoopDel).toHaveBeenCalledWith(endpoint, "job-1");
    expect(logSpy).toHaveBeenCalledWith("job-1");
    logSpy.mockRestore();
  });

  test("raises when deleting absent loop job", async () => {
    mockState.ipcLoopDel.mockResolvedValue({
      deleted: false,
      id: "missing",
    });

    await expect(createCliProgram().parseAsync(["node", "d-connect", "loop", "del", "-i", "missing", "-c", configPath])).rejects.toThrow(
      "loop job not found: missing",
    );
  });
});

describe("cli init and add commands", () => {
  const configPath = process.platform === "win32" ? "C:\\tmp\\config-plus.json" : "/tmp/config-plus.json";
  beforeEach(() => {
    mockState.initConfig.mockReset().mockResolvedValue({
      configPath,
      overwritten: false,
    });
    mockState.addProjectConfig.mockReset().mockResolvedValue({
      projectName: "demo",
      configPath,
    });
  });

  test("creates config and logs result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createCliProgram().parseAsync(["node", "d-connect", "init", "-c", configPath, "--force"]);

    expect(mockState.initConfig).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
      force: true,
      yes: false,
    });
    expect(logSpy).toHaveBeenCalledWith(`config created at ${configPath}`);
    logSpy.mockRestore();
  });

  test("adds project to config and logs result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createCliProgram().parseAsync(["node", "d-connect", "add", "-c", configPath, "--yes"]);

    expect(mockState.addProjectConfig).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
      yes: true,
    });
    expect(logSpy).toHaveBeenCalledWith(`project demo added to ${configPath}`);
    logSpy.mockRestore();
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

describe("cli command edge cases", () => {
  const configPath = process.platform === "win32" ? "C:\\tmp\\config-edge.json" : "/tmp/config-edge.json";
  const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-edge" : "/tmp/d-connect-edge";
  const endpoint = resolveIpcEndpoint(dataDir);

  beforeEach(() => {
    mockState.resolveAndLoadConfig.mockResolvedValue({
      config: {
        dataDir,
      },
      rawConfig: {},
      configPath,
    });
    mockState.startDaemon.mockReset();
    mockState.startDaemon.mockResolvedValue(undefined);
    mockState.ipcDaemonStop.mockReset();
    mockState.execFile.mockReset();
  });

  test("runCli delegates to parsed command flow", async () => {
    await runCli(["node", "d-connect", "start", "-c", configPath]);

    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
    });
  });

  test("surfaces fallback errors when lsof returns non-supported codes", async () => {
    mockState.ipcDaemonStop.mockRejectedValue(new Error("route not found: POST /daemon/stop"));
    mockState.execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
      ) => {
        const error = new Error("boom") as NodeJS.ErrnoException;
        error.code = "EACCES";
        callback(error, "", "");
        return {} as any;
      },
    );

    if (process.platform === "win32") {
      await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
        /请先手动停止旧进程，再重试 restart/,
      );
      return;
    }

    await expect(createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath])).rejects.toThrow(
      /兼容降级也失败了/,
    );
    expect(mockState.execFile).toHaveBeenCalledWith("lsof", ["-t", endpoint], expect.any(Function));
  });

  test("accepts raw ENOENT errors without numeric code for start retry", async () => {
    mockState.ipcDaemonStop.mockRejectedValue("ENOENT");

    await createCliProgram().parseAsync(["node", "d-connect", "restart", "-c", configPath]);

    expect(mockState.startDaemon).toHaveBeenCalledWith({
      explicitConfigPath: configPath,
    });
  });
});
