import type { DeliveryTarget, HistoryEntry } from "../core/types.js";

export interface SessionRecord {
  id: string;
  name: string;
  agentSessionId: string;
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
  busy: boolean;
}

export interface SessionRepository {
  load(): Promise<void>;
  save(): Promise<void>;
  getOrCreateActive(userKey: string): SessionRecord;
  newSession(userKey: string, name: string): SessionRecord;
  listSessions(userKey: string): SessionRecord[];
  switchSession(userKey: string, target: string): SessionRecord | null;
  getById(id: string): SessionRecord | undefined;
  setAgentSessionId(session: SessionRecord, agentSessionId: string): void;
  tryLock(session: SessionRecord): boolean;
  unlock(session: SessionRecord): void;
  addHistory(session: SessionRecord, role: "user" | "assistant", content: string): void;
  getDeliveryTarget(userKey: string): DeliveryTarget | undefined;
  setDeliveryTarget(userKey: string, target: DeliveryTarget): void;
}
