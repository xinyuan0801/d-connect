import { request } from "node:http";
import type { LoopJob } from "../runtime/types.js";
import type { DaemonStopResponse, LoopListResponse, IpcResult, SendResponse } from "./types.js";

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

export async function ipcLoopAdd(
  socketPath: string,
  payload: { project: string; sessionKey: string; scheduleExpr: string; prompt: string; description?: string; silent?: boolean },
): Promise<LoopJob> {
  return requestIpc<LoopJob>(socketPath, "POST", "/loop/add", payload);
}

export async function ipcLoopList(socketPath: string, project?: string): Promise<LoopListResponse> {
  const suffix = project ? `?project=${encodeURIComponent(project)}` : "";
  return requestIpc<LoopListResponse>(socketPath, "GET", `/loop/list${suffix}`);
}

export async function ipcLoopDel(socketPath: string, id: string): Promise<{ deleted: boolean; id: string }> {
  return requestIpc<{ deleted: boolean; id: string }>(socketPath, "POST", "/loop/del", { id });
}

export async function ipcDaemonStop(socketPath: string): Promise<DaemonStopResponse> {
  return requestIpc<DaemonStopResponse>(socketPath, "POST", "/daemon/stop");
}
