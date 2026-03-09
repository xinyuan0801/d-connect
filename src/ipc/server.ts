import { createServer } from "node:http";
import { createConnection } from "node:net";
import { unlink } from "node:fs/promises";
import { LoopScheduler } from "../scheduler/loop.js";
import { Logger } from "../logging.js";
import { RuntimeEngine } from "../runtime/engine.js";
import { createIpcRouter } from "../infra/ipc/router.js";

interface IpcServerOptions {
  socketPath: string;
  runtime: RuntimeEngine;
  loop: LoopScheduler;
  logger: Logger;
  requestStop?: (reason: string) => void;
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function probeSocketState(path: string): Promise<"missing" | "stale" | "active"> {
  return new Promise<"missing" | "stale" | "active">((resolve, reject) => {
    const socket = createConnection(path);

    socket.once("connect", () => {
      socket.end();
      resolve("active");
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT") {
        resolve("missing");
        return;
      }
      if (error.code === "ECONNREFUSED") {
        resolve("stale");
        return;
      }
      reject(error);
    });
  });
}

export async function ensureSocketAvailable(path: string): Promise<void> {
  const state = await probeSocketState(path);
  if (state === "missing") {
    return;
  }
  if (state === "stale") {
    await removeStaleSocket(path);
    return;
  }
  throw new Error(`ipc server already running: ${path}`);
}

export class IpcServer {
  private readonly server = createServer();

  constructor(private readonly options: IpcServerOptions) {}

  async start(): Promise<void> {
    await ensureSocketAvailable(this.options.socketPath);
    const router = createIpcRouter({
      runtime: this.options.runtime,
      loop: this.options.loop,
      logger: this.options.logger,
      requestStop: this.options.requestStop,
    });

    this.server.on("request", (req, res) => {
      void router.handle(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server.listen(this.options.socketPath, resolve);
    });

    this.options.logger.info("ipc server listening", {
      socket: this.options.socketPath,
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await removeStaleSocket(this.options.socketPath);
  }
}
