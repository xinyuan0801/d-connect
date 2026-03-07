import { describe, expect, test } from "vitest";
import {
  asTextContent,
  buildReplyContent,
  hasComplexMarkdown,
  parsePostTextContent,
  preprocessFeishuMarkdown,
} from "../src/adapters/platform/feishu.js";

describe("feishu helpers", () => {
  test("asTextContent strips mention keys from text payload", () => {
    expect(
      asTextContent(JSON.stringify({ text: "@_user_1 hello" }), [{ key: "@_user_1" }]),
    ).toBe("hello");
  });

  test("parsePostTextContent supports flat and lang-keyed post payloads", () => {
    const flat = JSON.stringify({
      title: "Title",
      content: [[{ tag: "text", text: "Hello" }], [{ tag: "a", text: "Link" }]],
    });
    const keyed = JSON.stringify({
      zh_cn: {
        title: "Title",
        content: [[{ tag: "text", text: "Hello" }]],
      },
    });

    expect(parsePostTextContent(flat)).toBe("Title\nHello\nLink");
    expect(parsePostTextContent(keyed)).toBe("Title\nHello");
  });

  test("preprocessFeishuMarkdown inserts a newline before code fences", () => {
    expect(preprocessFeishuMarkdown("text```ts\ncode\n```")).toBe("text\n```ts\ncode\n```");
  });

  test("hasComplexMarkdown detects tables and code fences", () => {
    expect(hasComplexMarkdown("```ts\nconst a = 1;\n```")).toBe(true);
    expect(hasComplexMarkdown("| A | B |\n|---|---|")).toBe(true);
    expect(hasComplexMarkdown("**bold**")).toBe(false);
  });

  test("buildReplyContent chooses msg type by content complexity", () => {
    expect(buildReplyContent("plain text")).toEqual({
      msgType: "text",
      body: JSON.stringify({ text: "plain text" }),
    });

    expect(buildReplyContent("```ts\nconst a = 1;\n```").msgType).toBe("interactive");

    const markdownReply = buildReplyContent("## Title\n- item");
    expect(markdownReply.msgType).toBe("post");
    expect(markdownReply.body).toContain("\"tag\":\"md\"");
  });
});
