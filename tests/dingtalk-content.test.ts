import { describe, expect, test } from "vitest";
import { buildDingTalkReplyPayload } from "../src/adapters/platform/dingtalk-content.js";

describe("dingtalk content", () => {
  test("buildDingTalkReplyPayload keeps plain text replies as text", () => {
    expect(buildDingTalkReplyPayload("plain text")).toEqual({
      msgtype: "text",
      text: {
        content: "plain text",
      },
    });
  });

  test("buildDingTalkReplyPayload uses markdown payload for markdown replies", () => {
    expect(buildDingTalkReplyPayload("## Title\n- item")).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "Title",
        text: "## Title\n- item",
      },
    });
  });

  test("buildDingTalkReplyPayload falls back to a default title for code fences", () => {
    expect(buildDingTalkReplyPayload("```ts\nconst a = 1;\n```")).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "reply",
        text: "```ts\nconst a = 1;\n```",
      },
    });
  });

  test("buildDingTalkReplyPayload keeps tool status messages as text", () => {
    expect(buildDingTalkReplyPayload("🛠️ 调用工具 `Agent`，输入: {\"subagent_type\":\"Explore\"}")).toEqual({
      msgtype: "text",
      text: {
        content: "🛠️ 调用工具 `Agent`，输入: {\"subagent_type\":\"Explore\"}",
      },
    });
  });
});
