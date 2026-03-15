import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createIpcRouter } from "../src/infra/ipc/router.js";

async function requestText(port: number, method: string, path: string, body: string): Promise<{ status: number; data: { ok: boolean; error?: string } }> {
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
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            data: JSON.parse(raw) as { ok: boolean; error?: string },
          });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("infra ipc router body parsing", () => {
  const runtimes: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((close) => close()));
  });

  test("returns 400 when request body is malformed json", async () => {
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
    const response = await requestText(endpoint.port, "POST", "/send", "{bad-json}");
    expect(response.status).toBe(400);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toBeTruthy();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(runtime.send).not.toHaveBeenCalled();
  });
});
