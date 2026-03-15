import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryTarget } from "../../core/types.js";
import { ensureDir, writeJsonAtomic } from "./atomic.js";
import type { SessionRecord, SessionRepository } from "../../services/session-repository.js";

interface SessionSnapshot {
  sessions: Record<string, Omit<SessionRecord, "busy">>;
  activeSession: Record<string, string>;
  userSessions: Record<string, string[]>;
  deliveryTargets: Record<string, DeliveryTarget>;
  counter: number;
}

export class SessionStore implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();
  private activeSession = new Map<string, string>();
  private userSessions = new Map<string, string[]>();
  private deliveryTargets = new Map<string, DeliveryTarget>();
  private counter = 0;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as SessionSnapshot;

      this.sessions.clear();
      this.activeSession.clear();
      this.userSessions.clear();
      this.deliveryTargets.clear();

      for (const [id, value] of Object.entries(parsed.sessions ?? {})) {
        this.sessions.set(id, { ...value, busy: false });
      }
      for (const [k, v] of Object.entries(parsed.activeSession ?? {})) {
        this.activeSession.set(k, v);
      }
      for (const [k, v] of Object.entries(parsed.userSessions ?? {})) {
        this.userSessions.set(k, [...v]);
      }
      for (const [k, v] of Object.entries(parsed.deliveryTargets ?? {})) {
        this.deliveryTargets.set(k, v);
      }
      this.counter = parsed.counter ?? 0;
    } catch {
      // start with empty state
    }
  }

  async save(): Promise<void> {
    const sessions: Record<string, Omit<SessionRecord, "busy">> = {};
    for (const [id, session] of this.sessions.entries()) {
      const { busy: _busy, ...persisted } = session;
      sessions[id] = persisted;
    }

    const snapshot: SessionSnapshot = {
      sessions,
      activeSession: Object.fromEntries(this.activeSession.entries()),
      userSessions: Object.fromEntries(this.userSessions.entries()),
      deliveryTargets: Object.fromEntries(this.deliveryTargets.entries()),
      counter: this.counter,
    };

    await writeJsonAtomic(this.path, snapshot);
  }

  private nextId(): string {
    this.counter += 1;
    return `s${this.counter}`;
  }

  private createSession(userKey: string, name: string): SessionRecord {
    const now = new Date().toISOString();
    const id = this.nextId();
    const session: SessionRecord = {
      id,
      name,
      agentSessionId: "",
      history: [],
      createdAt: now,
      updatedAt: now,
      busy: false,
    };

    this.sessions.set(id, session);
    this.activeSession.set(userKey, id);

    const all = this.userSessions.get(userKey) ?? [];
    all.push(id);
    this.userSessions.set(userKey, all);

    return session;
  }

  getOrCreateActive(userKey: string): SessionRecord {
    const activeId = this.activeSession.get(userKey);
    if (activeId && this.sessions.has(activeId)) {
      return this.sessions.get(activeId)!;
    }
    return this.createSession(userKey, "default");
  }

  newSession(userKey: string, name: string): SessionRecord {
    return this.createSession(userKey, name || "session");
  }

  listSessions(userKey: string): SessionRecord[] {
    const ids = this.userSessions.get(userKey) ?? [];
    return ids.map((id) => this.sessions.get(id)).filter((s): s is SessionRecord => Boolean(s));
  }

  switchSession(userKey: string, target: string): SessionRecord | null {
    const list = this.listSessions(userKey);
    const found = list.find((s) => s.id === target || s.name === target);
    if (!found) {
      return null;
    }
    this.activeSession.set(userKey, found.id);
    return found;
  }

  getById(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  setAgentSessionId(session: SessionRecord, agentSessionId: string): void {
    session.agentSessionId = agentSessionId;
    session.updatedAt = new Date().toISOString();
  }

  tryLock(session: SessionRecord): boolean {
    if (session.busy) {
      return false;
    }
    session.busy = true;
    return true;
  }

  unlock(session: SessionRecord): void {
    session.busy = false;
    session.updatedAt = new Date().toISOString();
  }

  addHistory(session: SessionRecord, role: "user" | "assistant", content: string): void {
    session.history.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
  }

  setTeamState(session: SessionRecord, teamState?: SessionRecord["teamState"]): void {
    session.teamState = teamState;
    session.updatedAt = new Date().toISOString();
  }

  getDeliveryTarget(userKey: string): DeliveryTarget | undefined {
    return this.deliveryTargets.get(userKey);
  }

  setDeliveryTarget(userKey: string, target: DeliveryTarget): void {
    this.deliveryTargets.set(userKey, target);
  }
}

export async function createSessionStore(dataDir: string): Promise<SessionStore> {
  const dir = join(dataDir, "sessions");
  await ensureDir(dir);
  const store = new SessionStore(join(dir, "sessions.json"));
  await store.load();
  return store;
}
