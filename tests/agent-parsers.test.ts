import { describe, expect, test } from "vitest";
import { parseAgentLine } from "../src/adapters/agent/parsers.js";

const agents = ["claudecode", "codex", "qoder", "opencode", "iflow"];

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
});
