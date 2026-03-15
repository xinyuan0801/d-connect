import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createIpcRouter } from "../src/infra/ipc/router.js";

async function requestJson<T>(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";

    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          resolve({
            status: res.statusCode ?? 0,
            data: raw ? (JSON.parse(raw) as T) : ({} as T),
          });
        });
      },
    );

    req.on("error", reject);
    if (payload.length > 0) {
      req.write(payload);
    }
    req.end();
  });
}

function buildRuntimeSendJob(job: {
  id: string;
}) {
  return {
    id: job.id,
    project: "demo",
    sessionKey: "s1",
    scheduleExpr: "*/5 * * * * *",
    prompt: "ping",
    description: "",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function requestRaw<T>(port: number, method: string, path: string, body: string): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          resolve({
            status: res.statusCode ?? 0,
            data: raw ? (JSON.parse(raw) as T) : ({} as T),
          });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("infra ipc router", () => {
  const runtimes: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((close) => close()));
  });

  test("routes send requests to runtime and returns payload", async () => {
    const logger = { warn: vi.fn() };
    const runtime = {
      send: vi.fn().mockResolvedValue({
        project: "demo",
        sessionKey: "s1",
        sessionId: "sid-1",
        response: "ok",
      }),
    };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors; keep server alive
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestJson<{
      ok: boolean;
      data: { project: string; sessionId: string; response: string };
    }>(endpoint.port, "POST", "/send", {
      project: "demo",
      sessionKey: "s1",
      content: "hello",
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      ok: true,
      data: {
        project: "demo",
        sessionKey: "s1",
        sessionId: "sid-1",
        response: "ok",
      },
    });
    expect(runtime.send).toHaveBeenCalledWith({
      project: "demo",
      sessionKey: "s1",
      content: "hello",
    });
  });

  test("validates request payload and returns bad request", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestJson<{
      ok: boolean;
      error: string;
    }>(endpoint.port, "POST", "/loop/add", {
      project: "demo",
      sessionKey: "s1",
      prompt: "ping",
    });

    expect(response.status).toBe(400);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toContain("scheduleExpr");
    expect(loop.addJob).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("supports loop list and delete route arguments", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn().mockReturnValue([buildRuntimeSendJob({ id: "job-1" })]),
      removeJob: vi.fn().mockResolvedValue(true),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const listResponse = await requestJson<{
      ok: boolean;
      data: { jobs: Array<{ id: string }> };
    }>(endpoint.port, "GET", "/loop/list?project=demo");

    expect(listResponse.status).toBe(200);
    expect(listResponse.data.data?.jobs).toEqual([{
      id: "job-1",
      project: "demo",
      sessionKey: "s1",
      scheduleExpr: "*/5 * * * * *",
      prompt: "ping",
      description: "",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    expect(loop.list).toHaveBeenCalledWith("demo");

    const delResponse = await requestJson<{
      ok: boolean;
      data: { deleted: boolean; id: string };
    }>(endpoint.port, "POST", "/loop/del", { id: "job-1" });

    expect(delResponse.status).toBe(200);
    expect(delResponse.data).toEqual({
      ok: true,
      data: {
        deleted: true,
        id: "job-1",
      },
    });
    expect(loop.removeJob).toHaveBeenCalledWith("job-1");
  });

  test("requires requestStop handler for daemon stop route", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestJson<{ ok: boolean; error: string }>(endpoint.port, "POST", "/daemon/stop", {});
    expect(response.status).toBe(400);
    expect(response.data).toEqual({
      ok: false,
      error: "daemon stop is not enabled",
    });
  });

  test("invokes stop callback when stop route is available", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    let stopReason: string | undefined;
    const router = createIpcRouter({
      runtime,
      loop,
      logger,
      requestStop: (reason) => {
        stopReason = reason;
      },
    });

    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestJson<{ ok: boolean; data: { stopping: boolean } }>(endpoint.port, "POST", "/daemon/stop", {});
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      ok: true,
      data: { stopping: true },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(stopReason).toBe("IPC_STOP");
  });

  test("returns 404 for unknown routes", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestJson<{ ok: boolean; error: string }>(endpoint.port, "GET", "/unknown");
    expect(response.status).toBe(404);
    expect(response.data).toEqual({
      ok: false,
      error: "route not found: GET /unknown",
    });
  });

  test("creates loop jobs through /loop/add", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn().mockResolvedValue(buildRuntimeSendJob({ id: "job-loop" })),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestRaw<{ ok: boolean; data: { id: string } }>(
      endpoint.port,
      "POST",
      "/loop/add",
      JSON.stringify({
        project: "demo",
        sessionKey: "s1",
        scheduleExpr: "*/5 * * * * *",
        prompt: "ping",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      ok: true,
      data: {
        id: "job-loop",
        project: "demo",
        sessionKey: "s1",
        scheduleExpr: "*/5 * * * * *",
        prompt: "ping",
        description: "",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(loop.addJob).toHaveBeenCalledWith({
      project: "demo",
      sessionKey: "s1",
      scheduleExpr: "*/5 * * * * *",
      prompt: "ping",
      description: "",
      silent: undefined,
    });
  });

  test("treats POST body absent as empty object when parsing json", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestRaw<{ ok: boolean; error: string }>(endpoint.port, "POST", "/send", "");

    expect(response.status).toBe(400);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toContain("Invalid input: expected string, received undefined");
  });

  test("treats blank request body as empty object when parsing json", async () => {
    const logger = { warn: vi.fn() };
    const runtime = { send: vi.fn() };
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    };

    const router = createIpcRouter({ runtime, loop, logger });
    const server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        // route handler already serializes errors
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    runtimes.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const endpoint = server.address() as AddressInfo;
    const response = await requestRaw<{ ok: boolean; error: string }>(endpoint.port, "POST", "/send", "   ");

    expect(response.status).toBe(400);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toContain("invalid_type");
  });
});
