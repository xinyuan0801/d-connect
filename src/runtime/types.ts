import { EventEmitter } from "node:events";

export interface PlatformMessage {
  sessionKey: string;
  platform: string;
  userId: string;
  userName: string;
  content: string;
  replyCtx: unknown;
}

export type MessageHandler = (message: PlatformMessage) => void;

export interface PlatformAdapter {
  readonly name: string;
  start(handler: MessageHandler): Promise<void>;
  reply(replyCtx: unknown, content: string): Promise<void>;
  send(replyCtx: unknown, content: string): Promise<void>;
  stop(): Promise<void>;
}

export type AgentEventType =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "permission_request";

export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolInputRaw?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  error?: Error;
  done?: boolean;
}

export interface PermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface AgentSession extends EventEmitter {
  send(prompt: string): Promise<void>;
  respondPermission(requestId: string, result: PermissionResult): Promise<void>;
  currentSessionId(): string;
  isAlive(): boolean;
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly name: string;
  startSession(sessionId?: string): Promise<AgentSession>;
  stop(): Promise<void>;
}

export interface ModeSwitchable {
  setMode(mode: string): void;
  getMode(): string;
  supportedModes(): string[];
}

export interface ModelSwitchable {
  setModel(model: string): void;
  getModel(): string;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface CronJob {
  id: string;
  project: string;
  sessionKey: string;
  cronExpr: string;
  prompt: string;
  description: string;
  enabled: boolean;
  silent?: boolean;
  createdAt: string;
  lastRun?: string;
  lastError?: string;
}

export interface CronExecutor {
  executeCronJob(job: CronJob): Promise<void>;
}
