import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Logger } from "../../logging.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelSwitchable,
  PermissionResult,
} from "../../runtime/types.js";
import type { BaseAgentOptions } from "./options.js";
import {
  extractLatestExecutionInfo,
  extractAssistantParts,
  extractToolResults,
  type IFlowToolResult,
  type IFlowToolUse,
  iflowProjectKey,
  sanitizeIFlowAssistantText,
  summarizeToolInput,
} from "./iflow-transcript.js";

const TRANSCRIPT_POLL_MS = 200;
const TURN_IDLE_MS = 900;
const TURN_IDLE_AFTER_TOOL_MS = 5000;
const TURN_POST_TOOL_RESPONSE_TIMEOUT_MS = 60000;
const PENDING_TOOL_TIMEOUT_MS = 180000;
const TURN_HARD_TIMEOUT_MS = 120000;
const TURN_NO_RESULT_TIMEOUT_MS = 60000;
const TRANSCRIPT_READ_MAX_BYTES_PER_POLL = 256 * 1024;
const PROCESS_OUTPUT_PROBE_MAX_LEN = 20000;
const IFLOW_OUTPUT_FILE_ROOT = "d-connect-iflow-output";
const IFLOW_TRANSCRIPT_ROOT_DIRS = [".iflow", ".iflow-aone"] as const;

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

interface IFlowExecutionSummary {
  sessionId?: string;
  conversationId?: string;
  assistantRounds?: number;
  executionTimeMs?: number;
  terminationReason?: string;
  tokenUsage?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

interface TurnState {
  transcriptPath?: string;
  transcriptBindingSource?: "session-id" | "mtime";
  outputFilePath?: string;
  offset: number;
  partial: string;
  outputProbe: string;
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
  lastToolResultToolName?: string;
  lastToolResultContent?: string;
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

function parseBackgroundCommandTaskId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/Command running in background with ID:\s*([^\s]+)/i);
  return match?.[1];
}

export function readTranscriptDelta(full: Buffer, offset: number): { chunk: string; nextOffset: number } {
  const nextChunk = full.subarray(offset);
  return {
    chunk: nextChunk.toString("utf8"),
    nextOffset: full.length,
  };
}

export interface TranscriptTailReadResult {
  found: boolean;
  truncated: boolean;
  chunk: string;
  nextOffset: number;
}

function pickOptionValue(args: string[], aliases: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    for (const alias of aliases) {
      if (current === alias) {
        const next = args[index + 1];
        return typeof next === "string" && next.length > 0 ? next : undefined;
      }
      if (current.startsWith(`${alias}=`)) {
        const [, value] = current.split("=", 2);
        return value && value.length > 0 ? value : undefined;
      }
    }
  }
  return undefined;
}

function hasOutputFileArg(args: string[]): boolean {
  return Boolean(pickOptionValue(args, ["--output-file", "--output_file", "-o"]));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseExecutionSummaryFromJson(raw: string): IFlowExecutionSummary | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  const parsed = safeJsonParse<Record<string, unknown>>(text);
  if (!parsed) {
    return undefined;
  }

  const sessionId = typeof parsed["session-id"] === "string" ? parsed["session-id"] : undefined;
  const conversationId = typeof parsed["conversation-id"] === "string" ? parsed["conversation-id"] : undefined;
  const assistantRounds = readNumber(parsed.assistantRounds);
  const executionTimeMs = readNumber(parsed.executionTimeMs);
  const terminationReason = typeof parsed.terminationReason === "string" ? parsed.terminationReason : undefined;
  const tokenUsageRaw =
    parsed.tokenUsage && typeof parsed.tokenUsage === "object" && !Array.isArray(parsed.tokenUsage)
      ? (parsed.tokenUsage as Record<string, unknown>)
      : undefined;
  const tokenUsage =
    tokenUsageRaw
      ? {
          input: readNumber(tokenUsageRaw.input),
          output: readNumber(tokenUsageRaw.output),
          total: readNumber(tokenUsageRaw.total),
        }
      : undefined;

  if (!sessionId && !conversationId && assistantRounds === undefined && executionTimeMs === undefined && !terminationReason && !tokenUsage) {
    return undefined;
  }

  return {
    sessionId,
    conversationId,
    assistantRounds,
    executionTimeMs,
    terminationReason,
    tokenUsage,
  };
}

export async function readTranscriptDeltaFromFile(
  path: string,
  offset: number,
  maxBytes = TRANSCRIPT_READ_MAX_BYTES_PER_POLL,
): Promise<TranscriptTailReadResult> {
  const safeOffset = offset > 0 ? offset : 0;

  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return {
      found: false,
      truncated: false,
      chunk: "",
      nextOffset: safeOffset,
    };
  }

  try {
    const info = await handle.stat();
    const size = Number(info.size);

    if (size < safeOffset) {
      return {
        found: true,
        truncated: true,
        chunk: "",
        nextOffset: 0,
      };
    }

    if (size === safeOffset) {
      return {
        found: true,
        truncated: false,
        chunk: "",
        nextOffset: safeOffset,
      };
    }

    const bytesToRead = Math.min(size - safeOffset, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, safeOffset);
    return {
      found: true,
      truncated: false,
      chunk: buffer.subarray(0, bytesRead).toString("utf8"),
      nextOffset: safeOffset + bytesRead,
    };
  } finally {
    await handle.close();
  }
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

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return Number(info.size);
  } catch {
    return 0;
  }
}

async function collectLatestTranscriptCandidates(sessionDir: string, startedAtMs: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }

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
      // For brand new sessions, only bind to transcripts created by this turn.
      // Otherwise a just-finished guard turn can be mistaken for the real chat turn.
      if (info.mtimeMs >= startedAtMs) {
        candidates.push({ path, mtimeMs: info.mtimeMs });
      }
    } catch {
      // skip
    }
  }

  return candidates;
}

export async function findLatestTranscript(sessionDir: string | readonly string[], startedAtMs: number): Promise<string | undefined> {
  const sessionDirs = Array.isArray(sessionDir) ? sessionDir : [sessionDir];
  const candidates = (
    await Promise.all(sessionDirs.map((dir) => collectLatestTranscriptCandidates(dir, startedAtMs)))
  ).flat();

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}

class IFlowSession extends EventEmitter implements AgentSession {
  private readonly id: string;
  private agentSessionId: string;
  private alive = true;
  private busy = false;
  private sentOnce = false;
  private child?: ReturnType<typeof spawn>;

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

  private bindTranscriptBySessionId(turn: TurnState, sessionId: string, source: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }

    this.setAgentSessionId(normalizedSessionId);
    const expectedPath = this.adapter.resolveTranscriptPath(normalizedSessionId, turn.transcriptPath);
    if (!expectedPath) {
      return;
    }

    if (turn.transcriptPath === expectedPath) {
      turn.transcriptBindingSource = "session-id";
      return;
    }

    if (turn.transcriptPath && turn.transcriptBindingSource === "mtime") {
      const consumedTranscriptEvents =
        turn.resultChunks.length > 0 || turn.seenToolUseIds.size > 0 || turn.completedToolUseIds.size > 0;
      if (consumedTranscriptEvents) {
        this.adapter.logger.warn("iflow resolved session id after mtime transcript already consumed output", {
          sessionId: normalizedSessionId,
          currentPath: turn.transcriptPath,
          expectedPath,
          source,
        });
        return;
      }
    }

    turn.transcriptPath = expectedPath;
    turn.transcriptBindingSource = "session-id";
    turn.offset = 0;
    turn.partial = "";
  }

  private probeExecutionInfoFromOutput(turn: TurnState, chunk: string): void {
    if (!chunk) {
      return;
    }

    turn.outputProbe = appendLimited(turn.outputProbe, chunk, PROCESS_OUTPUT_PROBE_MAX_LEN);
    const info = extractLatestExecutionInfo(turn.outputProbe);
    if (!info?.sessionId) {
      return;
    }

    this.bindTranscriptBySessionId(turn, info.sessionId, "execution-info");
  }

  private async loadExecutionInfoFromOutputFile(turn: TurnState): Promise<void> {
    if (!turn.outputFilePath) {
      return;
    }

    let content = "";
    try {
      content = await readFile(turn.outputFilePath, "utf8");
    } catch {
      return;
    }

    const summary = parseExecutionSummaryFromJson(content);
    if (!summary) {
      return;
    }

    if (summary.sessionId) {
      this.bindTranscriptBySessionId(turn, summary.sessionId, "output-file");
    }

    this.adapter.logger.info("iflow execution info", {
      outputFile: turn.outputFilePath,
      sessionId: summary.sessionId,
      conversationId: summary.conversationId,
      assistantRounds: summary.assistantRounds,
      executionTimeMs: summary.executionTimeMs,
      terminationReason: summary.terminationReason,
      tokenUsage: summary.tokenUsage,
    });
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
      this.bindTranscriptBySessionId(turn, this.currentSessionId(), "session-state");
    }

    const resolvedTranscriptPath = this.adapter.resolveTranscriptPath(this.currentSessionId(), turn.transcriptPath);
    if (resolvedTranscriptPath && resolvedTranscriptPath !== turn.transcriptPath) {
      turn.transcriptPath = resolvedTranscriptPath;
      turn.transcriptBindingSource = "session-id";
      turn.offset = 0;
      turn.partial = "";
    }

    if (!turn.transcriptPath) {
      turn.transcriptPath = await findLatestTranscript(this.adapter.sessionDirs, turn.startedAt);
      if (!turn.transcriptPath) {
        return;
      }
      turn.transcriptBindingSource = "mtime";
      // New transcript discovered during this turn: consume from the beginning.
      turn.offset = 0;
      turn.partial = "";
    }

    const delta = await readTranscriptDeltaFromFile(turn.transcriptPath, turn.offset);
    if (!delta.found) {
      return;
    }
    if (delta.truncated) {
      turn.offset = delta.nextOffset;
      turn.partial = "";
      return;
    }

    const { chunk: nextChunk, nextOffset } = delta;
    if (!nextChunk) {
      turn.offset = nextOffset;
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
        this.bindTranscriptBySessionId(turn, item.sessionId, "transcript-line");
      }

      if (item.type === "assistant") {
        for (const part of extractAssistantParts(item.message?.content)) {
          if (part.type === "text") {
            const cleaned = sanitizeIFlowAssistantText(part.text);
            if (!cleaned) {
              continue;
            }
            turn.resultChunks.push(cleaned);
            this.emitAgentEvent({ type: "text", content: cleaned });
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
              toolInputRaw: asRecord(tool.input),
            });
          }
        }
      }

      if (item.type === "user") {
        const toolResults = extractToolResults(item.message?.content);
        if (toolResults.length > 0) {
          const pendingToolNames = new Map(toolResults.map((result) => [result.id, turn.pendingTools.get(result.id) ?? ""]));
          for (const result of recordToolResults(turn, toolResults)) {
            turn.hadToolActivity = true;
            turn.awaitingPostToolResponse = true;
            turn.lastToolActivityAt = Date.now();
            turn.lastActivityAt = turn.lastToolActivityAt;
            turn.lastToolResultToolName = pendingToolNames.get(result.id) || undefined;
            turn.lastToolResultContent = result.output;
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
    const latestActivityAt = Math.max(turn.pendingStartedAt, turn.lastActivityAt);
    if (Date.now() - latestActivityAt < turn.pendingTimeoutMs) {
      return false;
    }

    const names = [...new Set(turn.pendingTools.values())].filter(Boolean);
    this.adapter.logger.warn("iflow tool execution timed out", {
      sessionId: this.currentSessionId(),
      pendingTools: names,
      timeoutMs: turn.pendingTimeoutMs,
      mode: this.adapter.getMode(),
    });
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
    const latestActivityAt = Math.max(turn.startedAt, turn.lastActivityAt);
    if (Date.now() - latestActivityAt < TURN_HARD_TIMEOUT_MS) {
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

  private buildPostToolFallback(turn: TurnState): string {
    const backgroundTaskId =
      turn.lastToolResultToolName === "run_shell_command"
        ? parseBackgroundCommandTaskId(turn.lastToolResultContent)
        : undefined;
    if (backgroundTaskId) {
      return `命令已在后台启动，任务 ID: ${backgroundTaskId}。`;
    }
    return "iflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。";
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

  private async runSingleTurn(
    prompt: string,
    continueConversation: boolean,
    turn: TurnState,
    tails: { stdout: string; stderr: string },
  ): Promise<SpawnResult> {
    turn.outputFilePath = await this.adapter.nextOutputFilePath();
    const iflowArgs = this.adapter.buildIFlowArgs(prompt, continueConversation, this.agentSessionId, turn.outputFilePath);
    this.adapter.logger.debug("spawn iflow turn", {
      command: this.adapter.command,
      args: iflowArgs,
    });

    const child = spawn(this.adapter.command, iflowArgs, {
      cwd: this.adapter.workDir,
      env: this.adapter.spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        reject(new Error(`failed to spawn iflow process: ${error.message}`));
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tails.stdout = appendLimited(tails.stdout, text);
      this.probeExecutionInfoFromOutput(turn, text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tails.stderr = appendLimited(tails.stderr, text);
      this.probeExecutionInfoFromOutput(turn, text);
    });

    try {
      const result = await Promise.race([this.waitForTurnResult(child, turn), spawnError]);
      await this.loadExecutionInfoFromOutputFile(turn);
      await this.loadNewTranscript(turn);
      return result;
    } finally {
      if (this.child === child) {
        this.child = undefined;
      }
    }
  }

  async send(prompt: string): Promise<void> {
    if (!this.alive) {
      throw new Error("agent session is closed");
    }
    if (this.busy) {
      throw new Error("agent session is busy");
    }

    this.busy = true;

    const tails = { stdout: "", stderr: "" };

    try {
      const turn: TurnState = {
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
        pendingTimeoutMs: this.adapter.pendingToolTimeoutMs(),
        startedAt: Date.now(),
        lastToolResultToolName: undefined,
        lastToolResultContent: undefined,
      };

      this.bindTranscriptBySessionId(turn, this.currentSessionId(), "send-start");
      if (turn.transcriptPath && existsSync(turn.transcriptPath)) {
        turn.offset = await fileSize(turn.transcriptPath);
      }

      const result = await this.runSingleTurn(prompt, this.sentOnce, turn, tails);

      if (turn.awaitingPostToolResponse) {
        turn.resultChunks.push(this.buildPostToolFallback(turn));
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
        const details = normalizeWhitespace(`${tails.stderr}\n${tails.stdout}`) || "no output";
        const err = `iflow turn failed (${result.code}): ${details}`;
        this.emitAgentEvent({ type: "error", content: err, done: true });
        throw new Error(err);
      }

      const rawFallback = normalizeWhitespace(`${tails.stdout}\n${tails.stderr}`);
      const fallback = sanitizeIFlowAssistantText(rawFallback);
      if (fallback.length > 0) {
        this.emitAgentEvent({
          type: "result",
          content: fallback,
          done: true,
        });
        return;
      }

      if (rawFallback.length > 0) {
        this.emitAgentEvent({
          type: "result",
          content: "iflow 返回了会话元信息，但没有产出可转发的最终回复。",
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
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.removeAllListeners();
  }
}

export class IFlowAdapter implements AgentAdapter, ModelSwitchable {
  readonly name = "iflow";

  readonly command: string;
  readonly workDir: string;

  private readonly modeValue = "yolo";
  private modelValue: string;
  private readonly extraArgs: string[];
  private readonly extraEnv: Record<string, string>;
  private readonly configuredOutputFilePath?: string;

  private readonly sessions = new Set<IFlowSession>();

  constructor(options: BaseAgentOptions, readonly logger: Logger) {
    this.command = options.cmd && options.cmd.length > 0 ? options.cmd : "iflow";
    this.workDir = normalizePath(options.workDir ?? process.cwd());
    this.modelValue = options.model ?? "";
    this.extraArgs = Array.isArray(options.args) ? [...options.args] : [];
    this.extraEnv = options.env ? { ...options.env } : {};
    const outputFileArg = pickOptionValue(this.extraArgs, ["--output-file", "--output_file", "-o"]);
    this.configuredOutputFilePath = outputFileArg ? resolve(this.workDir, outputFileArg) : undefined;
  }

  get sessionDir(): string {
    return this.sessionDirs[0];
  }

  get sessionDirs(): string[] {
    const projectKey = iflowProjectKey(normalizePath(this.workDir));
    return IFLOW_TRANSCRIPT_ROOT_DIRS.map((rootDir) => join(homedir(), rootDir, "projects", projectKey));
  }

  resolveTranscriptPath(sessionId: string, preferredPath?: string): string | undefined {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return undefined;
    }

    const candidates = this.sessionDirs.map((dir) => join(dir, `${normalizedSessionId}.jsonl`));
    const hasPreferredCandidate = Boolean(preferredPath) && candidates.includes(preferredPath);
    const orderedCandidates =
      hasPreferredCandidate
        ? [preferredPath, ...candidates.filter((candidate) => candidate !== preferredPath)]
        : candidates;

    for (const candidate of orderedCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return hasPreferredCandidate ? preferredPath : candidates[0];
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

  async nextOutputFilePath(): Promise<string | undefined> {
    if (this.configuredOutputFilePath) {
      return this.configuredOutputFilePath;
    }

    const dir = join(tmpdir(), IFLOW_OUTPUT_FILE_ROOT, iflowProjectKey(this.workDir));
    await mkdir(dir, { recursive: true });
    return join(dir, `${Date.now()}-${randomUUID()}.json`);
  }

  buildIFlowArgs(prompt: string, continueConversation: boolean, sessionId = "", outputFilePath?: string): string[] {
    const args: string[] = [...this.extraArgs];

    if (this.modelValue && this.modelValue.length > 0) {
      args.push("-m", this.modelValue);
    }

    args.push("--yolo");

    if (sessionId) {
      args.push("-r", sessionId);
    } else if (continueConversation) {
      args.push("-c");
    }

    if (outputFilePath && !hasOutputFileArg(args)) {
      args.push("--output-file", outputFilePath);
    }

    args.push("-p", prompt);
    return args;
  }

  pendingToolTimeoutMs(): number {
    return PENDING_TOOL_TIMEOUT_MS;
  }

  spawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.extraEnv,
    };

    const nodeDir = dirname(process.execPath);
    const pathKey = process.platform === "win32" && typeof env.Path === "string" ? "Path" : "PATH";
    const currentPath = (env[pathKey] ?? env.PATH ?? env.Path ?? "").toString();
    env[pathKey] = currentPath.length > 0 ? `${nodeDir}${delimiter}${currentPath}` : nodeDir;
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
