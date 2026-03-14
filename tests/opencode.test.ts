import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import { OpenCodeAdapter } from "../src/adapters/agent/opencode.js";

function buildOpencodeTextStreamScript(): string {
  const lines = [
    JSON.stringify({
      type: "step_start",
      timestamp: 1773494848225,
      sessionID: "ses_text_1",
      part: {
        id: "prt_step_1",
        sessionID: "ses_text_1",
        messageID: "msg_text_1",
        type: "step-start",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
      },
    }),
    JSON.stringify({
      type: "text",
      timestamp: 1773494848628,
      sessionID: "ses_text_1",
      part: {
        id: "prt_text_1",
        sessionID: "ses_text_1",
        messageID: "msg_text_1",
        type: "text",
        text: "Hello! How can I help you today?",
        time: {
          start: 1773494848627,
          end: 1773494848627,
        },
      },
    }),
    JSON.stringify({
      type: "step_finish",
      timestamp: 1773494849533,
      sessionID: "ses_text_1",
      part: {
        id: "prt_step_2",
        sessionID: "ses_text_1",
        messageID: "msg_text_1",
        type: "step-finish",
        reason: "stop",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
        cost: 0,
        tokens: {
          total: 14176,
          input: 78,
          output: 42,
          reasoning: 0,
          cache: {
            read: 14056,
            write: 0,
          },
        },
      },
    }),
  ];

  return lines.map((line) => `console.log(${JSON.stringify(line)});`).join(" ");
}

function buildOpencodeToolStreamScript(): string {
  const lines = [
    JSON.stringify({
      type: "step_start",
      timestamp: 1773494918719,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_step_1",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_1",
        type: "step-start",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
      },
    }),
    JSON.stringify({
      type: "tool_use",
      timestamp: 1773494919457,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_1",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_1",
        type: "tool",
        callID: "call_function_pkizn92w8xfx_1",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "ls -la",
            description: "List files in current directory",
          },
          output: "total 280\n...",
          title: "List files in current directory",
          metadata: {
            exit: 0,
            truncated: false,
          },
          time: {
            start: 1773494919426,
            end: 1773494919456,
          },
        },
      },
    }),
    JSON.stringify({
      type: "step_finish",
      timestamp: 1773494919515,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_step_2",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_1",
        type: "step-finish",
        reason: "tool-calls",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
        cost: 0,
        tokens: {
          total: 14206,
          input: 78,
          output: 60,
          reasoning: 0,
          cache: {
            read: 14050,
            write: 18,
          },
        },
      },
    }),
    JSON.stringify({
      type: "step_start",
      timestamp: 1773494928647,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_step_3",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_2",
        type: "step-start",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
      },
    }),
    JSON.stringify({
      type: "text",
      timestamp: 1773494929236,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_text_1",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_2",
        type: "text",
        text: "ok",
        time: {
          start: 1773494929234,
          end: 1773494929234,
        },
      },
    }),
    JSON.stringify({
      type: "step_finish",
      timestamp: 1773494929304,
      sessionID: "ses_tool_1",
      part: {
        id: "prt_tool_step_4",
        sessionID: "ses_tool_1",
        messageID: "msg_tool_2",
        type: "step-finish",
        reason: "stop",
        snapshot: "fa25792db706eaf87b3027cb832379d88f7b3722",
        cost: 0,
        tokens: {
          total: 15248,
          input: 1079,
          output: 36,
          reasoning: 0,
          cache: {
            read: 14050,
            write: 83,
          },
        },
      },
    }),
  ];

  return lines.map((line) => `console.log(${JSON.stringify(line)});`).join(" ");
}

describe("opencode adapter", () => {
  test("builds opencode run invocation with resume and model", () => {
    const adapter = new OpenCodeAdapter(
      {
        cmd: "opencode",
        workDir: "/Users/felixwang/Desktop/d-connect",
        model: "anthropic/claude-sonnet-4",
        args: ["--config", "/tmp/opencode.json"],
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "session-1") as {
      cmd: string;
      args: string[];
      stdinPrompt: boolean;
      cwd?: string;
    };

    expect(invocation.cmd).toBe("opencode");
    expect(invocation.cwd).toBe("/Users/felixwang/Desktop/d-connect");
    expect(invocation.stdinPrompt).toBe(false);
    expect(invocation.args).toEqual([
      "--config",
      "/tmp/opencode.json",
      "run",
      "--format",
      "json",
      "--session",
      "session-1",
      "--model",
      "anthropic/claude-sonnet-4",
      "hello",
    ]);
  });

  test("maps opencode CLI text stream to session id and final result", async () => {
    const adapter = new OpenCodeAdapter(
      {
        cmd: process.execPath,
        args: ["-e", buildOpencodeTextStreamScript(), "--"],
      },
      new Logger("error"),
    );

    const session = await adapter.startSession();
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => {
      events.push(event);
    });

    await session.send("hello");

    expect(session.currentSessionId()).toBe("ses_text_1");
    expect(events.filter((event) => event.type === "text").map((event) => event.content)).toEqual([
      "Hello! How can I help you today?",
    ]);
    expect(events.find((event) => event.type === "result")?.content).toBe("Hello! How can I help you today?");

    await adapter.stop();
  });

  test("maps opencode CLI tool stream to tool result, text and final result", async () => {
    const adapter = new OpenCodeAdapter(
      {
        cmd: process.execPath,
        args: ["-e", buildOpencodeToolStreamScript(), "--"],
      },
      new Logger("error"),
    );

    const session = await adapter.startSession();
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => {
      events.push(event);
    });

    await session.send("hello");

    expect(session.currentSessionId()).toBe("ses_tool_1");
    expect(
      events.some(
        (event) =>
          event.type === "tool_use" &&
          event.toolName === "bash" &&
          event.toolInput === "ls -la",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool_result" &&
          event.toolName === "bash" &&
          event.content?.startsWith("total 280"),
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "text").map((event) => event.content)).toEqual([
      "ok",
    ]);
    expect(events.find((event) => event.type === "result")?.content).toBe("ok");

    await adapter.stop();
  });
});
