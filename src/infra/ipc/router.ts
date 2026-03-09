import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";
import { Logger } from "../logging/logger.js";
import { LoopScheduler } from "../../scheduler/loop.js";
import { RuntimeEngine } from "../../runtime/engine.js";
import {
  loopAddRequestSchema,
  loopDelRequestSchema,
  sendRequestSchema,
  type DaemonStopResponse,
  type IpcResult,
  type SendResponse,
} from "../../ipc/types.js";

interface IpcRouteContext {
  runtime: RuntimeEngine;
  loop: LoopScheduler;
  logger: Logger;
  requestStop?: (reason: string) => void;
}

interface IpcRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: Record<string, unknown>;
}

interface IpcRoute {
  method: string;
  path: string;
  handle(request: IpcRequest, context: IpcRouteContext): Promise<void>;
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

export function createIpcRouter(context: IpcRouteContext) {
  const routes: IpcRoute[] = [
    {
      method: "POST",
      path: "/send",
      async handle(request, routeContext) {
        const body = sendRequestSchema.parse(await readJsonBody(request.req));
        const result = await routeContext.runtime.send(body);
        const payload: SendResponse = {
          project: result.project,
          sessionKey: result.sessionKey,
          sessionId: result.sessionId,
          response: result.response,
        };
        writeJson(request.res, 200, { ok: true, data: payload });
      },
    },
    {
      method: "POST",
      path: "/loop/add",
      async handle(request, routeContext) {
        const body = loopAddRequestSchema.parse(await readJsonBody(request.req));
        const job = await routeContext.loop.addJob({
          project: body.project,
          sessionKey: body.sessionKey,
          scheduleExpr: body.scheduleExpr,
          prompt: body.prompt,
          description: body.description,
          silent: body.silent,
        });
        writeJson(request.res, 200, { ok: true, data: job });
      },
    },
    {
      method: "GET",
      path: "/loop/list",
      async handle(request, routeContext) {
        const project = typeof request.query.project === "string" ? request.query.project : undefined;
        const jobs = routeContext.loop.list(project);
        writeJson(request.res, 200, { ok: true, data: { jobs } });
      },
    },
    {
      method: "POST",
      path: "/loop/del",
      async handle(request, routeContext) {
        const body = loopDelRequestSchema.parse(await readJsonBody(request.req));
        const ok = await routeContext.loop.removeJob(body.id);
        writeJson(request.res, 200, { ok: true, data: { deleted: ok, id: body.id } });
      },
    },
    {
      method: "POST",
      path: "/daemon/stop",
      async handle(request, routeContext) {
        const requestStop = routeContext.requestStop;
        if (!requestStop) {
          throw new Error("daemon stop is not enabled");
        }
        const payload: DaemonStopResponse = {
          stopping: true,
        };
        writeJson(request.res, 200, { ok: true, data: payload });
        setImmediate(() => {
          requestStop("IPC_STOP");
        });
      },
    },
  ];

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const method = req.method ?? "GET";
        const parsed = parseUrl(req.url ?? "", true);
        const path = parsed.pathname ?? "/";
        const route = routes.find((item) => item.method === method && item.path === path);
        if (!route) {
          writeJson(res, 404, {
            ok: false,
            error: `route not found: ${method} ${path}`,
          });
          return;
        }

        await route.handle(
          {
            req,
            res,
            method,
            path,
            query: parsed.query,
          },
          context,
        );
      } catch (error) {
        context.logger.warn("ipc request failed", {
          error: (error as Error).message,
        });
        writeJson(res, 400, {
          ok: false,
          error: (error as Error).message,
        });
      }
    },
  };
}
