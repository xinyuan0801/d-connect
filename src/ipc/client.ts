import { request } from "node:http";
import type { CronJob } from "../runtime/types.js";
import type { CronListResponse, IpcResult, SendResponse } from "./types.js";

async function requestIpc<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  const payload = body ? JSON.stringify(body) : "";

  return new Promise<T>((resolve, reject) => {
    const req = request(
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

        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            const parsed = (raw ? JSON.parse(raw) : { ok: true, data: {} }) as IpcResult<T>;
            if (!parsed.ok) {
              reject(new Error(parsed.error));
              return;
            }
            resolve(parsed.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export async function ipcSend(socketPath: string, payload: { project: string; sessionKey: string; content: string }): Promise<SendResponse> {
  return requestIpc<SendResponse>(socketPath, "POST", "/send", payload);
}

export async function ipcCronAdd(
  socketPath: string,
  payload: { project: string; sessionKey: string; cronExpr: string; prompt: string; description?: string; silent?: boolean },
): Promise<CronJob> {
  return requestIpc<CronJob>(socketPath, "POST", "/cron/add", payload);
}

export async function ipcCronList(socketPath: string, project?: string): Promise<CronListResponse> {
  const suffix = project ? `?project=${encodeURIComponent(project)}` : "";
  return requestIpc<CronListResponse>(socketPath, "GET", `/cron/list${suffix}`);
}

export async function ipcCronDel(socketPath: string, id: string): Promise<{ deleted: boolean; id: string }> {
  return requestIpc<{ deleted: boolean; id: string }>(socketPath, "POST", "/cron/del", { id });
}
