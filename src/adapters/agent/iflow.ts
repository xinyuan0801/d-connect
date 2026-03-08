import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Logger } from "../../logging.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelSwitchable,
  ModeSwitchable,
  PermissionResult,
} from "../../runtime/types.js";
import type { BaseAgentOptions } from "./options.js";
import {
  extractAssistantParts,
  extractToolResults,
  type IFlowToolResult,
  type IFlowToolUse,
  iflowProjectKey,
  normalizeIFlowMode,
  summarizeToolInput,
} from "./iflow-transcript.js";

const TRANSCRIPT_POLL_MS = 200;
const TURN_IDLE_MS = 900;
const TURN_IDLE_AFTER_TOOL_MS = 5000;
const TURN_POST_TOOL_RESPONSE_TIMEOUT_MS = 30000;
const PENDING_TOOL_TIMEOUT_MS = 45000;
const PENDING_TOOL_TIMEOUT_DEFAULT_MODE_MS = 6000;
const TURN_HARD_TIMEOUT_MS = 120000;
const TURN_NO_RESULT_TIMEOUT_MS = 30000;

interface TranscriptLine {
  sessionId?: string;
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TurnState {
  transcriptPath?: string;
  offset: number;
  partial: string;
  resultChunks: string[];
  lastTextAt: number;
  lastActivityAt: number;
  lastToolActivityAt: number;
  hadToolActivity: boolean;
  awaitingPostToolResponse: boolean;
  pendingTools: Map<string, string>;
  seenToolUseIds: Set<string>;
  completedToolUseIds: Set<string>;
  pendingStartedAt: number;
  pendingTimeoutMs: number;
  startedAt: number;
}

export interface IFlowPendingToolState {
  pendingTools: Map<string, string>;
  seenToolUseIds: Set<string>;
  completedToolUseIds: Set<string>;
  pendingStartedAt: number;
}

export function recordAssistantTools(
  state: IFlowPendingToolState,
  tools: IFlowToolUse[],
  now = Date.now(),
): IFlowToolUse[] {
  const fresh: IFlowToolUse[] = [];

  for (const tool of tools) {
    if (!tool.id) {
      fresh.push(tool);
      continue;
    }

    if (state.seenToolUseIds.has(tool.id) || state.completedToolUseIds.has(tool.id)) {
      continue;
    }

    state.seenToolUseIds.add(tool.id);
    state.pendingTools.set(tool.id, tool.name);
    state.pendingStartedAt = state.pendingStartedAt || now;
    fresh.push(tool);
  }

  return fresh;
}

export function recordToolResults(state: IFlowPendingToolState, results: IFlowToolResult[]): IFlowToolResult[] {
  const fresh: IFlowToolResult[] = [];

  for (const result of results) {
    if (state.completedToolUseIds.has(result.id)) {
      continue;
    }

    state.pendingTools.delete(result.id);
    state.completedToolUseIds.add(result.id);
    fresh.push(result);
  }

  if (state.pendingTools.size === 0) {
    state.pendingStartedAt = 0;
  }

  return fresh;
}

function normalizePath(input: string): string {
  return resolve(input || process.cwd());
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function appendLimited(prev: string, add: string, maxLen = 10000): string {
  const next = `${prev}${add}`;
  if (next.length <= maxLen) {
    return next;
  }
  return next.slice(next.length - maxLen);
}

export function readTranscriptDelta(full: Buffer, offset: number): { chunk: string; nextOffset: number } {
  const nextChunk = full.subarray(offset);
  return {
    chunk: nextChunk.toString("utf8"),
    nextOffset: full.length,
  };
}

export function shouldFinishByIdleState(state: {
  resultChunks: string[];
  pendingTools: Map<string, string>;
  lastActivityAt: number;
  hadToolActivity: boolean;
  awaitingPostToolResponse: boolean;
}): boolean {
  if (state.resultChunks.length === 0) {
    return false;
  }
  if (state.pendingTools.size > 0) {
    return false;
  }
  if (state.awaitingPostToolResponse) {
    return false;
  }
  const idleMs = state.hadToolActivity ? TURN_IDLE_AFTER_TOOL_MS : TURN_IDLE_MS;
  return Date.now() - state.lastActivityAt >= idleMs;
}

export function shouldFinishByNoResultState(
  state: {
    resultChunks: string[];
    pendingTools: Map<string, string>;
    hadToolActivity: boolean;
    awaitingPostToolResponse: boolean;
    startedAt: number;
  },
  now = Date.now(),
): boolean {
  if (state.resultChunks.length > 0 || state.pendingTools.size > 0) {
    return false;
  }
  if (state.hadToolActivity || state.awaitingPostToolResponse) {
    return false;
  }
  return now - state.startedAt >= TURN_NO_RESULT_TIMEOUT_MS;
}

function safeJsonParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function toModeArgs(mode: "default" | "auto-edit" | "plan" | "yolo"): string[] {
  switch (mode) {
    case "auto-edit":
      return ["--autoEdit"];
    case "plan":
      return ["--plan"];
    case "yolo":
      return ["--yolo"];
    case "default":
    default:
      return ["--default"];
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function resolveScriptCommand(pathEnv = process.env.PATH): string | undefined {
  const commonBins = ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"];
  for (const candidate of commonBins) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const fallbackPaths = (pathEnv || "")
    .split(":")
    .filter(Boolean)
    .concat("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
    .map((dir) => join(dir, "script"));
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function buildPtyWrapper(cmd: string, args: string[]): { command: string; args: string[] } {
  const scriptCommand = resolveScriptCommand();

  if (process.platform === "linux" && scriptCommand) {
    const commandString = [cmd, ...args].map(shellQuote).join(" ");
    return {
      command: scriptCommand,
      args: ["-q", "-e", "-c", commandString, "/dev/null"],
    };
  }

  if (process.platform === "darwin" && scriptCommand) {
    return {
      command: scriptCommand,
      args: ["-q", "/dev/null", cmd, ...args],
    };
  }

  return { command: cmd, args };
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return Number(info.size);
  } catch {
    return 0;
  }
}

async function findLatestTranscript(sessionDir: string, startedAtMs: number): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const cutoffMs = startedAtMs - 2000;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith("session-") || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const path = join(sessionDir, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoffMs) {
        candidates.push({ path, mtimeMs: info.mtimeMs });
      }
    } catch {
      // skip
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}

class IFlowSession extends EventEmitter implements AgentSession {
  private readonly id: string;
  private agentSessionId: string;
  private alive = true;
  private busy = false;
  private sentOnce = false;

  constructor(private readonly adapter: IFlowAdapter, sessionId?: string) {
    super();
    this.id = sessionId && sessionId.length > 0 ? sessionId : randomUUID();
    this.agentSessionId = sessionId && sessionId.length > 0 ? sessionId : "";
  }

  currentSessionId(): string {
    return this.agentSessionId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // iFlow CLI v1 integration uses one-turn command execution.
  }

  private setAgentSessionId(sessionId: string): void {
    if (sessionId && sessionId.length > 0) {
      this.agentSessionId = sessionId;
    }
  }

  private emitAgentEvent(event: AgentEvent): void {
    const effectiveSessionId = this.currentSessionId();
    const nextEvent =
      event.sessionId || effectiveSessionId
        ? ({
            ...event,
            sessionId: event.sessionId ?? effectiveSessionId,
          } satisfies AgentEvent)
        : event;
    this.emit("event", nextEvent);
  }

  private async loadNewTranscript(turn: TurnState): Promise<void> {
    if (!turn.transcriptPath) {
      turn.transcriptPath = await findLatestTranscript(this.adapter.sessionDir, turn.startedAt);
      if (!turn.transcriptPath) {
        return;
      }
      // New transcript discovered during this turn: consume from the beginning.
      turn.offset = 0;
      turn.partial = "";
    }

    const full = await readFile(turn.transcriptPath);
    const { chunk: nextChunk, nextOffset } = readTranscriptDelta(full, turn.offset);
    if (!nextChunk) {
      return;
    }
    turn.offset = nextOffset;

    const data = turn.partial + nextChunk;
    const lines = data.split("\n");
    if (!data.endsWith("\n")) {
      turn.partial = lines.pop() ?? "";
    } else {
      turn.partial = "";
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const item = safeJsonParse<TranscriptLine>(line);
      if (!item) {
        continue;
      }

      if (item.sessionId) {
        this.setAgentSessionId(item.sessionId);
      }

      if (item.type === "assistant") {
        for (const part of extractAssistantParts(item.message?.content)) {
          if (part.type === "text") {
            turn.resultChunks.push(part.text);
            this.emitAgentEvent({ type: "text", content: part.text });
            turn.lastTextAt = Date.now();
            turn.lastActivityAt = turn.lastTextAt;
            if (turn.awaitingPostToolResponse) {
              turn.awaitingPostToolResponse = false;
            }
            continue;
          }

          for (const tool of recordAssistantTools(turn, [part.tool])) {
            turn.hadToolActivity = true;
            turn.awaitingPostToolResponse = true;
            turn.lastToolActivityAt = Date.now();
            turn.lastActivityAt = turn.lastToolActivityAt;
            this.emitAgentEvent({
              type: "tool_use",
              requestId: tool.id,
              toolName: tool.name,
              toolInput: summarizeToolInput(tool.input),
            });
          }
        }
      }

      if (item.type === "user") {
        const toolResults = extractToolResults(item.message?.content);
        if (toolResults.length > 0) {
          for (const result of recordToolResults(turn, toolResults)) {
            turn.hadToolActivity = true;
            turn.awaitingPostToolResponse = true;
            turn.lastToolActivityAt = Date.now();
            turn.lastActivityAt = turn.lastToolActivityAt;
            if (result.output.length > 0) {
              this.emitAgentEvent({
                type: "tool_result",
                requestId: result.id,
                content: result.output,
              });
            }
          }
        }
      }
    }
  }

  private shouldFinishByIdle(turn: TurnState): boolean {
    return shouldFinishByIdleState(turn);
  }

  private shouldFinishByToolTimeout(turn: TurnState): boolean {
    if (turn.pendingTools.size === 0 || turn.pendingStartedAt === 0) {
      return false;
    }
    if (Date.now() - turn.pendingStartedAt < turn.pendingTimeoutMs) {
      return false;
    }

    const names = [...new Set(turn.pendingTools.values())].filter(Boolean);
    const hint = names.length > 0 ? `pending tools: ${names.join(", ")}` : "tool calls timed out";
    const advice =
      this.adapter.getMode() === "default"
        ? " default mode requires interactive approval; switch to yolo or auto-edit for tool calls."
        : "";
    turn.resultChunks.push(`tool execution timeout (${hint}).${advice}`);
    turn.pendingTools.clear();
    turn.pendingStartedAt = 0;
    turn.lastTextAt = Date.now();
    return true;
  }

  private shouldFinishByPostToolResponseTimeout(turn: TurnState): boolean {
    if (!turn.awaitingPostToolResponse || turn.pendingTools.size > 0 || turn.lastToolActivityAt === 0) {
      return false;
    }
    if (Date.now() - turn.lastToolActivityAt < TURN_POST_TOOL_RESPONSE_TIMEOUT_MS) {
      return false;
    }
    return true;
  }

  private shouldFinishByNoResultTimeout(turn: TurnState): boolean {
    if (!shouldFinishByNoResultState(turn)) {
      return false;
    }
    turn.resultChunks.push("iflow did not produce transcript output in time");
    turn.lastTextAt = Date.now();
    return true;
  }

  private shouldFinishByHardTimeout(turn: TurnState): boolean {
    if (Date.now() - turn.startedAt < TURN_HARD_TIMEOUT_MS) {
      return false;
    }
    if (turn.resultChunks.length === 0) {
      turn.resultChunks.push("iflow turn timeout");
    }
    turn.pendingTools.clear();
    turn.pendingStartedAt = 0;
    turn.lastTextAt = Date.now();
    return true;
  }

  private async waitForTurnResult(child: ReturnType<typeof spawn>, turn: TurnState): Promise<SpawnResult> {
    const closePromise = new Promise<SpawnResult>((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

    let polling = false;

    const finishPromise = new Promise<"idle" | "timeout" | "no-result-timeout" | "hard-timeout">((resolve) => {
      const timer = setInterval(async () => {
        if (polling) {
          return;
        }
        polling = true;
        try {
          await this.loadNewTranscript(turn);
          if (this.shouldFinishByToolTimeout(turn)) {
            clearInterval(timer);
            resolve("timeout");
            return;
          }
          if (this.shouldFinishByPostToolResponseTimeout(turn)) {
            clearInterval(timer);
            resolve("no-result-timeout");
            return;
          }
          if (this.shouldFinishByNoResultTimeout(turn)) {
            clearInterval(timer);
            resolve("no-result-timeout");
            return;
          }
          if (this.shouldFinishByHardTimeout(turn)) {
            clearInterval(timer);
            resolve("hard-timeout");
            return;
          }
          if (this.shouldFinishByIdle(turn)) {
            clearInterval(timer);
            resolve("idle");
          }
        } finally {
          polling = false;
        }
      }, TRANSCRIPT_POLL_MS);
    });

    const closeOutcome: Promise<["closed", SpawnResult]> = closePromise.then((res) => ["closed", res] as const);
    const finishOutcome: Promise<["finished", "idle" | "timeout" | "no-result-timeout" | "hard-timeout"]> = finishPromise.then(
      (kind) => ["finished", kind] as const,
    );
    const outcome = await Promise.race([closeOutcome, finishOutcome]);

    if (outcome[0] === "finished") {
      child.kill("SIGTERM");
      const closed = await Promise.race([
        closePromise,
        new Promise<SpawnResult>((resolve) => setTimeout(() => resolve({ code: 0, signal: "SIGTERM" }), 3000)),
      ]);
      return closed;
    }

    return outcome[1];
  }

  async send(prompt: string): Promise<void> {
    if (!this.alive) {
      throw new Error("agent session is closed");
    }
    if (this.busy) {
      throw new Error("agent session is busy");
    }

    this.busy = true;

    let stdoutTail = "";
    let stderrTail = "";

    try {
      const iflowArgs = this.adapter.buildIFlowArgs(prompt, this.sentOnce, this.agentSessionId);
      const wrapped = buildPtyWrapper(this.adapter.command, iflowArgs);
      this.adapter.logger.debug("spawn iflow turn", {
        command: wrapped.command,
        args: wrapped.args,
      });

      const turn: TurnState = {
        transcriptPath: this.agentSessionId ? join(this.adapter.sessionDir, `${this.agentSessionId}.jsonl`) : undefined,
        offset: 0,
        partial: "",
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
        pendingTimeoutMs: this.adapter.pendingToolTimeoutMs(),
        startedAt: Date.now(),
      };

      if (turn.transcriptPath && existsSync(turn.transcriptPath)) {
        turn.offset = await fileSize(turn.transcriptPath);
      }

      const child = spawn(wrapped.command, wrapped.args, {
        cwd: this.adapter.workDir,
        env: this.adapter.spawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const spawnError = new Promise<never>((_, reject) => {
        child.once("error", (error) => {
          reject(new Error(`failed to spawn iflow process: ${error.message}`));
        });
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutTail = appendLimited(stdoutTail, chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = appendLimited(stderrTail, chunk.toString("utf8"));
      });

      const result = await Promise.race([this.waitForTurnResult(child, turn), spawnError]);
      await this.loadNewTranscript(turn);

      if (turn.awaitingPostToolResponse) {
        turn.resultChunks.push("iflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。");
      }

      const response = normalizeWhitespace(turn.resultChunks.join("\n\n"));
      this.sentOnce = true;

      if (response.length > 0) {
        this.emitAgentEvent({
          type: "result",
          content: response,
          done: true,
        });
        return;
      }

      if (result.code && result.code !== 0) {
        const details = normalizeWhitespace(`${stderrTail}\n${stdoutTail}`) || "no output";
        const err = `iflow turn failed (${result.code}): ${details}`;
        this.emitAgentEvent({ type: "error", content: err, done: true });
        throw new Error(err);
      }

      const fallback = normalizeWhitespace(`${stdoutTail}\n${stderrTail}`);
      if (fallback.length > 0) {
        this.emitAgentEvent({
          type: "result",
          content: fallback,
          done: true,
        });
        return;
      }

      this.emitAgentEvent({ type: "result", content: "done", done: true });
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    this.removeAllListeners();
  }
}

export class IFlowAdapter implements AgentAdapter, ModeSwitchable, ModelSwitchable {
  readonly name = "iflow";

  readonly command: string;
  readonly workDir: string;

  private modeValue: "default" | "auto-edit" | "plan" | "yolo";
  private modelValue: string;
  private readonly extraArgs: string[];
  private readonly extraEnv: Record<string, string>;

  private readonly sessions = new Set<IFlowSession>();

  constructor(options: BaseAgentOptions, readonly logger: Logger) {
    this.command = options.cmd && options.cmd.length > 0 ? options.cmd : "iflow";
    this.workDir = normalizePath(options.workDir ?? process.cwd());
    this.modeValue = normalizeIFlowMode(options.mode);
    this.modelValue = options.model ?? "";
    this.extraArgs = Array.isArray(options.args) ? [...options.args] : [];
    this.extraEnv = options.env ? { ...options.env } : {};
  }

  get sessionDir(): string {
    return join(homedir(), ".iflow", "projects", iflowProjectKey(normalizePath(this.workDir)));
  }

  supportedModes(): string[] {
    return ["default", "auto-edit", "plan", "yolo"];
  }

  setMode(mode: string): void {
    this.modeValue = normalizeIFlowMode(mode);
  }

  getMode(): string {
    return this.modeValue;
  }

  setModel(model: string): void {
    this.modelValue = model;
  }

  getModel(): string {
    return this.modelValue;
  }

  buildIFlowArgs(prompt: string, continueConversation: boolean, sessionId = ""): string[] {
    const args: string[] = [...this.extraArgs];

    if (this.modelValue && this.modelValue.length > 0) {
      args.push("-m", this.modelValue);
    }

    args.push(...toModeArgs(this.modeValue));

    if (sessionId) {
      args.push("-r", sessionId);
    } else if (continueConversation) {
      args.push("-c");
    }

    args.push("-i", prompt);
    return args;
  }

  pendingToolTimeoutMs(): number {
    if (this.modeValue === "default") {
      return PENDING_TOOL_TIMEOUT_DEFAULT_MODE_MS;
    }
    return PENDING_TOOL_TIMEOUT_MS;
  }

  spawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.extraEnv,
    };

    const nodeDir = dirname(process.execPath);
    env.PATH = `${nodeDir}:${process.env.PATH ?? ""}`;
    return env;
  }

  async startSession(sessionId?: string): Promise<AgentSession> {
    this.logger.info("iflow session started", {
      workDir: this.workDir,
      mode: this.modeValue,
      model: this.modelValue || "default",
      command: this.command,
    });

    const session = new IFlowSession(this, sessionId);
    this.sessions.add(session);
    return session;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) {
      await session.close();
    }
    this.sessions.clear();
  }
}

export function createIFlowAdapter(options: BaseAgentOptions, logger: Logger): IFlowAdapter {
  return new IFlowAdapter(options, logger.child("iflow"));
}
