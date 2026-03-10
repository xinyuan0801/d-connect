import { describe, expect, test } from "vitest";
import {
  buildDingTalkCardSchemaContent,
  buildDingTalkReplyPayload,
  buildDingTalkRobotSendPayload,
} from "../src/adapters/platform/dingtalk-content.js";

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

  test("buildDingTalkRobotSendPayload uses the sampleText template for plain text", () => {
    expect(buildDingTalkRobotSendPayload("plain text")).toEqual({
      msgKey: "sampleText",
      msgParam: JSON.stringify({
        content: "plain text",
      }),
    });
  });

  test("buildDingTalkRobotSendPayload uses the sampleMarkdown template for markdown", () => {
    expect(buildDingTalkRobotSendPayload("## Title\n- item")).toEqual({
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "Title",
        text: "## Title\n- item",
      }),
    });
  });

  test("buildDingTalkRobotSendPayload preserves tool status markdown formatting", () => {
    expect(buildDingTalkRobotSendPayload("🛠️ Agent\n`Explore | Explore codebase structure`")).toEqual({
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "🛠️ Agent",
        text: "🛠️ Agent\n```json\nExplore | Explore codebase structure\n```",
      }),
    });
  });

  test("buildDingTalkCardSchemaContent renders plain text into a basic card schema", () => {
    expect(JSON.parse(buildDingTalkCardSchemaContent("plain text"))).toEqual({
      header: {
        title: {
          type: "text",
          text: "plain text",
        },
      },
      contents: [
        {
          type: "text",
          text: "plain text",
          id: "body",
        },
      ],
    });
  });

  test("buildDingTalkCardSchemaContent keeps markdown content in the card body", () => {
    expect(JSON.parse(buildDingTalkCardSchemaContent("## Title\n- item"))).toEqual({
      header: {
        title: {
          type: "text",
          text: "Title",
        },
      },
      contents: [
        {
          type: "text",
          text: "## Title\n- item",
          id: "body",
        },
      ],
    });
  });
});
