import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Logger } from "../../logging.js";
import { parseAgentLine } from "./parsers.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelSwitchable,
  ModeSwitchable,
  PermissionResult,
} from "../../runtime/types.js";
import type { BaseAgentOptions } from "./base-cli.js";

type RawRecord = Record<string, unknown>;

interface Invocation {
  cmd: string;
  args: string[];
  stdinPrompt: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

interface ParsedQoderEvent {
  dedupeKey?: string;
  event: AgentEvent;
}

interface QoderParseOutcome {
  events: ParsedQoderEvent[];
  messageId?: string;
  parsed: boolean;
}

function extractLines(state: { value: string }, chunk: string): string[] {
  state.value += chunk;
  const parts = state.value.split(/\r?\n/);
  state.value = parts.pop() ?? "";
  return parts.filter((line) => line.trim().length > 0);
}

function flushBufferedLine(state: { value: string }): string[] {
  const line = state.value.trim();
  state.value = "";
  return line.length > 0 ? [line] : [];
}

function asRecord(value: unknown): RawRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawRecord;
}

function pickString(payload: RawRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function hasArg(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function parseRecordString(value: unknown): RawRecord | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return undefined;
  }
}

function parseToolInputRaw(value: unknown): RawRecord | undefined {
  return asRecord(value) ?? parseRecordString(value);
}

function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) {
    return input;
  }

  const payload = asRecord(input);
  if (!payload) {
    return undefined;
  }

  const text = JSON.stringify(payload);
  return text.length > 512 ? `${text.slice(0, 512)}...` : text;
}

function previewText(value: string | undefined, max = 320): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeEventForLog(event: AgentEvent): Record<string, unknown> {
  return {
    type: event.type,
    sessionId: event.sessionId,
    requestId: event.requestId,
    toolName: event.toolName,
    toolInput: previewText(event.toolInput),
    content: previewText(event.content),
    done: event.done === true,
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }

    const type = pickString(item, ["type"]) ?? "";
    if (type !== "text") {
      continue;
    }

    const text = pickString(item, ["text", "content"]);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n").trim();
}

function parseContentBlocks(content: unknown, includeToolResults = false): ParsedQoderEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const events: ParsedQoderEvent[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const entry = content[index];
    const item = asRecord(entry);
    if (!item) {
      continue;
    }

    const type = pickString(item, ["type"]) ?? "";
    if (type === "text") {
      const text = pickString(item, ["text", "content"]);
      if (text) {
        events.push({
          dedupeKey: `text:${index}`,
          event: { type: "text", content: text },
        });
      }
      continue;
    }

    if (type === "reasoning" || type === "thinking") {
      const text = pickString(item, ["thinking", "text", "content"]);
      if (text) {
        events.push({
          dedupeKey: `thinking:${index}`,
          event: { type: "thinking", content: text },
        });
      }
      continue;
    }

    if (type === "tool_use" || type === "tool-call" || type === "tool_call" || type === "function") {
      const toolId = pickString(item, ["id", "tool_use_id", "toolUseId"]) ?? `${index}`;
      const toolName = pickString(item, ["name", "tool_name", "toolName"]) ?? "unknown";
      events.push({
        dedupeKey: `tool:${toolId}`,
        event: {
          type: "tool_use",
          toolName,
          toolInput: summarizeToolInput(item.input),
          toolInputRaw: parseToolInputRaw(item.input),
        },
      });
      continue;
    }

    if (includeToolResults && (type === "tool_result" || type === "tool-result")) {
      const toolId = pickString(item, ["tool_use_id", "toolUseId", "id"]) ?? `${index}`;
      const result = pickString(item, ["content", "text"]);
      events.push({
        dedupeKey: `tool_result:${toolId}`,
        event: {
          type: "tool_result",
          content: result,
        },
      });
    }
  }

  return events;
}

function parseQoderLine(line: string): QoderParseOutcome {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return { events: [], parsed: false };
  }

  let raw: RawRecord;
  try {
    raw = JSON.parse(line) as RawRecord;
  } catch {
    return { events: [], parsed: false };
  }

  const eventType = pickString(raw, ["type"]) ?? "";
  const sessionId = pickString(raw, ["session_id", "sessionId"]);
  const requestId = pickString(raw, ["request_id", "requestId", "id"]);
  const message = asRecord(raw.message);
  const messageId = message ? pickString(message, ["id"]) : undefined;
  const setSession = (event: AgentEvent): AgentEvent =>
    sessionId ? { ...event, sessionId } : event;
  const setRequest = (event: AgentEvent): AgentEvent =>
    requestId && !event.requestId ? { ...event, requestId } : event;

  if (eventType === "system") {
    if (!sessionId) {
      return { events: [], messageId, parsed: true };
    }
    return {
      events: [{ event: setSession({ type: "text", content: "" }) }],
      messageId,
      parsed: true,
    };
  }

  if (eventType === "assistant") {
    if (!message) {
      return { events: [], messageId, parsed: true };
    }
    const events = parseContentBlocks(message.content);
    return {
      events: events.map(({ dedupeKey, event }) => ({
        dedupeKey,
        event: setSession(setRequest(event)),
      })),
      messageId,
      parsed: true,
    };
  }

  if (eventType === "user") {
    if (!message) {
      return { events: [], messageId, parsed: true };
    }
    const events = parseContentBlocks(message.content, true);
    return {
      events: events.map(({ dedupeKey, event }) => ({
        dedupeKey,
        event: setSession(setRequest(event)),
      })),
      messageId,
      parsed: true,
    };
  }

  if (eventType === "result") {
    const content = contentText(message?.content);
    return {
      events: [
        {
          dedupeKey: "result",
          event: setSession(setRequest({ type: "result", content, done: true })),
        },
      ],
      messageId,
      parsed: true,
    };
  }

  if (eventType === "error") {
    const content =
      pickString(raw, ["error", "message", "content"]) ??
      (message ? pickString(message, ["error", "message", "content"]) : undefined) ??
      line;
    return {
      events: [
        {
          dedupeKey: "error",
          event: setSession(setRequest({ type: "error", content, done: true })),
        },
      ],
      messageId,
      parsed: true,
    };
  }

  return {
    events: parseAgentLine("qoder", line).events.map((event) => ({ event })),
    messageId,
    parsed: true,
  };
}

function parseQoderOutput(line: string): QoderParseOutcome {
  const trimmed = line.trim();
  if (!trimmed) {
    return { events: [], parsed: true };
  }

  const specific = parseQoderLine(trimmed);
  if (specific.parsed) {
    return specific;
  }

  return {
    events: parseAgentLine("qoder", trimmed).events.map((event) => ({ event })),
    parsed: false,
  };
}

class QoderSession extends EventEmitter implements AgentSession {
  private currentId: string;
  private child?: ChildProcessWithoutNullStreams;
  private alive = true;
  private sending = false;

  constructor(
    private readonly logger: Logger,
    private readonly buildInvocation: (prompt: string, sessionId: string) => Invocation,
    sessionId?: string,
  ) {
    super();
    this.currentId = typeof sessionId === "string" ? sessionId.trim() : "";
  }

  currentSessionId(): string {
    return this.currentId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // v1 保持兼容性：暂不支持交互式 approve/deny
  }

  private eventFingerprint(event: AgentEvent): string {
    return JSON.stringify({
      type: event.type,
      content: event.content ?? "",
      toolName: event.toolName ?? "",
      toolInput: event.toolInput ?? "",
      toolInputRaw: event.toolInputRaw ?? null,
      requestId: event.requestId ?? "",
      done: event.done === true,
    });
  }

  private dedupeEvents(
    parsedEvents: ParsedQoderEvent[],
    messageId: string | undefined,
    messageState: Map<string, string>,
    transientKeys: Set<string>,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];

    for (const parsedEvent of parsedEvents) {
      const { dedupeKey, event } = parsedEvent;

      if (messageId && dedupeKey) {
        const stateKey = `${messageId}:${dedupeKey}`;

        if (event.type === "text" || event.type === "thinking") {
          const nextContent = event.content ?? "";
          const prevContent = messageState.get(stateKey);

          if (prevContent === nextContent) {
            this.logger.debug("qoder duplicate message event skipped", {
              messageId,
              dedupeKey,
              ...summarizeEventForLog(event),
            });
            continue;
          }

          if (typeof prevContent === "string" && nextContent.startsWith(prevContent) && nextContent.length > prevContent.length) {
            const delta = nextContent.slice(prevContent.length);
            messageState.set(stateKey, nextContent);
            if (delta.length === 0) {
              this.logger.debug("qoder duplicate message event skipped", {
                messageId,
                dedupeKey,
                ...summarizeEventForLog(event),
              });
              continue;
            }
            events.push({ ...event, content: delta });
            continue;
          }

          messageState.set(stateKey, nextContent);
          events.push(event);
          continue;
        }

        const nextFingerprint = this.eventFingerprint(event);
        const prevFingerprint = messageState.get(stateKey);
        if (prevFingerprint === nextFingerprint) {
          this.logger.debug("qoder duplicate message event skipped", {
            messageId,
            dedupeKey,
            ...summarizeEventForLog(event),
          });
          continue;
        }

        messageState.set(stateKey, nextFingerprint);
        events.push(event);
        continue;
      }

      const transientKey = this.eventFingerprint(event);
      if (transientKeys.has(transientKey)) {
        this.logger.debug("qoder duplicate event skipped", summarizeEventForLog(event));
        continue;
      }

      transientKeys.add(transientKey);
      events.push(event);
    }

    return events;
  }

  private emitEvents(events: AgentEvent[], transcript: { value: string }, sawResult: { value: boolean }): void {
    for (const event of events) {
      if (event.sessionId) {
        this.currentId = event.sessionId;
      }
      if (event.content && event.content.trim().length > 0) {
        transcript.value += `${event.content}\n`;
      }
      if (event.type === "result") {
        sawResult.value = true;
      }
      this.logger.debug("qoder event", summarizeEventForLog(event));
      this.emit("event", event);
    }
  }

  async send(prompt: string): Promise<void> {
    if (!this.alive) {
      throw new Error("agent session is closed");
    }
    if (this.sending) {
      throw new Error("agent session is busy");
    }

    this.sending = true;

    try {
      const invocation = this.buildInvocation(prompt, this.currentId);
      this.logger.debug("spawn qoder", {
        cmd: invocation.cmd,
        args: invocation.args,
      });

      const child = spawn(invocation.cmd, invocation.args, {
        cwd: invocation.cwd ?? process.cwd(),
        env: { ...process.env, ...(invocation.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      if (invocation.stdinPrompt) {
        child.stdin.write(`${prompt}\n`);
      }
      child.stdin.end();

      const transcript = { value: "" };
      const sawResult = { value: false };
      const messageState = new Map<string, string>();
      const transientKeys = new Set<string>();
      const stdoutLineBuffer = { value: "" };
      const stderrLineBuffer = { value: "" };
      let stdoutBuffer = "";
      let stderrBuffer = "";

      const onChunk = (source: "stdout" | "stderr", chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const lines = source === "stdout"
          ? extractLines(stdoutLineBuffer, text)
          : extractLines(stderrLineBuffer, text);
        for (const line of lines) {
          this.logger.debug("qoder output line", {
            source,
            sessionId: this.currentId,
            line: previewText(line, 1000),
          });
          const outcome = parseQoderOutput(line);
          const events = this.dedupeEvents(outcome.events, outcome.messageId, messageState, transientKeys);
          this.emitEvents(events, transcript, sawResult);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        onChunk("stdout", chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
        onChunk("stderr", chunk);
      });

      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          for (const line of flushBufferedLine(stdoutLineBuffer)) {
            this.logger.debug("qoder output line", {
              source: "stdout",
              sessionId: this.currentId,
              line: previewText(line, 1000),
            });
            const outcome = parseQoderOutput(line);
            const events = this.dedupeEvents(outcome.events, outcome.messageId, messageState, transientKeys);
            this.emitEvents(events, transcript, sawResult);
          }

          for (const line of flushBufferedLine(stderrLineBuffer)) {
            this.logger.debug("qoder output line", {
              source: "stderr",
              sessionId: this.currentId,
              line: previewText(line, 1000),
            });
            const outcome = parseQoderOutput(line);
            const events = this.dedupeEvents(outcome.events, outcome.messageId, messageState, transientKeys);
            this.emitEvents(events, transcript, sawResult);
          }

          const fullTranscript = `${stdoutBuffer}\n${stderrBuffer}`.trim();
          if (fullTranscript.length > 0) {
            this.logger.debug("qoder process output", {
              sessionId: this.currentId,
              outputPreview: previewText(fullTranscript, 2000),
            });
          }
          if (!sawResult.value && transcript.value.trim().length > 0) {
            this.emitEvents([{ type: "result", content: transcript.value.trim(), done: true }], transcript, sawResult);
          }

          if (code && code !== 0) {
            const details = fullTranscript.length > 0 ? fullTranscript.slice(0, 4000) : "no output";
            const message = `qoder process exited with code ${code}: ${details}`;
            this.logger.error("qoder process failed", {
              code,
              details,
            });
            this.emit("event", {
              type: "error",
              content: message,
              done: true,
            } satisfies AgentEvent);
            reject(new Error(message));
            return;
          }

          resolve();
        });
      });
    } finally {
      this.child = undefined;
      this.sending = false;
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.emit("close");
  }
}

export class QoderAdapter implements AgentAdapter, ModeSwitchable, ModelSwitchable {
  readonly name = "qoder";

  private readonly logger: Logger;
  private readonly options: BaseAgentOptions;
  private readonly sessions = new Set<QoderSession>();
  private modeValue: string;
  private modelValue: string;

  constructor(options: BaseAgentOptions, logger: Logger) {
    this.logger = logger.child("qoder");
    this.options = options;
    this.modeValue = options.mode ?? "default";
    this.modelValue = options.model ?? "";
  }

  supportedModes(): string[] {
    return ["default", "plan", this.modeValue].filter((value, index, all) => all.indexOf(value) === index);
  }

  setMode(mode: string): void {
    this.modeValue = mode;
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

  private defaultCommand(): string {
    if (typeof this.options.cmd === "string" && this.options.cmd.length > 0) {
      return this.options.cmd;
    }
    return "qodercli";
  }

  private buildInvocation(prompt: string, sessionId: string): Invocation {
    const args = Array.isArray(this.options.args) ? [...this.options.args] : [];

    if (!hasArg(args, "-f") && !hasArg(args, "--output-format")) {
      args.push("-f", "stream-json");
    }

    if (sessionId.length > 0 && !hasArg(args, "-r") && !hasArg(args, "--resume")) {
      args.push("-r", sessionId);
    }

    if (this.modelValue.length > 0 && !hasArg(args, "--model")) {
      args.push("--model", this.modelValue);
    }

    const promptArg = typeof this.options.promptArg === "string" ? this.options.promptArg : "-p";
    if (promptArg) {
      return {
        cmd: this.defaultCommand(),
        args: [...args, promptArg, prompt],
        stdinPrompt: false,
        cwd: this.options.workDir,
        env: this.options.env,
      };
    }

    if (this.options.stdinPrompt) {
      return {
        cmd: this.defaultCommand(),
        args,
        stdinPrompt: true,
        cwd: this.options.workDir,
        env: this.options.env,
      };
    }

    return {
      cmd: this.defaultCommand(),
      args: [...args, "-p", prompt],
      stdinPrompt: false,
      cwd: this.options.workDir,
      env: this.options.env,
    };
  }

  async startSession(sessionId?: string): Promise<AgentSession> {
    const session = new QoderSession(
      this.logger.child(`session:${sessionId ?? "new"}`),
      (prompt, sid) => this.buildInvocation(prompt, sid),
      sessionId,
    );
    this.sessions.add(session);
    session.once("close", () => {
      this.sessions.delete(session);
    });
    return session;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) {
      await session.close();
    }
    this.sessions.clear();
  }
}

export function createQoderAdapter(options: BaseAgentOptions, logger: Logger): AgentAdapter {
  return new QoderAdapter(options, logger);
}
