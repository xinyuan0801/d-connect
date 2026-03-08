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

  test("buildDingTalkReplyPayload uses markdown payload for tables", () => {
    expect(buildDingTalkReplyPayload("| A | B |\n|---|---|")).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "| A | B |",
        text: "| A | B |\n|---|---|",
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

  test("buildDingTalkReplyPayload renders tool status messages as fenced code markdown", () => {
    expect(buildDingTalkReplyPayload("🛠️ Agent\n`Explore | Explore codebase structure`")).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "🛠️ Agent",
        text: "🛠️ Agent\n```json\nExplore | Explore codebase structure\n```",
      },
    });
  });

  test("buildDingTalkReplyPayload keeps tool status markdown valid when args contain backticks", () => {
    expect(buildDingTalkReplyPayload("🛠️ run_shell_command\n``printf '`hello`'``")).toEqual({
      msgtype: "markdown",
      markdown: {
        title: "🛠️ run_shell_command",
        text: "🛠️ run_shell_command\n```json\nprintf '`hello`'\n```",
      },
    });
  });
});
