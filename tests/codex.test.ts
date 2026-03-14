import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import { CodexAdapter } from "../src/adapters/agent/codex.js";

function buildCodexStreamScript(): string {
  const lines = [
    JSON.stringify({
      type: "thread.started",
      thread_id: "thread-1",
    }),
    JSON.stringify({
      type: "turn.started",
    }),
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "/bin/zsh -lc 'ls -1A'",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "done from codex",
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }),
  ];

  return [
    `process.stderr.write(${JSON.stringify("2026-03-14T12:00:00.000000Z  WARN codex_core::shell_snapshot: ignored\\n")});`,
    ...lines.map((line) => `console.log(${JSON.stringify(line)});`),
  ].join(" ");
}

describe("codex adapter", () => {
  test("builds codex exec invocation with resume, mode and reasoning effort", () => {
    const adapter = new CodexAdapter(
      {
        cmd: "codex",
        workDir: "/Users/felixwang/Desktop/d-connect",
        model: "gpt-5-codex",
        args: ["--color", "never"],
        mode: "auto-edit",
        reasoning_effort: "high",
        search: true,
        skipGitRepoCheck: true,
        addDirs: ["/tmp/shared-a", "/tmp/shared-b"],
      } as any,
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "thread-1") as {
      cmd: string;
      args: string[];
      stdinPrompt: boolean;
      cwd?: string;
    };

    expect(invocation.cmd).toBe("codex");
    expect(invocation.cwd).toBe("/Users/felixwang/Desktop/d-connect");
    expect(invocation.stdinPrompt).toBe(false);
    expect(invocation.args).toEqual([
      "--color",
      "never",
      "exec",
      "resume",
      "--json",
      "--model",
      "gpt-5-codex",
      "-c",
      'model_reasoning_effort="high"',
      "--search",
      "--skip-git-repo-check",
      "--add-dir",
      "/tmp/shared-a",
      "--add-dir",
      "/tmp/shared-b",
      "--full-auto",
      "thread-1",
      "hello",
    ]);
  });

  test("uses stdin prompt when configured", () => {
    const adapter = new CodexAdapter(
      {
        cmd: "codex",
        stdinPrompt: true,
      },
      new Logger("error"),
    );

    const invocation = (adapter as any).buildInvocation("hello", "") as {
      args: string[];
      stdinPrompt: boolean;
    };

    expect(invocation.stdinPrompt).toBe(true);
    expect(invocation.args.at(-1)).toBe("-");
  });

  test("maps codex json stream to session id, tool and result events", async () => {
    const adapter = new CodexAdapter(
      {
        cmd: process.execPath,
        args: ["-e", buildCodexStreamScript(), "--"],
      },
      new Logger("error"),
    );

    const session = await adapter.startSession();
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => {
      events.push(event);
    });

    await session.send("hello");

    expect(session.currentSessionId()).toBe("thread-1");
    expect(events.some((event) => event.type === "tool_use" && event.toolName === "Bash")).toBe(true);
    expect(events.find((event) => event.type === "result")?.content).toBe("done from codex");
    expect(events.some((event) => event.content?.includes("shell_snapshot"))).toBe(false);

    await adapter.stop();
  });
});
