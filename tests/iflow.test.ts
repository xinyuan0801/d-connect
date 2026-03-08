import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  IFlowAdapter,
  createIFlowAdapter,
  findLatestTranscript,
  recordAssistantTools,
  recordToolResults,
  readTranscriptDelta,
  shouldFinishByIdleState,
  shouldFinishByNoResultState,
  type IFlowPendingToolState,
} from "../src/adapters/agent/iflow.js";
import { extractAssistantParts } from "../src/adapters/agent/iflow-transcript.js";
import { Logger } from "../src/logging.js";

function createState(): IFlowPendingToolState {
  return {
    pendingTools: new Map(),
    seenToolUseIds: new Set(),
    completedToolUseIds: new Set(),
    pendingStartedAt: 0,
  };
}

describe("iflow pending tool tracking", () => {
  test("new session only attaches transcripts created after the turn starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-"));
    const sessionDir = join(root, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const oldTranscript = join(sessionDir, "session-old.jsonl");
    const newTranscript = join(sessionDir, "session-new.jsonl");
    await writeFile(oldTranscript, "", "utf8");
    await writeFile(newTranscript, "", "utf8");

    const startedAtMs = Date.now();
    await utimes(oldTranscript, startedAtMs / 1000 - 5, startedAtMs / 1000 - 5);
    await utimes(newTranscript, startedAtMs / 1000 + 1, startedAtMs / 1000 + 1);

    expect(await findLatestTranscript(sessionDir, startedAtMs)).toBe(newTranscript);
  });

  test("does not re-queue a completed tool when assistant repeats the same tool_use", () => {
    const state = createState();

    const firstTools = recordAssistantTools(state, [{ id: "tool-1", name: "run_shell_command" }], 100);
    expect(firstTools).toHaveLength(1);
    expect(state.pendingTools.get("tool-1")).toBe("run_shell_command");
    expect(state.pendingStartedAt).toBe(100);

    const firstResults = recordToolResults(state, [{ id: "tool-1", output: "ok" }]);
    expect(firstResults).toHaveLength(1);
    expect(state.pendingTools.size).toBe(0);
    expect(state.pendingStartedAt).toBe(0);

    const repeatedTools = recordAssistantTools(state, [{ id: "tool-1", name: "run_shell_command" }], 200);
    expect(repeatedTools).toHaveLength(0);
    expect(state.pendingTools.size).toBe(0);
    expect(state.pendingStartedAt).toBe(0);
  });

  test("keeps id-less tool_use events visible", () => {
    const state = createState();
    const tools = recordAssistantTools(state, [{ name: "run_shell_command" }], 100);
    expect(tools).toEqual([{ name: "run_shell_command" }]);
    expect(state.pendingTools.size).toBe(0);
  });

  test("new sessions do not inherit a previous iflow conversation id", async () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
        mode: "yolo",
      },
      new Logger("error"),
    );

    await adapter.startSession("session-old");

    expect(adapter.buildIFlowArgs("hello", false)).not.toContain("session-old");
    expect(adapter.buildIFlowArgs("hello", false, "session-old")).toContain("session-old");

    await adapter.stop();
  });

  test("byte offsets still capture new transcript content after multibyte text", () => {
    const first = Buffer.from('{"text":"杭州今天天气如何"}\n', "utf8");
    const second = Buffer.from('{"text":"你刚才问的是杭州今天天气如何"}\n', "utf8");
    const full = Buffer.concat([first, second]);

    const delta = readTranscriptDelta(full, first.length);
    expect(delta.chunk).toContain("你刚才问的是杭州今天天气如何");
    expect(delta.nextOffset).toBe(full.length);
  });

  test("waits longer after tool activity before treating the turn as idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:31:09.000Z"));

    expect(
      shouldFinishByIdleState({
        resultChunks: ["我来帮你查询杭州今天的天气。"],
        pendingTools: new Map(),
        lastActivityAt: Date.now() - 1000,
        hadToolActivity: true,
        awaitingPostToolResponse: false,
      }),
    ).toBe(false);

    expect(
      shouldFinishByIdleState({
        resultChunks: ["我来帮你查询杭州今天的天气。"],
        pendingTools: new Map(),
        lastActivityAt: Date.now() - 6000,
        hadToolActivity: true,
        awaitingPostToolResponse: false,
      }),
    ).toBe(true);

    vi.useRealTimers();
  });

  test("does not finish idle when still waiting for text after tool execution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:31:09.000Z"));

    expect(
      shouldFinishByIdleState({
        resultChunks: ["我来帮你查询今天的新闻。"],
        pendingTools: new Map(),
        lastActivityAt: Date.now() - 10000,
        hadToolActivity: true,
        awaitingPostToolResponse: true,
      }),
    ).toBe(false);

    vi.useRealTimers();
  });

  test("does not trigger no-result timeout after tool activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:31:09.000Z"));

    expect(
      shouldFinishByNoResultState({
        resultChunks: [],
        pendingTools: new Map(),
        hadToolActivity: true,
        awaitingPostToolResponse: true,
        startedAt: Date.now() - 31000,
      }),
    ).toBe(false);

    vi.useRealTimers();
  });

  test("still triggers no-result timeout when nothing was ever emitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:31:09.000Z"));

    expect(
      shouldFinishByNoResultState({
        resultChunks: [],
        pendingTools: new Map(),
        hadToolActivity: false,
        awaitingPostToolResponse: false,
        startedAt: Date.now() - 31000,
      }),
    ).toBe(true);

    vi.useRealTimers();
  });

  test("preserves assistant content order between text and tool_use", () => {
    expect(
      extractAssistantParts([
        { type: "text", text: "我来帮你搜一下。" },
        { type: "tool_use", id: "web_search:0", name: "web_search", input: { query: "hello" } },
      ]),
    ).toEqual([
      { type: "text", text: "我来帮你搜一下。" },
      { type: "tool_use", tool: { id: "web_search:0", name: "web_search", input: { query: "hello" } } },
    ]);
  });

  test("tool timeouts are logged without appending timeout text to the reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:04:44.000Z"));

    const logger = new Logger("error");
    const warnSpy = vi.spyOn(logger, "warn");
    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
        mode: "yolo",
      },
      logger,
    );

    const session = (await adapter.startSession("session-timeout")) as any;
    const turn = {
      resultChunks: ["我来帮你创建这个定时任务。"],
      pendingTools: new Map([["run_shell_command:0", "run_shell_command"]]),
      pendingStartedAt: Date.now() - 46000,
      pendingTimeoutMs: 45000,
      lastTextAt: 0,
    };

    expect(session.shouldFinishByToolTimeout(turn)).toBe(true);
    expect(turn.resultChunks).toEqual(["我来帮你创建这个定时任务。"]);
    expect(turn.pendingTools.size).toBe(0);
    expect(turn.pendingStartedAt).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith("iflow tool execution timed out", {
      sessionId: "session-timeout",
      pendingTools: ["run_shell_command"],
      timeoutMs: 45000,
      mode: "yolo",
    });

    await adapter.stop();
    vi.useRealTimers();
  });
});
