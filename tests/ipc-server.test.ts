import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { ensureSocketAvailable } from "../src/ipc/server.js";

describe("ipc socket startup guards", () => {
  test("rejects when another daemon is already listening on the socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-"));
    const socketPath = join(dir, "ipc.sock");
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
    const dir = await mkdtemp(join(tmpdir(), "d-connect-ipc-"));
    const socketPath = join(dir, "ipc.sock");

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
});
