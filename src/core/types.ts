import { EventEmitter } from "node:events";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface DeliveryTarget {
  platform: string;
  payload: JsonObject;
}

export interface InboundMessage {
  sessionKey: string;
  platform: string;
  userId: string;
  userName: string;
  content: string;
  replyContext: unknown;
  deliveryTarget?: DeliveryTarget;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface PlatformAdapter {
  readonly name: string;
  start(handler: MessageHandler): Promise<void>;
  reply(replyContext: unknown, content: string): Promise<void>;
  send(target: DeliveryTarget, content: string): Promise<void>;
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

export type TurnEvent = AgentEvent;

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

export interface ModelSwitchable {
  setModel(model: string): void;
  getModel(): string;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface LoopJob {
  id: string;
  project: string;
  sessionKey: string;
  scheduleExpr: string;
  prompt: string;
  description: string;
  enabled: boolean;
  silent?: boolean;
  createdAt: string;
  lastRun?: string;
  lastError?: string;
}

export interface JobExecutor {
  executeJob(job: LoopJob): Promise<void>;
}

export interface LoopExecutor {
  executeLoopJob(job: LoopJob): Promise<void>;
}

export interface TurnResult {
  response: string;
  events: TurnEvent[];
}

export type PlatformMessage = InboundMessage;
