import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  PermissionResult,
  TurnResult,
} from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import { createSessionStore } from "../src/runtime/session-store.js";
import { ConversationService } from "../src/services/conversation-service.js";

interface Harness {
  conversation: ConversationService;
  runtime: {
    config: { name: string };
    agent: AgentAdapter;
    platforms: [];
    platformMap: Map<string, never>;
    sessions: Map<string, AgentSession>;
  };
}

class FakeConversationSession extends EventEmitter implements AgentSession {
  private alive = true;
  public closeCalls = 0;
  public sendCalls: string[] = [];

  constructor(
    public readonly id: string,
    private readonly onSend: (session: FakeConversationSession, prompt: string) => Promise<void> | void,
    private readonly aliveAtStart = true,
  ) {
    super();
    this.alive = aliveAtStart;
  }

  async send(prompt: string): Promise<void> {
    this.sendCalls.push(prompt);
    await this.onSend(this, prompt);
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // no-op
  }

  currentSessionId(): string {
    return this.id;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.alive = false;
    this.closeCalls += 1;
    this.emit("close");
  }
}

async function buildHarness(runtimeSession: FakeConversationSession): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "d-connect-conversation-"));
  const sessionStore = await createSessionStore(dataDir);
  const conversation = new ConversationService(sessionStore, new Logger("error"));
  const runtime: Harness["runtime"] = {
    config: {
      name: "demo",
    },
    agent: {
      name: "fake",
      startSession: async () => runtimeSession,
      stop: async () => {
        // no-op
      },
    } satisfies AgentAdapter,
    platforms: [],
    platformMap: new Map(),
    sessions: new Map(),
  };

  return {
    conversation,
    runtime,
  };
}

function collectSessionHistory(runtime: Harness["runtime"], project: string, sessionKey: string) {
  const key = `${project}:${sessionKey}`;
  const session = runtime.sessions.get(key);
  return session;
}

describe("conversation service", () => {
  test("returns busy response when session is already processing", async () => {
    const runtimeSession = new FakeConversationSession("busy-session", async () => {
      // no-op
    });
    const { conversation, runtime } = await buildHarness(runtimeSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.busy = true;

    const result = await conversation.runTurn(
      runtime as any,
      "demo",
      "local:alice",
      session,
      "hello",
    );

    expect(result).toEqual({
      response: "session is busy, please retry in a few seconds",
      events: [],
    });
    expect(runtime.sessions.size).toBe(0);
  });

  test("reuses alive in-memory agent session and updates history", async () => {
    const runtimeSession = new FakeConversationSession(
      "active-session",
      async (session) => {
        session.emit("event", {
          type: "text",
          sessionId: "active-session",
          content: "agent says hi",
        } satisfies AgentEvent);
        session.emit("event", {
          type: "result",
          sessionId: "active-session",
          content: "final response",
          done: true,
        } satisfies AgentEvent);
      },
    );
    const { conversation, runtime } = await buildHarness(runtimeSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    runtime.sessions.set(session.id, runtimeSession);

    const result = await conversation.runTurn(runtime as any, "demo", "local:alice", session, "ping");

    expect(result.response).toBe("agent says hi\n\nfinal response");
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", content: "agent says hi", sessionId: "active-session" }),
      expect.objectContaining({ type: "result", content: "final response", done: true }),
    ]));
    expect(runtimeSession.sendCalls).toHaveLength(1);
    expect(session.agentSessionId).toBe("active-session");
    expect(session.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "ping" }),
        expect.objectContaining({
          role: "assistant",
          content: "agent says hi\n\nfinal response",
        }),
      ]),
    );
  });

  test("creates a new agent session when runtime session is gone or closed", async () => {
    const staleSession = new FakeConversationSession(
      "stale-session",
      async () => {
        throw new Error("should not be used");
      },
      false,
    );
    const freshSession = new FakeConversationSession(
      "fresh-session",
      async (session) => {
        session.emit("event", {
          type: "result",
          sessionId: "fresh-session",
          content: "fresh response",
          done: true,
        } satisfies AgentEvent);
      },
    );

    const { conversation, runtime } = await buildHarness(freshSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    session.agentSessionId = "stale-session";
    runtime.sessions.set(session.id, staleSession);

    const result = await conversation.runTurn(runtime as any, "demo", "local:alice", session, "retry");

    expect(result.response).toBe("fresh response");
    expect(session.agentSessionId).toBe("fresh-session");
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "result", content: "fresh response" })]));
  });

  test("streams final and interim messages when onMessage is provided", async () => {
    const messages: string[] = [];
    const runtimeSession = new FakeConversationSession(
      "stream-session",
      async (session) => {
        session.emit("event", {
          type: "text",
          sessionId: "stream-session",
          content: "part one",
        } satisfies AgentEvent);
        session.emit("event", {
          type: "result",
          sessionId: "stream-session",
          content: "final part",
          done: true,
        } satisfies AgentEvent);
      },
    );

    const { conversation, runtime } = await buildHarness(runtimeSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");
    runtime.sessions.set(session.id, runtimeSession);

    const result = await conversation.runTurn(
      runtime as any,
      "demo",
      "local:alice",
      session,
      "stream me",
      {
        onMessage: async (message: string) => {
          messages.push(message);
        },
      },
    );

    expect(result.response).toBe("part one\n\nfinal part");
    expect(messages).toEqual(["part one", "final part"]);
  });

  test("continues with error response when send fails and still persists assistant history", async () => {
    const runtimeSession = new FakeConversationSession(
      "failed-session",
      async (session) => {
        session.emit("event", {
          type: "text",
          sessionId: "failed-session",
          content: "before-fail",
        } satisfies AgentEvent);
        throw new Error("agent execution failed");
      },
    );

    const { conversation, runtime } = await buildHarness(runtimeSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const result = await conversation.runTurn(
      runtime as any,
      "demo",
      "local:alice",
      session,
      "do fail",
    );

    expect(result.response).toContain("before-fail");
    expect(result.response).toContain("agent execution failed: agent execution failed");
    expect(session.busy).toBe(false);
    expect(session.history.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "before-fail\n\nagent execution failed: agent execution failed",
      }),
    );
  });

  test("returns typed run result object when conversation succeeds", async () => {
    const runtimeSession = new FakeConversationSession(
      "typed-session",
      async (session) => {
        session.emit("event", {
          type: "result",
          sessionId: "typed-session",
          content: "ready",
          done: true,
        } satisfies AgentEvent);
      },
    );
    const { conversation, runtime } = await buildHarness(runtimeSession);
    const session = conversation.getOrCreateActiveSession("demo", "local:alice");

    const result = await conversation.runTurn(runtime as any, "demo", "local:alice", session, "ping") as TurnResult;

    expect(result).toEqual({
      response: "ready",
      events: expect.arrayContaining([expect.objectContaining({ type: "result", content: "ready" })]),
    });
  });
});
