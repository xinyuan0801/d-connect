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

export type LoopContextMode = "isolated" | "shared";

export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "unknown";
export type TeamMemberStatus = "starting" | "working" | "available" | "idle" | "stopped" | "unknown";

export type TeamEventKind =
  | "team_created"
  | "team_deleted"
  | "member_spawned"
  | "task_started"
  | "task_completed"
  | "member_idle"
  | "message";

export interface TeamEventPayload {
  kind: TeamEventKind;
  teamName?: string;
  teamFilePath?: string;
  leadAgentId?: string;
  memberName?: string;
  memberId?: string;
  agentType?: string;
  model?: string;
  color?: string;
  taskId?: string;
  taskStatus?: TeamTaskStatus;
  taskSubject?: string;
  taskDescription?: string;
  summary?: string;
  idleReason?: string;
  planModeRequired?: boolean;
  timestamp?: string;
}

export interface TeamMemberState {
  memberId: string;
  memberName: string;
  agentType?: string;
  model?: string;
  color?: string;
  status: TeamMemberStatus;
  planModeRequired?: boolean;
  updatedAt?: string;
}

export interface TeamTaskState {
  taskId: string;
  subject?: string;
  description?: string;
  status: TeamTaskStatus;
  memberId?: string;
  memberName?: string;
  updatedAt?: string;
}

export interface TeamMessageState {
  id: string;
  memberId?: string;
  memberName: string;
  content: string;
  summary?: string;
  color?: string;
  timestamp: string;
}

export interface TeamState {
  active: boolean;
  teamName: string;
  teamFilePath?: string;
  leadAgentId?: string;
  members: Record<string, TeamMemberState>;
  tasks: Record<string, TeamTaskState>;
  messages: TeamMessageState[];
  updatedAt: string;
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

export interface PlatformResponseResult {
  status: "completed" | "failed";
}

export interface PlatformAdapter {
  readonly name: string;
  start(handler: MessageHandler): Promise<void>;
  beginResponse?(replyContext: unknown): Promise<void>;
  endResponse?(replyContext: unknown, result: PlatformResponseResult): Promise<void>;
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
  | "permission_request"
  | "team_event"
  | "team_message";

export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolInputRaw?: Record<string, unknown>;
  team?: TeamEventPayload;
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
  contextMode?: LoopContextMode;
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
