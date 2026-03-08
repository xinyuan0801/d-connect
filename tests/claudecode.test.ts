import { describe, expect, test } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/agent/claudecode.js";
import { Logger } from "../src/logging.js";

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
});
