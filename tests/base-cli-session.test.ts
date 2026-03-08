import { describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/logging.js";
import type { AgentEvent } from "../src/runtime/types.js";
import { BaseCliSession, type Invocation } from "../src/adapters/agent/shared/base-cli-session.js";

class TestCliSession extends BaseCliSession {
  constructor(
    private readonly script: string,
    private readonly cwd?: string,
  ) {
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
      cwd: this.cwd,
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

  test("keeps PWD aligned with invocation cwd", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "d-connect-cwd-"));
    const session = new TestCliSession(
      'console.log("text:cwd="+process.cwd()); console.log("text:pwd="+(process.env.PWD||""));',
      workDir,
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));

    await session.send("ignored");

    const contents = events
      .filter((event) => event.type === "text")
      .map((event) => event.content);
    const cwdLine = contents.find((content) => content?.startsWith("cwd="));
    const pwdLine = contents.find((content) => content?.startsWith("pwd="));
    expect(cwdLine).toBeTruthy();
    expect(pwdLine).toBeTruthy();
    const cwdValue = cwdLine?.slice("cwd=".length);
    const pwdValue = pwdLine?.slice("pwd=".length);
    const normalizePath = (value: string | undefined): string =>
      (value ?? "").replace(/^\/private/u, "");
    expect(normalizePath(cwdValue)).toBe(normalizePath(workDir));
    expect(normalizePath(pwdValue)).toBe(normalizePath(workDir));
  });
});
