import { Logger } from "../../logging.js";
import { parseAgentLine } from "./parsers.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelSwitchable,
} from "../../runtime/types.js";
import type { BaseAgentOptions } from "./options.js";
import { BaseCliSession, type Invocation } from "./shared/base-cli-session.js";

type RawRecord = Record<string, unknown>;

interface ParsedQoderEvent {
  dedupeKey?: string;
  event: AgentEvent;
}

interface QoderParseOutcome {
  events: ParsedQoderEvent[];
  messageId?: string;
  parsed: boolean;
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

class QoderSession extends BaseCliSession implements AgentSession {
  private readonly messageState = new Map<string, string>();
  private readonly transientKeys = new Set<string>();

  constructor(
    logger: Logger,
    private readonly invocationBuilder: (prompt: string, sessionId: string) => Invocation,
    sessionId?: string,
  ) {
    super(logger, sessionId);
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

  protected providerName(): string {
    return "qoder";
  }

  protected buildInvocation(prompt: string, sessionId: string): Invocation {
    return this.invocationBuilder(prompt, sessionId);
  }

  protected parseOutputLine(source: "stdout" | "stderr", line: string): AgentEvent[] {
    this.logger.debug("qoder output line", {
      source,
      sessionId: this.currentId,
      line: previewText(line, 1000),
    });
    const outcome = parseQoderOutput(line);
    return this.dedupeEvents(outcome.events, outcome.messageId, this.messageState, this.transientKeys);
  }

  protected emitEvents(events: AgentEvent[], transcript: { value: string }, sawResult: { value: boolean }): void {
    for (const event of events) {
      this.logger.debug("qoder event", summarizeEventForLog(event));
    }
    super.emitEvents(events, transcript, sawResult);
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
      this.messageState.clear();
      this.transientKeys.clear();
      try {
        await this.runOnce(prompt, this.currentId);
      } catch (error) {
        const message = (error as Error).message;
        this.emit("event", {
          type: "error",
          content: message,
          done: true,
        } satisfies AgentEvent);
        throw error;
      }
    } finally {
      this.child = undefined;
      this.sending = false;
    }
  }
}

export class QoderAdapter implements AgentAdapter, ModelSwitchable {
  readonly name = "qoder";

  private readonly logger: Logger;
  private readonly options: BaseAgentOptions;
  private readonly sessions = new Set<QoderSession>();
  private modelValue: string;

  constructor(options: BaseAgentOptions, logger: Logger) {
    this.logger = logger.child("qoder");
    this.options = options;
    this.modelValue = options.model ?? "";
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
