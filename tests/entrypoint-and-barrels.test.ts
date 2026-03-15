import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const cliMock = vi.hoisted(() => ({
  runCli: vi.fn(),
  handleCliError: vi.fn(),
}));

vi.mock("../src/bootstrap/cli.js", () => ({
  runCli: cliMock.runCli,
  handleCliError: cliMock.handleCliError,
}));

describe("entrypoint and barrel exports", () => {
  beforeEach(() => {
    cliMock.runCli.mockReset();
    cliMock.handleCliError.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test("loads app and ipc barrel modules", async () => {
    const ipcModule = await import("../src/ipc/index.js");
    const appModule = await import("../src/app.js");
    const coreModule = await import("../src/core/index.js");

    expect(typeof ipcModule.ipcSend).toBe("function");
    expect(typeof ipcModule.ipcLoopAdd).toBe("function");
    expect(typeof ipcModule.IpcServer).toBe("function");
    expect(typeof appModule.resolveAndLoadConfig).toBe("function");
    expect(typeof appModule.startApp).toBe("function");
    expect(coreModule).toBeDefined();
  });

  test("executes top-level index and resolves on success", async () => {
    cliMock.runCli.mockResolvedValue(undefined);

    await import("../src/index.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cliMock.runCli).toHaveBeenCalledWith(process.argv);
    expect(cliMock.handleCliError).not.toHaveBeenCalled();
  });

  test("executes top-level index and routes errors to handler", async () => {
    const error = new Error("cli failed");
    cliMock.runCli.mockRejectedValue(error);

    await import("../src/index.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cliMock.handleCliError).toHaveBeenCalledWith(error);
  });
});
