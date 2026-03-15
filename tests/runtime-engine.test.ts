import { describe, expect, test, vi } from "vitest";
import { DaemonRuntime } from "../src/services/daemon-runtime.js";
import { Logger } from "../src/infra/logging/logger.js";
import { RuntimeEngine } from "../src/runtime/engine.js";

interface MockRuntime {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  executeJob: ReturnType<typeof vi.fn>;
  executeLoopJob: ReturnType<typeof vi.fn>;
}

function createConfig() {
  return {
    configVersion: 1,
    log: { level: "info" },
    loop: { silent: false },
    dataDir: "/tmp/.d-connect",
    projects: [
      {
        name: "demo-project",
        agent: {
          type: "qoder",
          options: {},
        },
        guard: {
          enabled: false,
        },
        platforms: [
          {
            type: "dingtalk",
            options: {
              clientId: "ding-id",
              clientSecret: "ding-secret",
              allowFrom: "user-1",
              processingNotice: "处理中...",
            },
          },
        ],
      },
    ],
  };
}

function createRuntimeMock(): MockRuntime {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async () => ({ response: "ok", events: [] })),
    executeJob: vi.fn(),
    executeLoopJob: vi.fn(),
  };
}

describe("runtime engine", () => {
  test("stop returns when runtime is not initialized", async () => {
    const engine = new RuntimeEngine(createConfig(), new Logger("error"));
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  test("stop delegates to runtime and clears runtime instance", async () => {
    const runtime = createRuntimeMock();
    const createSpy = vi.spyOn(DaemonRuntime, "create").mockResolvedValue(runtime as never);
    const engine = new RuntimeEngine(createConfig(), new Logger("error"));

    await engine.send({ project: "demo-project", sessionKey: "session-1", content: "hello" } as never);
    await engine.stop();
    await engine.stop();

    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });

  test("executeLoopJob delegates to DaemonRuntime", async () => {
    const runtime = createRuntimeMock();
    const createSpy = vi.spyOn(DaemonRuntime, "create").mockResolvedValue(runtime as never);
    const engine = new RuntimeEngine(createConfig(), new Logger("error"));
    const job = {
      id: "job-id",
      project: "demo-project",
      sessionKey: "session-1",
      scheduleExpr: "*/30 * * * * *",
      prompt: "check status",
      description: "loop check status",
      enabled: true,
      createdAt: "2026-03-14T00:00:00.000Z",
    };

    await engine.executeLoopJob(job as never);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(runtime.executeLoopJob).toHaveBeenCalledWith(job);
    createSpy.mockRestore();
  });
});
