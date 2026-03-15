import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, AgentAdapter, AgentSession, PermissionResult } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import {
  GuardService,
  buildGuardBlockedMessage,
  buildGuardPrompt,
  parseGuardDecision,
} from "../src/services/guard-service.js";

describe("guard service helpers", () => {
  test("buildGuardPrompt includes custom rules when provided", () => {
    const prompt = buildGuardPrompt({
      project: "demo",
      sessionKey: "dingtalk:chat:user",
      userId: "u1",
      userName: "alice",
      content: "deploy to production",
      customRules: "禁止任何 deploy 请求。",
    });

    expect(prompt).toContain("用户自定义 guard 规则（优先级高于默认规则）：");
    expect(prompt).toContain("禁止任何 deploy 请求。");
    expect(prompt).toContain('message: "deploy to production"');
  });

  test("parseGuardDecision accepts direct json and fenced json", () => {
    expect(parseGuardDecision('{"action":"allow"}')).toEqual({
      action: "allow",
      reason: "",
    });

    expect(
      parseGuardDecision(
        [
          "结论如下：",
          "```json",
          '{"action":"block","reason":"包含生产高风险操作"}',
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      action: "block",
      reason: "包含生产高风险操作",
    });
  });

  test("buildGuardBlockedMessage normalizes empty reasons", () => {
    expect(buildGuardBlockedMessage("")).toBe("guard 已拦截本次消息。");
    expect(buildGuardBlockedMessage("包含敏感信息请求")).toBe("guard 已拦截本次消息：包含敏感信息请求");
  });
});

interface RuntimeGuardInput {
  project: string;
  sessionKey: string;
  content: string;
  userId?: string;
  userName?: string;
}

class FakeGuardSession extends EventEmitter implements AgentSession {
  private alive = true;
  public closeCalls = 0;
  public prompts: string[] = [];

  constructor(
    private readonly onSend: (prompt: string, session: FakeGuardSession) => Promise<void> | void,
  ) {
    super();
  }

  async send(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    await this.onSend(prompt, this);
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // no-op
  }

  currentSessionId(): string {
    return "guard-session-1";
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

function createGuardRuntime(session: FakeGuardSession) {
  return {
    config: {
      name: "demo",
      guard: {
        enabled: true,
        rules: "禁止任何 deploy 请求。",
      },
    },
    agent: {
      name: "fake",
      startSession: async () => session,
      stop: async () => {
        // no-op
      },
    } satisfies AgentAdapter,
    platforms: [],
    platformMap: new Map(),
    sessions: new Map<string, unknown>(),
  };
}

describe("guard service evaluate", () => {
  test("evaluates allow decision when guard output is valid json", async () => {
    const session = new FakeGuardSession(async (_prompt, guardSession) => {
      guardSession.emit("event", {
        type: "result",
        content: JSON.stringify({
          action: "allow",
          reason: "符合规则",
        }),
        sessionId: "guard-session-1",
        done: true,
      } satisfies AgentEvent);
    });
    const runtime = createGuardRuntime(session) as unknown as import("../src/services/project-registry.js").ProjectRuntime;
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");

    const result = await new GuardService(logger).evaluate(runtime, {
      project: "demo",
      sessionKey: "dingtalk:chat:user",
      content: "请帮我打印 hello",
      userId: "user-1",
      userName: "用户一",
    } as RuntimeGuardInput);

    expect(result).toEqual({
      action: "allow",
      reason: "符合规则",
      rawResponse: JSON.stringify({
        action: "allow",
        reason: "符合规则",
      }),
    });
    expect(warn).not.toHaveBeenCalled();
    expect(session.prompts[0]).toContain("用户自定义 guard 规则（优先级高于默认规则）：");
    expect(session.prompts[0]).toContain("禁止任何 deploy 请求。");
    expect(session.closeCalls).toBe(1);
  });

  test("falls back to block when guard output is parseable text without json", async () => {
    const session = new FakeGuardSession(async (_prompt, guardSession) => {
      guardSession.emit("event", {
        type: "text",
        content: "plain text without json",
        sessionId: "guard-session-1",
      } satisfies AgentEvent);
    });
    const runtime = createGuardRuntime(session) as unknown as import("../src/services/project-registry.js").ProjectRuntime;
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");

    const result = await new GuardService(logger).evaluate(runtime, {
      project: "demo",
      sessionKey: "dingtalk:chat:user",
      content: "请帮我做个危险操作",
      userId: "user-1",
      userName: "用户一",
    } as RuntimeGuardInput);

    expect(result).toEqual({
      action: "block",
      reason: "guard 返回了无法解析的结果",
      rawResponse: "plain text without json",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(1);
  });

  test("falls back to error stream when no parseable result/text exists", async () => {
    const session = new FakeGuardSession(async (_prompt, guardSession) => {
      guardSession.emit("event", {
        type: "error",
        content: "session access denied",
        sessionId: "guard-session-1",
        done: true,
      } satisfies AgentEvent);
    });
    const runtime = createGuardRuntime(session) as unknown as import("../src/services/project-registry.js").ProjectRuntime;
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");

    const result = await new GuardService(logger).evaluate(runtime, {
      project: "demo",
      sessionKey: "dingtalk:chat:user",
      content: "test",
      userId: "user-1",
      userName: "用户一",
    } as RuntimeGuardInput);

    expect(result).toEqual({
      action: "block",
      reason: "guard 返回了无法解析的结果",
      rawResponse: "session access denied",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(1);
  });

  test("blocks when guard session send fails", async () => {
    const session = new FakeGuardSession(async () => {
      throw new Error("guard process crashed");
    });
    const runtime = createGuardRuntime(session) as unknown as import("../src/services/project-registry.js").ProjectRuntime;
    const logger = new Logger("error");
    const error = vi.spyOn(logger, "error");

    const result = await new GuardService(logger).evaluate(runtime, {
      project: "demo",
      sessionKey: "dingtalk:chat:user",
      content: "please test",
      userId: "user-1",
      userName: "用户一",
    } as RuntimeGuardInput);

    expect(result).toEqual({
      action: "block",
      reason: "guard 检查失败：guard process crashed",
      rawResponse: "guard process crashed",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(1);
  });
});
