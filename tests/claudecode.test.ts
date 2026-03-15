import { describe, expect, test } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/agent/claudecode.js";
import { Logger } from "../src/logging.js";
import type { AgentEvent } from "../src/runtime/types.js";

describe("claudecode adapter", () => {
  test("ignores legacy mode values and always uses bypassPermissions", () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
        mode: "plan",
      } as any,
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "") as { args: string[] };
    const modeIndex = invocation.args.indexOf("--permission-mode");

    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.args[modeIndex + 1]).toBe("bypassPermissions");
  });

  test("buildInvocation applies model and allowedTools arguments", () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
        model: "claude-3-5-sonnet-20250219",
        args: ["--verbose", "--allowedTools", "toolA,toolB"],
        allowedTools: ["bash", "read_file"],
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "session-x") as {
      cmd: string;
      args: string[];
      stdinPrompt: boolean;
      cwd?: string;
      env?: Record<string, string>;
    };

    expect(invocation.cmd).toBe("claude");
    expect(invocation.args).toContain("--model");
    expect(invocation.args).toContain("claude-3-5-sonnet-20250219");
    expect(invocation.args).toContain("--resume");
    expect(invocation.args).toContain("session-x");
    expect(invocation.args).toContain("--permission-mode");
    expect(invocation.args).toContain("bypassPermissions");
    expect(invocation.args).toContain("--allowedTools");
    expect(invocation.args).toContain("toolA,toolB");
    expect(invocation.args).toContain("-p");
    expect(invocation.args.at(-1)).toBe("hello");
  });

  test("uses stdin prompt when configured", () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        stdinPrompt: true,
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "") as {
      args: string[];
      stdinPrompt: boolean;
    };

    expect(invocation.stdinPrompt).toBe(true);
    expect(invocation.args).not.toContain("-p");
  });

  test("uses custom promptArg when provided", () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        promptArg: "--message",
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "session-1") as {
      args: string[];
      cwd?: string;
    };

    const argIndex = invocation.args.indexOf("--message");
    expect(argIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.args[argIndex + 1]).toBe("hello");
  });

  test("enables Claude agent team env by default while preserving explicit overrides", () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "") as {
      env?: Record<string, string>;
    };
    expect(invocation.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");

    const overridden = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
        },
      },
      new Logger("error"),
    );
    const overriddenInvocation = (overridden as any).buildInvocation("hello", "") as {
      env?: Record<string, string>;
    };
    expect(overriddenInvocation.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("0");
  });

  test("parseOutputLine emits text, reasoning and tool events for assistant stream", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-parse")) as any;

    const events = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-parse",
        message: {
          content: [
            { type: "text", text: "start" },
            { type: "thinking", thinking: "plan" },
            {
              type: "tool_use",
              name: "Read",
              input: {
                file_path: "/tmp/file.txt",
              },
            },
          ],
        },
      }),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        { type: "text", sessionId: "session-parse", content: "start" },
        { type: "thinking", sessionId: "session-parse", content: "plan" },
        expect.objectContaining({
          type: "tool_use",
          toolName: "Read",
          toolInput: "/tmp/file.txt",
        }),
      ]),
    );

    await adapter.stop();
  });

  test("parseOutputLine emits tool result and error event from user stream", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-user")) as any;

    const output = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "user",
        session_id: "session-user",
        message: {
          content: [
            {
              type: "tool_result",
              content: "done",
              is_error: true,
            },
            {
              type: "tool_result",
              content: "ok",
            },
          ],
        },
      }),
    );

    expect(output).toEqual([
      {
        type: "error",
        sessionId: "session-user",
        content: "done",
      },
      {
        type: "tool_result",
        sessionId: "session-user",
        content: "ok",
      },
    ]);

    await adapter.stop();
  });

  test("parseOutputLine emits team created event from structured tool result", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-team-create")) as any;

    const output = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "user",
        session_id: "session-team-create",
        tool_use_result: {
          team_name: "alpha-team",
          team_file_path: "/tmp/.claude/teams/alpha-team/config.json",
          lead_agent_id: "lead-1",
        },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "TeamCreate:toolu_123",
              content: [{ type: "text", text: "team created" }],
            },
          ],
        },
      }),
    );

    expect(output).toEqual([
      {
        type: "team_event",
        sessionId: "session-team-create",
        requestId: "TeamCreate:toolu_123",
        team: {
          kind: "team_created",
          teamName: "alpha-team",
          teamFilePath: "/tmp/.claude/teams/alpha-team/config.json",
          leadAgentId: "lead-1",
        },
      },
      {
        type: "tool_result",
        sessionId: "session-team-create",
        requestId: "TeamCreate:toolu_123",
        toolName: "TeamCreate",
        content: "team created",
      },
    ]);

    await adapter.stop();
  });

  test("parseOutputLine emits member spawned event from agent tool result", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-team-agent")) as any;

    const output = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "user",
        session_id: "session-team-agent",
        tool_use_result: {
          status: "teammate_spawned",
          team_name: "alpha-team",
          teammate_id: "agent-bob",
          name: "Bob",
          agent_type: "research",
          model: "claude-sonnet-4-5",
          color: "blue",
          plan_mode_required: true,
        },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "Agent:toolu_456",
              content: [{ type: "text", text: "spawned" }],
            },
          ],
        },
      }),
    );

    expect(output).toEqual([
      {
        type: "team_event",
        sessionId: "session-team-agent",
        requestId: "Agent:toolu_456",
        team: {
          kind: "member_spawned",
          teamName: "alpha-team",
          memberName: "Bob",
          memberId: "agent-bob",
          agentType: "research",
          model: "claude-sonnet-4-5",
          color: "blue",
          planModeRequired: true,
        },
      },
      {
        type: "tool_result",
        sessionId: "session-team-agent",
        requestId: "Agent:toolu_456",
        toolName: "Agent",
        content: "spawned",
      },
    ]);

    await adapter.stop();
  });

  test("parseOutputLine emits teammate task started system event", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-task-start")) as any;

    const output = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "system",
        session_id: "session-task-start",
        subtype: "task_started",
        task_type: "in_process_teammate",
        tool_use_id: "Agent:toolu_789",
        task_id: "12",
        description: "Bob: Investigate the failing build",
      }),
    );

    expect(output).toEqual([
      {
        type: "team_event",
        sessionId: "session-task-start",
        requestId: "Agent:toolu_789",
        team: {
          kind: "task_started",
          memberName: "Bob",
          taskId: "12",
          taskStatus: "in_progress",
          taskDescription: "Bob: Investigate the failing build",
        },
      },
    ]);

    await adapter.stop();
  });

  test("parseOutputLine ignores invalid non-json lines by parser fallback", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-fallback")) as any;
    const output = session.parseOutputLine("stdout", "   ");
    const errorOutput = session.parseOutputLine("stdout", "plain text");

    expect(output).toEqual([]);
    expect(errorOutput).toBeDefined();
    expect(Array.isArray(errorOutput)).toBe(true);

    await adapter.stop();
  });

  test("parseOutputLine handles system message with session id as empty text", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-system")) as any;
    const output = session.parseOutputLine("stdout", JSON.stringify({ type: "system", session_id: "session-system" }));

    expect(output).toEqual([{ type: "text", sessionId: "session-system", content: "" }]);

    await adapter.stop();
  });

  test("parseOutputLine emits empty text for assistant payload missing message", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-empty")) as any;
    const output = session.parseOutputLine("stdout", JSON.stringify({ type: "assistant", session_id: "session-empty" }));

    expect(output).toEqual([{ type: "text", sessionId: "session-empty", content: "" }]);

    await adapter.stop();
  });

  test("sends missing conversation fallback by re-queueing without resume", async () => {
    const sessionFailureScript = `
      const resumeIndex = process.argv.indexOf("--resume");
      const sessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "";
      if (sessionId === "session-lost") {
        console.error("no conversation found with session id");
        process.exit(1);
      }
      console.log(${JSON.stringify(
        JSON.stringify({
          type: "assistant",
          session_id: "session-restored",
          message: {
            content: [{ type: "text", text: "restored" }],
          },
        }),
      )});
    `;

    const adapter = new ClaudeCodeAdapter(
      {
        cmd: process.execPath,
        args: ["-e", sessionFailureScript, "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-lost")) as any;
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => {
      events.push(event);
    });

    await session.send("hello");

    expect(session.currentSessionId()).toBe("session-restored");
    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.content).toBe("restored");

    await adapter.stop();
  });

  test("parseOutputLine honors system events with and without session id", async () => {
    const adapter = new ClaudeCodeAdapter(
      {
        cmd: "claude",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-system")) as any;

    const withSession = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "system",
        session_id: "session-system",
      }),
    );
    const withoutSession = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "system",
      }),
    );

    expect(withSession).toEqual([{ type: "text", content: "", sessionId: "session-system" }]);
    expect(withoutSession).toEqual([
      {
        type: "text",
        content: undefined,
        done: false,
        requestId: undefined,
        sessionId: undefined,
        toolInput: undefined,
        toolInputRaw: undefined,
        toolName: undefined,
      },
    ]);

    await adapter.stop();
  });
});
