import { z } from "zod";
import type { LoopJob } from "../runtime/types.js";

export const sendRequestSchema = z.object({
  project: z.string().min(1),
  sessionKey: z.string().min(1),
  content: z.string().min(1),
});

export const loopAddRequestSchema = z.object({
  project: z.string().min(1),
  sessionKey: z.string().min(1),
  scheduleExpr: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().default(""),
  silent: z.boolean().optional(),
});

export const loopDelRequestSchema = z.object({
  id: z.string().min(1),
});

export interface IpcOk<T> {
  ok: true;
  data: T;
}

export interface IpcErr {
  ok: false;
  error: string;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

export interface SendResponse {
  project: string;
  sessionKey: string;
  sessionId: string;
  response: string;
}

export interface LoopListResponse {
  jobs: LoopJob[];
}

export interface DaemonStopResponse {
  stopping: boolean;
}
