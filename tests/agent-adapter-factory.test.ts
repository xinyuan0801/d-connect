import { describe, expect, test, vi } from "vitest";
import type { ResolvedProjectConfig } from "../src/config/normalize.js";
import { Logger } from "../src/logging.js";

vi.mock("../src/adapters/agent/claudecode.js", () => ({
  createClaudeCodeAdapter: vi.fn(),
}));

vi.mock("../src/adapters/agent/codex.js", () => ({
  createCodexAdapter: vi.fn(),
}));

vi.mock("../src/adapters/agent/opencode.js", () => ({
  createOpenCodeAdapter: vi.fn(),
}));

vi.mock("../src/adapters/agent/qoder.js", () => ({
  createQoderAdapter: vi.fn(),
}));

vi.mock("../src/adapters/agent/iflow.js", () => ({
  createIFlowAdapter: vi.fn(),
}));
import * as claudecode from "../src/adapters/agent/claudecode.js";
import * as codex from "../src/adapters/agent/codex.js";
import * as iflow from "../src/adapters/agent/iflow.js";
import * as opencode from "../src/adapters/agent/opencode.js";
import * as qoder from "../src/adapters/agent/qoder.js";
import { createAgentAdapter } from "../src/adapters/agent/index.js";

function makeProject(type: string, options: Record<string, unknown>): ResolvedProjectConfig {
  return {
    name: "demo",
    agent: {
      type: type as ResolvedProjectConfig["agent"]["type"],
      options,
    },
    platforms: [],
    guard: {
      enabled: false,
    },
  };
}

function stubAdapter(name: string) {
  return {
    name,
    startSession: vi.fn(),
    stop: vi.fn(),
  };
}

describe("agent adapter factory", () => {
  test("creates adapter by type and normalizes base options", () => {
    const logger = new Logger("error");
    const adapter = stubAdapter("claude");

    vi.mocked(claudecode.createClaudeCodeAdapter).mockReturnValue(adapter as never);
    const result = createAgentAdapter(
      makeProject("claudecode", {
        cmd: "claude",
        args: ["chat", "session"],
        workDir: "/repo/work",
        model: "sonnet",
        promptArg: "ask",
        stdinPrompt: true,
        env: {
          ALLOWED: "1",
          BLOCKED: 2,
        },
      }),
      logger,
    );

    expect(result).toBe(adapter);
    expect(claudecode.createClaudeCodeAdapter).toHaveBeenCalledWith(
      {
        cmd: "claude",
        args: ["chat", "session"],
        workDir: "/repo/work",
        model: "sonnet",
        promptArg: "ask",
        stdinPrompt: true,
        env: {
          ALLOWED: "1",
        },
      },
      logger,
    );
  });

  test("routes each agent type to its own factory", () => {
    const logger = new Logger("error");
    const projectTypes: Array<{
      type: string;
      factory: (options: Record<string, unknown>, logger: Logger) => unknown;
      options: Record<string, unknown>;
    }> = [
      { type: "codex", factory: vi.mocked(codex.createCodexAdapter), options: { cmd: "codex" } },
      { type: "opencode", factory: vi.mocked(opencode.createOpenCodeAdapter), options: { cmd: "opencode" } },
      { type: "qoder", factory: vi.mocked(qoder.createQoderAdapter), options: { cmd: "qoder" } },
      { type: "iflow", factory: vi.mocked(iflow.createIFlowAdapter), options: { cmd: "iflow" } },
    ];

    for (const { type, factory, options } of projectTypes) {
      const adapter = stubAdapter(type);
      factory.mockClear().mockReturnValue(adapter as never);
      const result = createAgentAdapter(makeProject(type, options), logger);
      expect(result).toBe(adapter);
      expect(factory).toHaveBeenCalledWith(options, logger);
    }
  });

  test("rejects unsupported agent types", () => {
    const logger = new Logger("error");
    expect(() =>
      createAgentAdapter(
        {
          ...makeProject("legacy", {
            cmd: "legacy",
          }),
          agent: {
            type: "legacy" as never,
            options: { cmd: "legacy" },
          },
        },
        logger,
      ),
    ).toThrow("unsupported agent type: legacy");
  });
});
