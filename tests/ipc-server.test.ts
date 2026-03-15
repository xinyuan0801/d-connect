import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { resolveIpcEndpoint } from "../src/ipc/endpoint.js";
import { ensureSocketAvailable, IpcServer } from "../src/ipc/server.js";

import { request as httpRequest } from "node:http";

let createConnectionMock: ((...args: any[]) => any) | undefined;

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: (...args: any[]) => {
      if (createConnectionMock) {
        return createConnectionMock(...args);
      }
      return actual.createConnection(...args);
    },
  };
});

function requestJson<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  const payload = body ? JSON.stringify(body) : "";
  return new Promise<T>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
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
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
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

describe("ipc socket startup guards", () => {
  test("rejects when another daemon is already listening on the socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-"));
    const socketPath = resolveIpcEndpoint(dir);
    const server = createServer();

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });

    await expect(ensureSocketAvailable(socketPath)).rejects.toThrow(/already running/i);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  test("removes a stale socket left by a crashed daemon", async () => {
    if (process.platform === "win32") {
      // Windows named pipes do not leave stale filesystem entries.
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-"));
    const socketPath = resolveIpcEndpoint(dir);

    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const server=net.createServer();server.listen(${JSON.stringify(socketPath)},()=>console.log("ready"));setInterval(()=>{},1000);`,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolve());
    });

    expect(existsSync(socketPath)).toBe(true);

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    expect(existsSync(socketPath)).toBe(true);
    await expect(ensureSocketAvailable(socketPath)).resolves.toBeUndefined();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("starts server, serves requests and removes socket on stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-server-"));
    const socketPath = resolveIpcEndpoint(dir);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = {
      send: vi.fn(),
      // keep compatibility with runtime type shape
    } as any;
    const loop = {
      addJob: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      removeJob: vi.fn(),
    } as any;
    const server = new IpcServer({
      socketPath,
      runtime,
      loop,
      logger,
    });

    await server.start();
    expect(existsSync(socketPath)).toBe(true);

    const response = await requestJson<{ ok: boolean; error: string }>(socketPath, "POST", "/unsupported");
    expect(response.ok).toBe(false);

    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("covers missing socket path branch", async () => {
    const missingSocket = join(await mkdtemp(join(tmpdir(), "d-connect-absent-")), "missing.sock");
    await ensureSocketAvailable(missingSocket);
    expect(existsSync(missingSocket)).toBe(false);
  });

  test("propagates non-ENOENT probe errors", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "d-connect-ipc-probe-")), "broken.sock");
    const socket = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    socket.end = vi.fn();
    socket.destroy = vi.fn();
    const destroySpy = vi.spyOn(socket, "destroy");
    const endSpy = vi.spyOn(socket, "end");
    createConnectionMock = () => {
      setTimeout(() => socket.emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" })), 0);
      return socket;
    };

    await expect(ensureSocketAvailable(path)).rejects.toThrow("permission denied");

    expect(endSpy).toHaveBeenCalledTimes(0);
    destroySpy.mockRestore();
    endSpy.mockRestore();
    createConnectionMock = undefined;
  });

  test("treats named pipe socket as stale-safe and skips unlink", async () => {
    const path = "\\\\.\\pipe\\d-connect-ci";
    const socket = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    socket.end = vi.fn();
    socket.destroy = vi.fn();
    createConnectionMock = () => {
      setTimeout(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), 0);
      return socket;
    };

    await expect(ensureSocketAvailable(path)).resolves.toBeUndefined();

    createConnectionMock = undefined;
  });

  test("propagates server close errors when stopping without a started server", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = {
      send: vi.fn(),
    } as any;
    const loop = {
      addJob: vi.fn(),
      list: vi.fn(),
      removeJob: vi.fn(),
    } as any;

    const socketPath = join(await mkdtemp(join(tmpdir(), "d-connect-ipc-stop-")), "stop.sock");
    const server = new IpcServer({
      socketPath,
      runtime,
      loop,
      logger,
    });

    await expect(server.stop()).rejects.toThrow();
  });
});
