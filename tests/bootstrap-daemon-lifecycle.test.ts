import { beforeEach, describe, expect, test, vi } from "vitest";

const daemonMocks = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(),
  fileExists: vi.fn(),
  bootstrapConfig: vi.fn(),
  loadConfig: vi.fn(),
  normalizeConfig: vi.fn(),
  createLoopStore: vi.fn(),
  LoopScheduler: vi.fn(),
  RuntimeEngine: vi.fn(),
  ensureDir: vi.fn(),
  resolveIpcEndpoint: vi.fn(),
  ensureSocketAvailable: vi.fn(),
  IpcServer: vi.fn(),
  Logger: vi.fn(),
}));

vi.mock("../src/config/index.js", () => ({
  resolveConfigPath: daemonMocks.resolveConfigPath,
  fileExists: daemonMocks.fileExists,
  bootstrapConfig: daemonMocks.bootstrapConfig,
  loadConfig: daemonMocks.loadConfig,
  normalizeConfig: daemonMocks.normalizeConfig,
}));

vi.mock("../src/scheduler/loop.js", () => ({
  createLoopStore: daemonMocks.createLoopStore,
  LoopScheduler: daemonMocks.LoopScheduler,
}));

vi.mock("../src/runtime/engine.js", () => ({
  RuntimeEngine: daemonMocks.RuntimeEngine,
}));

vi.mock("../src/infra/store-json/atomic.js", () => ({
  ensureDir: daemonMocks.ensureDir,
}));

vi.mock("../src/ipc/endpoint.js", () => ({
  resolveIpcEndpoint: daemonMocks.resolveIpcEndpoint,
}));

vi.mock("../src/ipc/server.js", () => ({
  ensureSocketAvailable: daemonMocks.ensureSocketAvailable,
  IpcServer: daemonMocks.IpcServer,
}));

vi.mock("../src/infra/logging/logger.js", () => ({
  Logger: daemonMocks.Logger,
}));

function createMockLogger() {
  const logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; child: ReturnType<typeof vi.fn> } = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockImplementation(() => createMockLogger());
  return logger;
}

function setupLoggerMocks() {
  const daemonLogger = createMockLogger();
  const Logger = vi.fn(() => daemonLogger) as unknown as { new (...args: unknown[]): unknown };
  Logger.configureFile = vi.fn().mockResolvedValue(undefined);
  Logger.closeFile = vi.fn().mockResolvedValue(undefined);
  daemonMocks.Logger.mockImplementation(Logger);
  daemonMocks.Logger.configureFile = Logger.configureFile;
  daemonMocks.Logger.closeFile = Logger.closeFile;
  return daemonLogger;
}

async function loadStartDaemon() {
  vi.resetModules();
  return import("../src/bootstrap/daemon.js");
}

function createRuntimeMock() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createSchedulerMock() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

function createIpcServerMock() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

describe("startDaemon lifecycle", () => {
  const configPath = process.platform === "win32" ? "C:\\tmp\\d-connect-daemon.json" : "/tmp/d-connect-daemon.json";
  const baseConfig = {
    configVersion: 1,
    projects: [],
    dataDir: process.platform === "win32" ? "C:\\tmp\\.d-connect" : "/tmp/.d-connect",
    log: { level: "info" },
    loop: { silent: false },
  };
  const exposedConfig = {
    ...baseConfig,
    projects: [
      {
        name: "public-bot",
        agent: {
          type: "claudecode",
          options: {
            workDir: "/srv/public",
            cmd: "claude",
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
              allowFrom: "*",
              processingNotice: "处理中...",
            },
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    Object.values(daemonMocks).forEach((value) => {
      value.mockReset();
    });

    daemonMocks.fileExists.mockResolvedValue(true);
    daemonMocks.resolveConfigPath.mockReturnValue(configPath);
    daemonMocks.loadConfig.mockResolvedValue({});
    daemonMocks.normalizeConfig.mockReturnValue(baseConfig);
    daemonMocks.ensureDir.mockResolvedValue(undefined);
    daemonMocks.resolveIpcEndpoint.mockReturnValue(process.platform === "win32" ? "my-pipe" : "/tmp/.d-connect/ipc.sock");
    daemonMocks.ensureSocketAvailable.mockResolvedValue(undefined);
    setupLoggerMocks();
  });

  test("prints allow-from wildcard warning before startup and keeps startup flow", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = createRuntimeMock();
    const loopScheduler = createSchedulerMock();
    const ipcServer = createIpcServerMock();
    const startDaemonModule = await loadStartDaemon();
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let signalHandler: (signal: string) => void = () => undefined;
    processOnSpy.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "SIGINT") {
        signalHandler = listener as (signal: string) => void;
      }
      return process;
    });

    daemonMocks.createLoopStore.mockResolvedValue({} as never);
    daemonMocks.LoopScheduler.mockReturnValue(loopScheduler as never);
    daemonMocks.RuntimeEngine.mockReturnValue(runtime as never);
    daemonMocks.IpcServer.mockReturnValue(ipcServer as never);
    daemonMocks.normalizeConfig.mockReturnValue(exposedConfig);

    daemonMocks.ensureSocketAvailable.mockResolvedValue(undefined);
    loopScheduler.start.mockResolvedValue(undefined);
    runtime.start.mockResolvedValue(undefined);
    ipcServer.start.mockResolvedValue(undefined);

    startDaemonModule.startDaemon({ explicitConfigPath: configPath });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("检测到 allowFrom = \"*\""));

    signalHandler("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    consoleWarn.mockRestore();
  });

  test("stop flow handles shutdown errors and still closes logger file", async () => {
    const runtime = createRuntimeMock();
    const loopScheduler = createSchedulerMock();
    const ipcServer = createIpcServerMock();
    const startDaemonModule = await loadStartDaemon();
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    let signalHandler: (signal: string) => void = () => undefined;
    processOnSpy.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "SIGINT") {
        signalHandler = listener as (signal: string) => void;
      }
      return process;
    });

    daemonMocks.createLoopStore.mockResolvedValue({} as never);
    daemonMocks.LoopScheduler.mockReturnValue(loopScheduler as never);
    daemonMocks.RuntimeEngine.mockReturnValue(runtime as never);
    daemonMocks.IpcServer.mockReturnValue(ipcServer as never);
    ipcServer.stop.mockRejectedValue(new Error("shutdown failed"));

    startDaemonModule.startDaemon({ explicitConfigPath: configPath });

    loopScheduler.start.mockResolvedValue(undefined);
    runtime.start.mockResolvedValue(undefined);
    daemonMocks.ensureSocketAvailable.mockResolvedValue(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    signalHandler("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(daemonMocks.Logger.closeFile).toHaveBeenCalledTimes(1);
    expect(loopScheduler.stop).toHaveBeenCalledWith();
    expect(ipcServer.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  test("rejects when runtime start throws and keeps startup path covered", async () => {
    const { startDaemon } = await loadStartDaemon();
    const loopScheduler = createSchedulerMock();
    const runtime = createRuntimeMock();
    const ipcServer = createIpcServerMock();

    runtime.start.mockRejectedValueOnce(new Error("runtime failed"));
    daemonMocks.createLoopStore.mockResolvedValue({} as never);
    daemonMocks.LoopScheduler.mockReturnValue(loopScheduler as never);
    daemonMocks.RuntimeEngine.mockReturnValue(runtime as never);
    daemonMocks.IpcServer.mockReturnValue(ipcServer as never);

    await expect(startDaemon({ explicitConfigPath: configPath })).rejects.toThrow("runtime failed");
    expect(runtime.start).toHaveBeenCalled();
    expect(loopScheduler.start).not.toHaveBeenCalled();
    expect(ipcServer.start).not.toHaveBeenCalled();
    expect(loopScheduler.stop).not.toHaveBeenCalled();
    expect(ipcServer.stop).not.toHaveBeenCalled();
  });

  test("starts daemon components and executes stop flow when process exit signal received", async () => {
    const runtime = createRuntimeMock();
    const loopScheduler = createSchedulerMock();
    const ipcServer = createIpcServerMock();
    const startDaemonModule = await loadStartDaemon();
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    let signalHandler: (signal: string) => void = () => undefined;
    processOnSpy.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "SIGINT") {
        signalHandler = listener as (signal: string) => void;
      }
      return process;
    });

    daemonMocks.createLoopStore.mockResolvedValue({} as never);
    daemonMocks.LoopScheduler.mockReturnValue(loopScheduler as never);
    daemonMocks.RuntimeEngine.mockReturnValue(runtime as never);
    daemonMocks.IpcServer.mockReturnValue(ipcServer as never);

    startDaemonModule.startDaemon({ explicitConfigPath: configPath });

    loopScheduler.start.mockResolvedValue(undefined);
    runtime.start.mockResolvedValue(undefined);
    ipcServer.start.mockResolvedValue(undefined);
    daemonMocks.ensureSocketAvailable.mockResolvedValue(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    signalHandler("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loopScheduler.stop).toHaveBeenCalledWith();
    expect(ipcServer.stop).toHaveBeenCalledWith();
    expect(runtime.stop).toHaveBeenCalledWith();
    expect(daemonMocks.Logger.closeFile).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  test("executes stop flow on SIGTERM and keeps stop idempotent", async () => {
    const runtime = createRuntimeMock();
    const loopScheduler = createSchedulerMock();
    const ipcServer = createIpcServerMock();
    const startDaemonModule = await loadStartDaemon();
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    let signalHandler: (signal: string) => void = () => undefined;
    processOnSpy.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "SIGTERM") {
        signalHandler = listener as (signal: string) => void;
      }
      return process;
    });

    daemonMocks.createLoopStore.mockResolvedValue({} as never);
    daemonMocks.LoopScheduler.mockReturnValue(loopScheduler as never);
    daemonMocks.RuntimeEngine.mockReturnValue(runtime as never);
    daemonMocks.IpcServer.mockReturnValue(ipcServer as never);

    startDaemonModule.startDaemon({ explicitConfigPath: configPath });

    loopScheduler.start.mockResolvedValue(undefined);
    runtime.start.mockResolvedValue(undefined);
    daemonMocks.ensureSocketAvailable.mockResolvedValue(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    signalHandler("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    signalHandler("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loopScheduler.stop).toHaveBeenCalledTimes(1);
    expect(ipcServer.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(daemonMocks.Logger.closeFile).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });
});
