import { describe, expect, test } from "vitest";
import {
  extractAssistantEvents,
  extractAssistantParts,
  extractLatestExecutionInfo,
  extractToolResults,
  iflowProjectKey,
  sanitizeIFlowAssistantText,
  summarizeToolInput,
  summarizeToolResult,
} from "../src/adapters/agent/iflow-transcript.js";

describe("iflow transcript helpers", () => {
  test("iflowProjectKey normalizes platform paths", () => {
    expect(iflowProjectKey("/Users/me/projects/demo")).toBe("-Users-me-projects-demo");
    expect(iflowProjectKey("C:\\Users\\me\\demo")).toBe("C--Users-me-demo");
  });

  test("sanitizeIFlowAssistantText strips bootstrap noise and execution info", () => {
    const raw = `Welcome to iFlow CLI.

Hello! 你好。
<Execution Info>
{
  "session-id": "session-abc",
  "conversation-id": "conv-xyz"
}
</Execution Info>

More content.`;

    expect(sanitizeIFlowAssistantText(raw)).toBe("Hello! 你好。\n\nMore content.");
  });

  test("sanitizeIFlowAssistantText leaves normal text unchanged", () => {
    const raw = `这是普通内容。`;
    expect(sanitizeIFlowAssistantText(raw)).toBe(raw);
  });

  test("extractLatestExecutionInfo parses full JSON block and partial tail", () => {
    const full = `foo
<Execution Info>
{
  "session-id": "sid-1",
  "conversation-id": "conv-1"
}
</Execution Info>
bar`;
    expect(extractLatestExecutionInfo(full)).toEqual({
      sessionId: "sid-1",
      conversationId: "conv-1",
    });

    const tail = `<Execution Info>
{
  "session-id": "sid-tail"
`;
    expect(extractLatestExecutionInfo(tail)).toEqual({
      sessionId: "sid-tail",
      conversationId: undefined,
    });
  });

  test("extractLatestExecutionInfo returns undefined on malformed payload", () => {
    expect(extractLatestExecutionInfo("not-json")).toBeUndefined();
  });

  test("extractAssistantParts parses text and tool_use items", () => {
    const parts = extractAssistantParts([
      { type: "text", text: "first" },
      { type: "tool_use", name: "read_file", id: "tool-1", input: { path: "/tmp/a" } },
      { type: "ignore-me", text: "skip" },
    ]);

    expect(parts).toEqual([
      { type: "text", text: "first" },
      {
        type: "tool_use",
        tool: {
          id: "tool-1",
          name: "read_file",
          input: { path: "/tmp/a" },
        },
      },
    ]);
  });

  test("extractAssistantEvents splits text and tools", () => {
    const events = extractAssistantEvents([
      { type: "text", text: "ping" },
      { type: "tool_use", name: "bash", id: "call_1", input: { command: "ls" } },
    ]);

    expect(events).toEqual({
      texts: ["ping"],
      tools: [{ id: "call_1", name: "bash", input: { command: "ls" } }],
    });
  });

  test("extractToolResults summarizes tool output content and ignores malformed entries", () => {
    const results = extractToolResults([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: {
          functionResponse: {
            response: {
              output: "ok",
            },
          },
        },
      },
      {
        type: "assistant",
        tool_use_id: "ignore",
        content: "skip",
      },
      { type: "tool_result", tool_use_id: "t2", content: 1 },
    ]);

    expect(results).toEqual([
      { id: "t1", output: "ok" },
      { id: "t2", output: "1" },
    ]);
  });

  test("summarizeToolInput prefers key field values and truncates long JSON", () => {
    expect(summarizeToolInput({ path: "/tmp/file.txt" })).toBe("/tmp/file.txt");

    const long = Array.from({ length: 400 }, () => "x").join("");
    const longText = summarizeToolInput({ unknown: long });
    const expected = `${JSON.stringify({ unknown: long }).slice(0, 300)}...`;
    expect(longText).toBe(expected);
    expect(longText.endsWith("...")).toBe(true);
  });

  test("summarizeToolResult extracts structured text", () => {
    expect(
      summarizeToolResult({
        functionResponse: {
          response: {
            output: "result",
          },
        },
      }),
    ).toBe("result");
    expect(summarizeToolResult({ resultDisplay: "display" })).toBe("display");
    expect(summarizeToolResult({ unknown: "x" })).toBe('{"unknown":"x"}');
  });

  test("extractToolResults exported alias behaves the same", () => {
    const alias = extractToolResults;

    expect(alias([{ type: "tool_result", tool_use_id: "t3", content: { output: "raw" } }])).toEqual([
      { id: "t3", output: "raw" },
    ]);
  });
});
