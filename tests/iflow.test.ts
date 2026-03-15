import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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
        cmd: "iflow",
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

  test("waitForTurnResult keeps polling transcript until child closes", async () => {
    vi.useFakeTimers();

    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-poll-until-close")) as any;
    const child = new EventEmitter() as EventEmitter & { once: typeof EventEmitter.prototype.once };
    const loadSpy = vi.fn(async () => {});
    session.loadNewTranscript = loadSpy;

    const waitPromise = session.waitForTurnResult(child, {
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    });

    await vi.advanceTimersByTimeAsync(650);
    expect(loadSpy).toHaveBeenCalledTimes(4);

    child.emit("close", 0, null);
    await expect(waitPromise).resolves.toEqual({ code: 0, signal: null });

    await adapter.stop();
    vi.useRealTimers();
  });

  test("close kills active iflow child process", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
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

  test("loadExecutionInfoFromOutputFile binds session when summary contains session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-output-summary-"));
    const outputPath = join(root, "summary.json");
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    await writeFile(
      outputPath,
      JSON.stringify({
        "session-id": "session-summary",
        "conversation-id": "conv-summary",
        assistantRounds: 4,
      }),
      "utf8",
    );

    const session = (await adapter.startSession("session-old")) as any;
    const turn = {
      transcriptPath: undefined,
      transcriptBindingSource: undefined,
      outputFilePath: outputPath,
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
      pendingStartedAt: 0,
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
      completedToolUseIds: new Set(),
    } as any;

    await session.loadExecutionInfoFromOutputFile(turn);

    expect(session.currentSessionId()).toBe("session-summary");
    expect(turn.transcriptBindingSource).toBe("session-id");
    expect(turn.transcriptPath).toBe(adapter.resolveTranscriptPath("session-summary"));

    await adapter.stop();
  });

  test("loadExecutionInfoFromOutputFile ignores malformed summary", async () => {
    const outputPath = join(await mkdtemp(join(tmpdir(), "d-connect-iflow-output-invalid-")), "bad.json");
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    await writeFile(outputPath, "{}", "utf8");
    const session = (await adapter.startSession("session-old")) as any;
    const turn = {
      transcriptPath: "/tmp/old-transcript.jsonl",
      transcriptBindingSource: "mtime",
      outputFilePath: outputPath,
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    await session.loadExecutionInfoFromOutputFile(turn);

    expect(session.currentSessionId()).toBe("session-old");
    expect(turn.transcriptBindingSource).toBe("mtime");
    expect(turn.transcriptPath).toBe("/tmp/old-transcript.jsonl");

    await adapter.stop();
  });

  test("probeExecutionInfoFromOutput binds transcript by session-id extracted from execution info", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-old")) as any;
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    session.probeExecutionInfoFromOutput(
      turn,
      `working...
<Execution Info>
{"session-id":"session-probed","conversation-id":"conv-probed"}
</Execution Info>`,
    );

    expect(session.currentSessionId()).toBe("session-probed");
    expect(turn.transcriptBindingSource).toBe("session-id");
    expect(turn.transcriptPath).toBe(adapter.resolveTranscriptPath("session-probed"));
  });

  test("bindTranscriptBySessionId keeps existing mtime transcript when it already has consumed content", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-old")) as any;
    const turn = {
      transcriptPath: "/tmp/current-transcript.jsonl",
      transcriptBindingSource: "mtime",
      outputFilePath: undefined,
      offset: 10,
      partial: "",
      outputProbe: "",
      resultChunks: ["already has text"],
      lastTextAt: 0,
      lastActivityAt: Date.now(),
      lastToolActivityAt: 0,
      hadToolActivity: false,
      awaitingPostToolResponse: false,
      pendingTools: new Map(),
      seenToolUseIds: new Set(),
      completedToolUseIds: new Set(),
      pendingStartedAt: 0,
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    session.bindTranscriptBySessionId(turn, "session-new", "session-state");

    expect(session.currentSessionId()).toBe("session-new");
    expect(turn.transcriptPath).toBe("/tmp/current-transcript.jsonl");
    expect(turn.transcriptBindingSource).toBe("mtime");
    expect(turn.offset).toBe(10);
  });

  test("bindTranscriptBySessionId adopts candidate transcript path when safe to switch", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-safe")) as any;
    const turn = {
      transcriptPath: "/tmp/old-transcript.jsonl",
      transcriptBindingSource: "mtime",
      outputFilePath: undefined,
      offset: 10,
      partial: "partial-seed",
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    session.bindTranscriptBySessionId(turn, "session-safe-switch", "session-state");

    expect(turn.transcriptPath).toBe(adapter.resolveTranscriptPath("session-safe-switch"));
    expect(turn.transcriptBindingSource).toBe("session-id");
    expect(turn.offset).toBe(0);
    expect(turn.partial).toBe("");
    expect(session.currentSessionId()).toBe("session-safe-switch");
  });

  test("loadNewTranscript handles truncated read offsets by resetting to zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-truncated-"));
    const transcriptPath = join(root, "session-truncated.jsonl");
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已完成" }] } }) + "\n";
    await writeFile(transcriptPath, line, "utf8");

    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-truncated")) as any;
    const turn = {
      transcriptPath,
      transcriptBindingSource: "mtime",
      outputFilePath: undefined,
      offset: line.length + 8,
      partial: "seed-partial",
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    await session.loadNewTranscript(turn);
    expect(turn.offset).toBe(0);
    expect(turn.partial).toBe("");
  });

  test("loadNewTranscript keeps unterminated line in partial without emitting an event", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-iflow-partial-"));
    const tempPath = join(root, "session-partial.jsonl");
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const transcriptPath = adapter.resolveTranscriptPath("session-partial", tempPath) ?? tempPath;

    await mkdir(dirname(transcriptPath), { recursive: true });
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pending" }] } });
    await writeFile(transcriptPath, line, "utf8");

    const session = (await adapter.startSession("session-partial")) as any;
    const turn = {
      transcriptPath,
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
      startedAt: Date.now(),
      lastToolResultToolName: undefined,
      lastToolResultContent: undefined,
    };

    await session.loadNewTranscript(turn);

    expect(turn.resultChunks).toEqual([]);
    expect(turn.partial).toBe(line);
  });

  test("buildPostToolFallback emits background-task message when run_shell_command output includes task id", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-fallback")) as any;

    const message = session.buildPostToolFallback({
      lastToolResultToolName: "run_shell_command",
      lastToolResultContent: "Command running in background with ID: abc123",
    });

    expect(message).toContain("任务 ID: abc123");
  });

  test("buildPostToolFallback emits generic fallback message for normal tool result", async () => {
    const adapter = new IFlowAdapter(
      {
        cmd: "iflow",
        workDir: "/Users/felixwang/Desktop/d-connect",
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-fallback")) as any;

    const message = session.buildPostToolFallback({
      lastToolResultToolName: "other_tool",
      lastToolResultContent: "done",
    });

    expect(message).toBe("iflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。");
  });
});
