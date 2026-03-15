import { describe, expect, test } from "vitest";
import { parseAgentLine } from "../src/adapters/agent/parsers.js";

const agents = ["claudecode", "codex", "opencode", "qoder", "iflow"];

describe("agent parser normalization", () => {
  test.each(agents)("%s parses structured json result", (agent) => {
    const line = JSON.stringify({
      type: "result",
      content: "hello",
      sessionId: "abc-1",
      done: true,
    });
    const outcome = parseAgentLine(agent, line);
    expect(outcome.structured).toBe(true);
    expect(outcome.events[0]?.type).toBe("result");
    expect(outcome.events[0]?.content).toBe("hello");
    expect(outcome.events[0]?.sessionId).toBe("abc-1");
  });

  test.each(agents)("%s maps tool and thinking lines", (agent) => {
    expect(parseAgentLine(agent, "Thinking about solution").events[0]?.type).toBe("thinking");
    expect(parseAgentLine(agent, "Tool: bash").events[0]?.type).toBe("tool_use");
    expect(parseAgentLine(agent, "Tool result: ok").events[0]?.type).toBe("tool_result");
  });

  test.each(agents)("%s maps permission and errors", (agent) => {
    expect(parseAgentLine(agent, "Permission required for write").events[0]?.type).toBe("permission_request");
    expect(parseAgentLine(agent, "Error: failed").events[0]?.type).toBe("error");
  });

  test.each(agents)("%s maps structured type variants from raw payload", (agent) => {
    const permission = parseAgentLine(agent, JSON.stringify({ type: "permission_request", content: "need auth" }));
    expect(permission.structured).toBe(true);
    expect(permission.events[0]?.type).toBe("permission_request");

    const thinking = parseAgentLine(agent, JSON.stringify({ event: "thinking", content: "considering" }));
    expect(thinking.events[0]?.type).toBe("thinking");

    const toolUse = parseAgentLine(agent, JSON.stringify({ kind: "tool call", content: "run bash", tool: "shell" }));
    expect(toolUse.events[0]?.type).toBe("tool_use");

    const toolResult = parseAgentLine(agent, JSON.stringify({ level: "tool result", content: "result body" }));
    expect(toolResult.events[0]?.type).toBe("tool_result");

    const error = parseAgentLine(agent, JSON.stringify({ type: "fatal error", content: "boom" }));
    expect(error.events[0]?.type).toBe("error");

    const completed = parseAgentLine(agent, JSON.stringify({ type: "completed", content: "all done" }));
    expect(completed.events[0]?.type).toBe("result");

    const text = parseAgentLine(agent, JSON.stringify({ message: "assistant says hi", content: "ignored" }));
    expect(text.events[0]?.type).toBe("text");

    const toolInputPayload = parseAgentLine(
      agent,
      JSON.stringify({
        type: "tool_use",
        content: "use tool",
        toolName: "ls",
        input: {
          command: "ls -la",
        },
      }),
    );
    expect(toolInputPayload.events[0]?.toolInputRaw).toEqual({ command: "ls -la" });
    expect(toolInputPayload.events[0]?.toolInput).toBeUndefined();
  });

  test.each(agents)("%s keeps array/json-invalid lines as plain text", (agent) => {
    const malformed = parseAgentLine(agent, '{"type"');
    expect(malformed.structured).toBe(false);
    expect(malformed.events[0]?.type).toBe("text");
    expect(malformed.events[0]?.content).toBe('{"type"');

    const arrayPayload = parseAgentLine(agent, '[{"type":"text","content":"array"}]');
    expect(arrayPayload.structured).toBe(false);
    expect(arrayPayload.events[0]?.type).toBe("text");
    expect(arrayPayload.events[0]?.content).toBe('[{"type":"text","content":"array"}]');
  });

  test.each(agents)("%s parses empty lines and final-answer markers as plain text/result", (agent) => {
    expect(parseAgentLine(agent, "   ").events).toHaveLength(0);
    expect(parseAgentLine(agent, " ").structured).toBe(false);

    const final = parseAgentLine(agent, "done, final");
    expect(final.events[0]?.type).toBe("result");
    expect(final.events[0]?.done).toBe(true);
  });

  test.each(agents)("%s maps json objects with non-result type", (agent) => {
    const line = JSON.stringify({ type: "text", content: "assistant", done: false });
    const outcome = parseAgentLine(agent, line);
    expect(outcome.structured).toBe(true);
    expect(outcome.events[0]).toEqual({
      type: "text",
      content: "assistant",
      done: false,
      sessionId: undefined,
      requestId: undefined,
      toolName: undefined,
      toolInput: undefined,
      toolInputRaw: undefined,
    });
  });
});
