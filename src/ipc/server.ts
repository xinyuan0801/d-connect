import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { parse as parseUrl } from "node:url";
import { unlink } from "node:fs/promises";
import { CronScheduler } from "../scheduler/cron.js";
import { Logger } from "../logging.js";
import { RuntimeEngine } from "../runtime/engine.js";
import {
  cronAddRequestSchema,
  cronDelRequestSchema,
  sendRequestSchema,
  type IpcResult,
  type SendResponse,
} from "./types.js";

interface IpcServerOptions {
  socketPath: string;
  runtime: RuntimeEngine;
  cron: CronScheduler;
  logger: Logger;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function writeJson<T>(res: ServerResponse, statusCode: number, payload: IpcResult<T>): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
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

    this.server.on("request", (req, res) => {
      void this.handle(req, res);
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const parsed = parseUrl(req.url ?? "", true);
      const path = parsed.pathname ?? "/";

      if (method === "POST" && path === "/send") {
        const body = sendRequestSchema.parse(await readJsonBody(req));
        const result = await this.options.runtime.send(body);
        const payload: SendResponse = {
          project: result.project,
          sessionKey: result.sessionKey,
          sessionId: result.sessionId,
          response: result.response,
        };
        writeJson(res, 200, { ok: true, data: payload });
        return;
      }

      if (method === "POST" && path === "/cron/add") {
        const body = cronAddRequestSchema.parse(await readJsonBody(req));
        const job = await this.options.cron.addJob({
          project: body.project,
          sessionKey: body.sessionKey,
          cronExpr: body.cronExpr,
          prompt: body.prompt,
          description: body.description,
          silent: body.silent,
        });
        writeJson(res, 200, { ok: true, data: job });
        return;
      }

      if (method === "GET" && path === "/cron/list") {
        const project = typeof parsed.query.project === "string" ? parsed.query.project : undefined;
        const jobs = this.options.cron.list(project);
        writeJson(res, 200, { ok: true, data: { jobs } });
        return;
      }

      if (method === "POST" && path === "/cron/del") {
        const body = cronDelRequestSchema.parse(await readJsonBody(req));
        const ok = await this.options.cron.removeJob(body.id);
        writeJson(res, 200, { ok: true, data: { deleted: ok, id: body.id } });
        return;
      }

      writeJson(res, 404, {
        ok: false,
        error: `route not found: ${method} ${path}`,
      });
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        error: (error as Error).message,
      });
    }
  }
}
