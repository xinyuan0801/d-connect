import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  IFlowAdapter,
  createIFlowAdapter,
  findLatestTranscript,
  recordAssistantTools,
  recordToolResults,
  readTranscriptDelta,
  readTranscriptDeltaFromFile,
  shouldFinishByIdleState,
  shouldFinishByNoResultState,
  type IFlowPendingToolState,
} from "../src/adapters/agent/iflow.js";
import {
  extractAssistantParts,
  extractLatestExecutionInfo,
  iflowProjectKey,
  sanitizeIFlowAssistantText,
} from "../src/adapters/agent/iflow-transcript.js";
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

  test("findLatestTranscript also scans .iflow-aone fallback directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-fallback-"));
    const primaryDir = join(root, ".iflow", "projects", "demo");
    const fallbackDir = join(root, ".iflow-aone", "projects", "demo");
    await mkdir(primaryDir, { recursive: true });
    await mkdir(fallbackDir, { recursive: true });

    const oldTranscript = join(primaryDir, "session-old.jsonl");
    const fallbackTranscript = join(fallbackDir, "session-fallback.jsonl");
    await writeFile(oldTranscript, "", "utf8");
    await writeFile(fallbackTranscript, "", "utf8");

    const startedAtMs = Date.now();
    await utimes(oldTranscript, startedAtMs / 1000 - 5, startedAtMs / 1000 - 5);
    await utimes(fallbackTranscript, startedAtMs / 1000 + 1, startedAtMs / 1000 + 1);

    expect(await findLatestTranscript([primaryDir, fallbackDir], startedAtMs)).toBe(fallbackTranscript);
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
      },
      new Logger("error"),
    );

    await adapter.startSession("session-old");

    expect(adapter.buildIFlowArgs("hello", false)).not.toContain("session-old");
    expect(adapter.buildIFlowArgs("hello", false, "session-old")).toContain("session-old");

    await adapter.stop();
  });

  test("legacy mode values are ignored and iflow is always started in yolo mode", () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
        mode: "plan",
      } as any,
      new Logger("error"),
    );

    expect(adapter.buildIFlowArgs("hello", false)).toContain("--yolo");
    expect(adapter.buildIFlowArgs("hello", false)).not.toContain("--plan");
    expect(adapter.getMode()).toBe("yolo");
  });

  test("buildIFlowArgs uses -p prompt flag instead of legacy -i", () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const args = adapter.buildIFlowArgs("hello", false);
    expect(args).toContain("-p");
    expect(args).not.toContain("-i");
  });

  test("buildIFlowArgs appends --output-file when turn output path is provided", () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const outputFile = "/tmp/d-connect-iflow-output/test.json";
    const args = adapter.buildIFlowArgs("hello", false, "", outputFile);
    const outputFlagIndex = args.indexOf("--output-file");

    expect(outputFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[outputFlagIndex + 1]).toBe(outputFile);
  });

  test("buildIFlowArgs does not duplicate --output-file when user args already include it", () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
        args: ["--output-file", "/tmp/custom-iflow-output.json"],
      },
      new Logger("error"),
    );

    const args = adapter.buildIFlowArgs("hello", false, "", "/tmp/ignored.json");
    expect(args.filter((arg) => arg === "--output-file")).toHaveLength(1);
    expect(args).toContain("/tmp/custom-iflow-output.json");
    expect(args).not.toContain("/tmp/ignored.json");
  });

  test("spawnEnv prepends node executable directory using platform delimiter", () => {
    const adapter = createIFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const env = adapter.spawnEnv();
    const pathKey = process.platform === "win32" && typeof env.Path === "string" ? "Path" : "PATH";
    const pathValue = env[pathKey] ?? "";
    const nodeDir = dirname(process.execPath);

    expect(pathValue === nodeDir || pathValue.startsWith(`${nodeDir}${delimiter}`)).toBe(true);
  });

  test("byte offsets still capture new transcript content after multibyte text", () => {
    const first = Buffer.from('{"text":"杭州今天天气如何"}\n', "utf8");
    const second = Buffer.from('{"text":"你刚才问的是杭州今天天气如何"}\n', "utf8");
    const full = Buffer.concat([first, second]);

    const delta = readTranscriptDelta(full, first.length);
    expect(delta.chunk).toContain("你刚才问的是杭州今天天气如何");
    expect(delta.nextOffset).toBe(full.length);
  });

  test("tail reader captures only appended transcript bytes from file", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-tail-"));
    const transcriptPath = join(root, "session-tail.jsonl");
    const first = '{"type":"assistant","message":{"content":[{"type":"text","text":"第一段"}]}}\n';
    const second = '{"type":"assistant","message":{"content":[{"type":"text","text":"第二段"}]}}\n';
    await writeFile(transcriptPath, `${first}${second}`, "utf8");

    const delta = await readTranscriptDeltaFromFile(transcriptPath, Buffer.byteLength(first, "utf8"));
    expect(delta.found).toBe(true);
    expect(delta.truncated).toBe(false);
    expect(delta.chunk).toContain("第二段");
    expect(delta.nextOffset).toBe(Buffer.byteLength(`${first}${second}`, "utf8"));
  });

  test("loadNewTranscript falls back to .iflow-aone after .iflow misses", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const homeRoot = await mkdtemp(join(tmpdir(), "d-connect-iflow-home-"));
    const workDir = await mkdtemp(join(tmpdir(), "d-connect-iflow-work-"));
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;

    const adapter = new IFlowAdapter(
      {
        workDir,
      },
      new Logger("error"),
    );

    try {
      const session = (await adapter.startSession("session-fallback")) as any;
      const turn = {
        transcriptPath: undefined,
        transcriptBindingSource: undefined,
        outputFilePath: undefined,
        offset: 0,
        partial: "",
        outputProbe: "",
        resultChunks: [],
        lastTextAt: 0,
        lastActivityAt: Date.now(),
        lastToolActivityAt: 0,
        hadToolActivity: false,
        awaitingPostToolResponse: false,
        pendingTools: new Map(),
        seenToolUseIds: new Set(),
        completedToolUseIds: new Set(),
        pendingStartedAt: 0,
        pendingTimeoutMs: adapter.pendingToolTimeoutMs(),
        startedAt: Date.now(),
      };

      session.bindTranscriptBySessionId(turn, "session-fallback", "test");
      await session.loadNewTranscript(turn);
      expect(turn.resultChunks).toEqual([]);

      const fallbackDir = join(homeRoot, ".iflow-aone", "projects", iflowProjectKey(workDir));
      const fallbackTranscript = join(fallbackDir, "session-fallback.jsonl");
      await mkdir(fallbackDir, { recursive: true });
      await writeFile(
        fallbackTranscript,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"来自 .iflow-aone 的 transcript"}]}}\n',
        "utf8",
      );

      await session.loadNewTranscript(turn);
      expect(turn.transcriptPath).toBe(fallbackTranscript);
      expect(turn.resultChunks).toEqual(["来自 .iflow-aone 的 transcript"]);
    } finally {
      await adapter.stop();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  });

  test("loadNewTranscript includes tool input raw payload for tool_use events", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-tool-raw-"));
    const transcriptPath = join(root, "session-tool.jsonl");
    await writeFile(
      transcriptPath,
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"run_shell_command","input":{"description":"启动开发服务器","command":"pnpm run dev"}}]}}\n',
      "utf8",
    );

    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-tool-raw")) as any;
    session.currentSessionId = () => "";
    const events: Array<{ type?: string; toolName?: string; toolInput?: string; toolInputRaw?: Record<string, unknown> }> = [];
    session.on("event", (event: { type?: string; toolName?: string; toolInput?: string; toolInputRaw?: Record<string, unknown> }) => {
      events.push(event);
    });

    const turn = {
      transcriptPath,
      transcriptBindingSource: "session-id",
      outputFilePath: undefined,
      offset: 0,
      partial: "",
      outputProbe: "",
      resultChunks: [],
      lastTextAt: 0,
      lastActivityAt: Date.now(),
      lastToolActivityAt: 0,
      hadToolActivity: false,
      awaitingPostToolResponse: false,
      pendingTools: new Map(),
      seenToolUseIds: new Set(),
      completedToolUseIds: new Set(),
      pendingStartedAt: 0,
      pendingTimeoutMs: adapter.pendingToolTimeoutMs(),
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    await session.loadNewTranscript(turn);

    expect(events).toEqual([
      {
        type: "tool_use",
        requestId: "call_1",
        toolName: "run_shell_command",
        toolInput: "pnpm run dev",
        toolInputRaw: {
          description: "启动开发服务器",
          command: "pnpm run dev",
        },
      },
    ]);

    await adapter.stop();
  });

  test("extracts session id from execution info block", () => {
    const info = extractLatestExecutionInfo(`some text
<Execution Info>
{
  "session-id": "session-abc",
  "conversation-id": "conv-123"
}
</Execution Info>`);
    expect(info?.sessionId).toBe("session-abc");
    expect(info?.conversationId).toBe("conv-123");
  });

  test("extracts session id from partial execution info tail", () => {
    const info = extractLatestExecutionInfo(`<Execution Info>
{
  "session-id": "session-tail"
`);
    expect(info?.sessionId).toBe("session-tail");
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
        startedAt: Date.now() - 61000,
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

  test("sanitizes Aone bootstrap wrappers and execution info blocks", () => {
    const raw = `Using cached Aone authentication.

Hello! Welcome to iFlow CLI.

I see you're working in \`/Users/wxy/third-step\` on macOS.

The workspace appears to be empty currently.

这里是最终答复内容。

<Execution Info>
{
  "session-id": "session-3f897e64",
  "conversation-id": "93a008df"
}
</Execution Info>`;

    expect(sanitizeIFlowAssistantText(raw)).toBe("这里是最终答复内容。");
  });

  test("sanitizes session resume and SDK shutdown noise after the final answer", () => {
    const raw = `当前目录包含以下四个文件：
1. index.html - 这是一个前端抽奖系统的HTML页面
2. style.css - 包含页面样式
3. script.js - 实现抽奖逻辑
4. lottery-result.jpg - 抽奖结果截图

整体来看，这是一个完整的前端抽奖系统，具有良好的用户界面和交互体验。
ℹ️  Resuming session
session-57ec4bfa-e913-45c6-8545-2a20311e8fd4 (2 messages loaded)
Error shutting down SDK: TypeError: r is not a function
    at _promiseQueue.pushPromise._transport.send.then.r.code (file:///Users/wxy/.nvm/versions/node/v22.17.1/lib/node_modules/@ali/iflow-cli/bundle/iflow.js:446:99411)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`;

    expect(sanitizeIFlowAssistantText(raw)).toBe(`当前目录包含以下四个文件：
1. index.html - 这是一个前端抽奖系统的HTML页面
2. style.css - 包含页面样式
3. script.js - 实现抽奖逻辑
4. lottery-result.jpg - 抽奖结果截图

整体来看，这是一个完整的前端抽奖系统，具有良好的用户界面和交互体验。`);
  });

  test("fallback metadata-only output emits friendly result instead of raw wrapper text", async () => {
    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-meta-only")) as any;
    session.runSingleTurn = vi.fn(async (_prompt: string, _continueConversation: boolean, _turn: unknown, tails: { stdout: string; stderr: string }) => {
      tails.stdout = `Using cached Aone authentication.

Hello! Welcome to iFlow CLI.

How can I assist you today?

<Execution Info>
{
  "session-id": "session-3f897e64"
}
</Execution Info>`;
      tails.stderr = "";
      return { code: 0, signal: null };
    });

    const events: Array<{ type?: string; content?: string }> = [];
    session.on("event", (event: { type?: string; content?: string }) => {
      events.push(event);
    });

    await session.send("hello");

    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.content).toBe("iflow 返回了会话元信息，但没有产出可转发的最终回复。");

    await adapter.stop();
  });

  test("uses background command id as post-tool fallback when no final reply is produced", async () => {
    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-bg-command")) as any;
    session.runSingleTurn = vi.fn(
      async (_prompt: string, _continueConversation: boolean, turn: { awaitingPostToolResponse: boolean; lastToolResultToolName?: string; lastToolResultContent?: string }) => {
        turn.awaitingPostToolResponse = true;
        turn.lastToolResultToolName = "run_shell_command";
        turn.lastToolResultContent = "Command running in background with ID: 36414";
        return { code: 0, signal: null };
      },
    );

    const events: Array<{ type?: string; content?: string }> = [];
    session.on("event", (event: { type?: string; content?: string }) => {
      events.push(event);
    });

    await session.send("start dev server");

    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.content).toBe("命令已在后台启动，任务 ID: 36414。");

    await adapter.stop();
  });

  test("tool timeouts are logged without appending timeout text to the reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:04:44.000Z"));

    const logger = new Logger("error");
    const warnSpy = vi.spyOn(logger, "warn");
    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      logger,
    );

    const session = (await adapter.startSession("session-timeout")) as any;
    const turn = {
      resultChunks: ["我来帮你创建这个定时任务。"],
      pendingTools: new Map([["run_shell_command:0", "run_shell_command"]]),
      pendingStartedAt: Date.now() - 181000,
      pendingTimeoutMs: 180000,
      lastTextAt: 0,
      lastActivityAt: Date.now() - 181000,
    };

    expect(session.shouldFinishByToolTimeout(turn)).toBe(true);
    expect(turn.resultChunks).toEqual(["我来帮你创建这个定时任务。"]);
    expect(turn.pendingTools.size).toBe(0);
    expect(turn.pendingStartedAt).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith("iflow tool execution timed out", {
      sessionId: "session-timeout",
      pendingTools: ["run_shell_command"],
      timeoutMs: 180000,
      mode: "yolo",
    });

    await adapter.stop();
    vi.useRealTimers();
  });

  test("tool timeout ignores old pending tools when newer transcript activity exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:04:44.000Z"));

    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-timeout-active")) as any;
    const turn = {
      resultChunks: [],
      pendingTools: new Map([["ReadCommandOutput:0", "ReadCommandOutput"]]),
      pendingStartedAt: Date.now() - 181000,
      pendingTimeoutMs: 180000,
      lastTextAt: 0,
      lastActivityAt: Date.now() - 10000,
    };

    expect(session.shouldFinishByToolTimeout(turn)).toBe(false);
    expect(turn.pendingTools.size).toBe(1);

    await adapter.stop();
    vi.useRealTimers();
  });

  test("hard timeout waits for transcript inactivity instead of total turn age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:04:44.000Z"));

    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-hard-timeout")) as any;
    const activeTurn = {
      resultChunks: [],
      pendingTools: new Map([["call_read:0", "ReadCommandOutput"]]),
      pendingStartedAt: Date.now() - 180000,
      pendingTimeoutMs: 180000,
      lastTextAt: 0,
      lastActivityAt: Date.now() - 10000,
      startedAt: Date.now() - 121000,
    };

    expect(session.shouldFinishByHardTimeout(activeTurn)).toBe(false);
    expect(activeTurn.resultChunks).toEqual([]);

    const stalledTurn = {
      ...activeTurn,
      pendingTools: new Map([["call_read:0", "ReadCommandOutput"]]),
      resultChunks: [],
      lastActivityAt: Date.now() - 121000,
    };

    expect(session.shouldFinishByHardTimeout(stalledTurn)).toBe(true);
    expect(stalledTurn.resultChunks).toEqual(["iflow turn timeout"]);
    expect(stalledTurn.pendingTools.size).toBe(0);

    await adapter.stop();
    vi.useRealTimers();
  });

  test("close kills active iflow child process", async () => {
    const adapter = new IFlowAdapter(
      {
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-close")) as any;
    const fakeChild = {
      killed: false,
      kill: vi.fn((signal: NodeJS.Signals) => {
        fakeChild.killed = true;
        return signal === "SIGTERM";
      }),
    };
    session.child = fakeChild;

    await session.close();
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    await adapter.stop();
  });
});
