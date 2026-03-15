import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveIpcEndpoint } from "../src/ipc/endpoint.js";
import { ipcSend, ipcDaemonStop, ipcLoopAdd, ipcLoopList, ipcLoopDel } from "../src/ipc/client.js";

interface IpcRouteResponse {
  statusCode?: number;
  contentType?: string;
  body: string;
}

type IpcRouteHandler = (method: string, path: string, payload: unknown) => IpcRouteResponse;

async function createIpcServer(handler: IpcRouteHandler) {
  const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-client-"));
  const socketPath = resolveIpcEndpoint(dir);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on("end", () => {
      let payload = undefined;
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length > 0) {
          payload = JSON.parse(raw);
        }
      }

      const { method, url } = req;
      const result = handler(method ?? "", url ?? "", payload);
      res.statusCode = result.statusCode ?? 200;
      res.setHeader("content-type", result.contentType ?? "application/json");
      res.end(result.body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe("ipc client", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.shift();
      if (close) {
        await close();
      }
    }
  });

  test("parses successful responses for each route", async () => {
    const { socketPath, close } = await createIpcServer((method, path, payload: any) => {
      if (method === "POST" && path === "/send") {
        return {
          body: JSON.stringify({
            ok: true,
            data: {
              project: payload.project,
              sessionKey: payload.sessionKey,
              sessionId: "session-send",
              response: "ok",
            },
          }),
        };
      }

      if (method === "POST" && path === "/loop/add") {
        return {
          body: JSON.stringify({
            ok: true,
            data: {
              id: "loop-1",
              project: payload.project,
              sessionKey: payload.sessionKey,
              scheduleExpr: payload.scheduleExpr,
              prompt: payload.prompt,
              description: "",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        };
      }

      if (method === "GET" && path === `/loop/list?project=${encodeURIComponent("demo/project")}`) {
        return {
          body: JSON.stringify({
            ok: true,
            data: {
              jobs: [
                {
                  id: "loop-1",
                  project: "demo/project",
                  sessionKey: "session-loop",
                  scheduleExpr: "*/5 * * * * *",
                  prompt: "ping",
                  description: "",
                  enabled: true,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
          }),
        };
      }

      if (method === "POST" && path === "/loop/del") {
        return {
          body: JSON.stringify({
            ok: true,
            data: {
              deleted: true,
              id: payload.id,
            },
          }),
        };
      }

      if (method === "POST" && path === "/daemon/stop") {
        return {
          body: JSON.stringify({
            ok: true,
            data: {
              stopping: true,
            },
          }),
        };
      }

      return { statusCode: 404, body: JSON.stringify({ ok: false, error: "not found" }) };
    });

    closers.push(close);

    await expect(
      ipcSend(socketPath, {
        project: "demo",
        sessionKey: "session-send",
        content: "hello",
      }),
    ).resolves.toEqual({
      project: "demo",
      sessionKey: "session-send",
      sessionId: "session-send",
      response: "ok",
    });
    await expect(
      ipcLoopAdd(socketPath, {
        project: "demo",
        sessionKey: "session-loop",
        scheduleExpr: "*/5 * * * * *",
        prompt: "ping",
      }),
    ).resolves.toMatchObject({
      id: "loop-1",
      project: "demo",
    });
    await expect(
      ipcLoopList(socketPath, "demo/project"),
    ).resolves.toMatchObject({
      jobs: [
        {
          id: "loop-1",
          project: "demo/project",
        },
      ],
    });
    await expect(
      ipcLoopDel(socketPath, "loop-1"),
    ).resolves.toEqual({
      deleted: true,
      id: "loop-1",
    });
    await expect(ipcDaemonStop(socketPath)).resolves.toEqual({
      stopping: true,
    });
  });

  test("rejects on business error response", async () => {
    const { socketPath, close } = await createIpcServer(() => ({
      body: JSON.stringify({
        ok: false,
        error: "rejected by ipc",
      }),
    }));
    closers.push(close);

    await expect(
      ipcSend(socketPath, {
        project: "demo",
        sessionKey: "session-send",
        content: "hello",
      }),
    ).rejects.toThrow("rejected by ipc");
  });

  test("rejects on invalid response JSON", async () => {
    const { socketPath, close } = await createIpcServer(() => ({
      body: "{broken-json",
    }));
    closers.push(close);

    await expect(
      ipcLoopAdd(socketPath, {
        project: "demo",
        sessionKey: "session-loop",
        scheduleExpr: "*/5 * * * * *",
        prompt: "ping",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("uses empty-response fallback payload when no body returned", async () => {
    const { socketPath, close } = await createIpcServer(() => ({
      body: "",
    }));
    closers.push(close);

    await expect(ipcLoopList(socketPath)).resolves.toEqual({});
  });

  test("propagates socket transport error", async () => {
    const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\d-connect-missing" : "/tmp/missing-d-connect-ipc.sock";
    await expect(
      ipcSend(socketPath, {
        project: "demo",
        sessionKey: "session-send",
        content: "hello",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
