import { describe, expect, test } from "vitest";
import { buildGuardBlockedMessage, buildGuardPrompt, parseGuardDecision } from "../src/services/guard-service.js";

describe("guard service helpers", () => {
  test("buildGuardPrompt includes custom rules when provided", () => {
    const prompt = buildGuardPrompt({
      project: "demo",
      sessionKey: "feishu:chat:user",
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
    expect(parseGuardDecision('{"action":"allow","reason":"安全"}')).toEqual({
      action: "allow",
      reason: "安全",
    });

    expect(
      parseGuardDecision([
        "结论如下：",
        "```json",
        '{"action":"block","reason":"包含生产高风险操作"}',
        "```",
      ].join("\n")),
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
