import { z } from "zod";
import type { CronJob } from "../runtime/types.js";

export const sendRequestSchema = z.object({
  project: z.string().min(1),
  sessionKey: z.string().min(1),
  content: z.string().min(1),
});

export const cronAddRequestSchema = z.object({
  project: z.string().min(1),
  sessionKey: z.string().min(1),
  cronExpr: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().default(""),
  silent: z.boolean().optional(),
});

export const cronDelRequestSchema = z.object({
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

export interface CronListResponse {
  jobs: CronJob[];
}
