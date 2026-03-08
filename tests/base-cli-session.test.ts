import { describe, expect, test } from "vitest";
import { Logger } from "../src/logging.js";
import type { AgentEvent } from "../src/runtime/types.js";
import { BaseCliSession, type Invocation } from "../src/adapters/agent/shared/base-cli-session.js";

class TestCliSession extends BaseCliSession {
  constructor(private readonly script: string) {
    super(new Logger("error"), "session-1");
  }

  protected providerName(): string {
    return "test-cli";
  }

  protected buildInvocation(): Invocation {
    return {
      cmd: process.execPath,
      args: ["-e", this.script],
      stdinPrompt: false,
    };
  }

  protected parseOutputLine(_source: "stdout" | "stderr", line: string): AgentEvent[] {
    if (line.startsWith("text:")) {
      return [{ type: "text", content: line.slice(5) }];
    }
    if (line.startsWith("result:")) {
      return [{ type: "result", content: line.slice(7), done: true }];
    }
    if (line.startsWith("error:")) {
      return [{ type: "error", content: line.slice(6), done: true }];
    }
    return [];
  }
}

describe("base cli session", () => {
  test("emits fallback result from mixed stdout and stderr lines", async () => {
    const session = new TestCliSession('console.log("text:hello"); console.error("text:world");');
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));

    await session.send("ignored");

    expect(events).toEqual([
      { type: "text", content: "hello" },
      { type: "text", content: "world" },
      { type: "result", content: "hello\nworld", done: true },
    ]);
  });

  test("rejects when child exits non-zero", async () => {
    const session = new TestCliSession('console.error("text:before-exit"); process.exit(2);');

    await expect(session.send("ignored")).rejects.toThrow(/test-cli process exited with code 2/);
  });

  test("guards concurrent sends with busy state", async () => {
    const session = new TestCliSession('setTimeout(() => console.log("text:later"), 50); setTimeout(() => process.exit(0), 70);');

    const first = session.send("ignored");
    await expect(session.send("ignored")).rejects.toThrow(/busy/);
    await first;
  });
});
