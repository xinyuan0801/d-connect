import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/runtime/types.js";
import {
  createEventMessageRenderer,
  formatResponseFromEvents,
  MessageRelay,
  previewLogText,
  splitResponseMessages,
  summarizeToolMessages,
} from "../src/services/message-relay.js";

describe("message relay formatter", () => {
  test("previews and truncates log text", () => {
    expect(previewLogText(undefined)).toBeUndefined();
    expect(previewLogText("short", 10)).toBe("short");
    expect(previewLogText("this is a very long text", 10)).toBe("this is a ...");
  });

  test("summarizes tool events and normalizes agent output", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        toolName: "Agent",
        toolInput: "{\"description\":\"Explore\",\"prompt\":\"Explore architecture\"}",
        toolInputRaw: {
          subagent_type: "Explore",
          description: "Explore",
          prompt: "Explore architecture",
        },
      },
      {
        type: "text",
        content: "任务已开始。",
      },
      {
        type: "tool_use",
        requestId: "run:1",
        toolName: "run_shell_command",
        toolInput: "echo hello",
        toolInputRaw: {
          description: "echo hello",
        },
      },
      {
        type: "tool_result",
        requestId: "run:1",
        content: "ok",
      },
    ];

    expect(summarizeToolMessages(events)).toEqual([
      "🛠️ Agent\n`Explore`",
      "🛠️ run_shell_command\necho hello",
    ]);
  });

  test("avoids duplicate tool input when equal to description", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        toolName: "run_shell_command",
        toolInput: "echo hello",
        toolInputRaw: {
          description: "echo hello",
        },
      },
    ];

    expect(splitResponseMessages("done", events)).toEqual(["🛠️ run_shell_command\necho hello"]);
  });

  test("handles code fences for tool input wrapping", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        toolName: "run_shell_command",
        toolInput: "printf '```markdown```'",
      },
    ];

    expect(splitResponseMessages("done", events)).toEqual(["🛠️ run_shell_command\n````printf '```markdown```'````"]);
  });

  test("computes suffix for non-text response bodies", () => {
    const events: AgentEvent[] = [
      {
        type: "text",
        content: "hello",
      },
    ];

    expect(splitResponseMessages("hello world", events)).toEqual(["hello", "world"]);
  });

  test("keeps all segments when final body differs from rendered text", () => {
    const events: AgentEvent[] = [
      {
        type: "error",
        content: "tool failed",
      },
    ];

    expect(splitResponseMessages("agent failed", events)).toEqual(["agent error: tool failed", "agent failed"]);
  });

  test("formats complete response for render pipeline", () => {
    expect(formatResponseFromEvents("done", [])).toBe("done");
    expect(formatResponseFromEvents("hello", [{ type: "error", content: "oops" }])).toBe("agent error: oops\n\nhello");
  });
});

describe("message relay", () => {
  test("forwards trimmed non-empty response chunks only", async () => {
    const relay = new MessageRelay();
    const platform = {
      send: vi.fn(),
      reply: vi.fn(),
    } as any;
    const replyTarget = { sessionId: "s" };

    await relay.reply(platform, replyTarget, "");
    await relay.send(platform, { project: "p", sessionKey: "s" }, "hello", []);

    expect(platform.reply).toHaveBeenCalledWith(replyTarget, "done");
    expect(platform.send).toHaveBeenCalledTimes(1);
    expect(platform.send).toHaveBeenCalledWith({ project: "p", sessionKey: "s" }, "hello");
  });

  test("render options control text/error inclusion", () => {
    const renderer = createEventMessageRenderer({ includeText: false, includeErrors: false });
    expect(renderer.push({ type: "text", content: "ping" })).toEqual([]);
    expect(renderer.push({ type: "error", content: "boom" })).toEqual([]);
    expect(renderer.flush()).toEqual([]);
  });
});
