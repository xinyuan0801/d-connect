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

const MISSING_SESSION_PATTERN = /\b(session|thread)\b.*\b(not found|missing|unknown)\b/i;

function asRecord(value: unknown): RawRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawRecord;
}

function pickString(payload: RawRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function hasArg(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function truncateText(value: string, max = 512): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeToolInput(input: RawRecord | undefined): string | undefined {
  if (!input || Object.keys(input).length === 0) {
    return undefined;
  }

  const command = pickString(input, ["command", "cmd", "query", "prompt", "path", "file"]);
  if (command) {
    return truncateText(command);
  }

  return truncateText(JSON.stringify(input));
}

function resolvePartDelta(
  partId: string,
  nextTextRaw: unknown,
  deltaRaw: unknown,
  textState: Map<string, string>,
): string | undefined {
  const previous = textState.get(partId) ?? "";
  const explicitDelta = typeof deltaRaw === "string" ? deltaRaw : "";
  const nextText = typeof nextTextRaw === "string" ? nextTextRaw : "";

  if (explicitDelta.length > 0) {
    textState.set(partId, nextText.length > 0 ? nextText : `${previous}${explicitDelta}`);
    return explicitDelta;
  }

  if (nextText.length === 0) {
    return undefined;
  }

  textState.set(partId, nextText);
  if (previous.length > 0 && nextText.startsWith(previous)) {
    const suffix = nextText.slice(previous.length);
    return suffix.length > 0 ? suffix : undefined;
  }

  return nextText === previous ? undefined : nextText;
}

function fingerprintToolState(part: RawRecord): string {
  const state = asRecord(part.state);
  if (!state) {
    return "tool:unknown";
  }

  const status = pickString(state, ["status"]) ?? "unknown";
  if (status === "pending" || status === "running") {
    return `tool_use:${pickString(part, ["tool"]) ?? "unknown"}:${JSON.stringify(asRecord(state.input) ?? {})}`;
  }

  if (status === "completed") {
    return `tool_result:${pickString(part, ["tool"]) ?? "unknown"}:${pickString(state, ["output"]) ?? ""}`;
  }

  if (status === "error") {
    return `tool_error:${pickString(part, ["tool"]) ?? "unknown"}:${pickString(state, ["error"]) ?? ""}`;
  }

  return `tool:${status}`;
}

function fingerprintKind(value: string | undefined): "" | "tool_use" | "tool_result" | "tool_error" | "tool" {
  if (!value) {
    return "";
  }
  if (value.startsWith("tool_use:")) {
    return "tool_use";
  }
  if (value.startsWith("tool_result:")) {
    return "tool_result";
  }
  if (value.startsWith("tool_error:")) {
    return "tool_error";
  }
  if (value.startsWith("tool:")) {
    return "tool";
  }
  return "";
}

function parseToolPart(part: RawRecord, toolState: Map<string, string>): AgentEvent[] {
  const partId = pickString(part, ["id"]);
  if (!partId) {
    return [];
  }

  const nextFingerprint = fingerprintToolState(part);
  const previousFingerprint = toolState.get(partId);
  if (previousFingerprint === nextFingerprint) {
    return [];
  }
  toolState.set(partId, nextFingerprint);

  const sessionId = pickString(part, ["sessionID", "sessionId"]);
  const requestId = pickString(part, ["callID", "callId", "id"]);
  const toolName = pickString(part, ["tool"]) ?? "unknown";
  const state = asRecord(part.state);
  if (!state) {
    return [];
  }

  const status = pickString(state, ["status"]) ?? "";
  const input = asRecord(state.input);
  const useEvent: AgentEvent = {
    type: "tool_use",
    sessionId,
    requestId,
    toolName,
    toolInput: summarizeToolInput(input) ?? pickString(state, ["raw", "title"]),
    toolInputRaw: input,
  };
  const previousKind = fingerprintKind(previousFingerprint);

  if (status === "pending" || status === "running") {
    return [useEvent];
  }

  if (status === "completed") {
    const events: AgentEvent[] = [];
    if (previousKind !== "tool_use" && previousKind !== "tool_result" && previousKind !== "tool_error") {
      events.push(useEvent);
    }
    events.push({
        type: "tool_result",
        sessionId,
        requestId,
        toolName,
        content: pickString(state, ["output", "title"]),
      });
    return events;
  }

  if (status === "error") {
    const events: AgentEvent[] = [];
    if (previousKind !== "tool_use" && previousKind !== "tool_result" && previousKind !== "tool_error") {
      events.push(useEvent);
    }
    events.push({
        type: "error",
        sessionId,
        requestId,
        content: pickString(state, ["error"]) ?? "tool failed",
        done: true,
      });
    return events;
  }

  return [];
}

function parseTextualPart(
  part: RawRecord,
  deltaRaw: unknown,
  textState: Map<string, string>,
  toolState: Map<string, string>,
  fallbackSessionId?: string,
): AgentEvent[] {
  const partType = pickString(part, ["type"]) ?? "";
  const sessionId = pickString(part, ["sessionID", "sessionId"]) ?? fallbackSessionId;
  const requestId = pickString(part, ["id"]);

  if (partType === "text") {
    if (part.ignored === true) {
      return [];
    }
    const delta = resolvePartDelta(
      requestId ?? "",
      pickString(part, ["text"]),
      deltaRaw,
      textState,
    );
    if (typeof delta !== "string") {
      return [];
    }
    return [
      {
        type: "text",
        sessionId,
        requestId,
        content: delta,
      },
    ];
  }

  if (partType === "reasoning") {
    const delta = resolvePartDelta(
      requestId ?? "",
      pickString(part, ["text"]),
      deltaRaw,
      textState,
    );
    if (typeof delta !== "string") {
      return [];
    }
    return [
      {
        type: "thinking",
        sessionId,
        requestId,
        content: delta,
      },
    ];
  }

  if (partType === "tool") {
    return parseToolPart(part, toolState);
  }

  if (partType === "subtask") {
    return [
      {
        type: "tool_use",
        sessionId,
        requestId,
        toolName: "subtask",
        toolInput: pickString(part, ["description", "prompt"]),
        toolInputRaw: {
          agent: pickString(part, ["agent"]),
          description: pickString(part, ["description"]),
          prompt: pickString(part, ["prompt"]),
        },
      },
    ];
  }

  return [];
}

function parseOpencodeJsonLine(
  line: string,
  textState: Map<string, string>,
  toolState: Map<string, string>,
): AgentEvent[] | null {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return null;
  }

  let raw: RawRecord;
  try {
    raw = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }

  const eventType = pickString(raw, ["type"]) ?? "";
  const topLevelSessionId = pickString(raw, ["sessionID", "sessionId"]);
  const topLevelPart = asRecord(raw.part);

  if (!topLevelPart) {
    if (eventType === "error") {
      return [
        {
          type: "error",
          sessionId: topLevelSessionId,
          content: pickString(raw, ["error", "message"]) ?? JSON.stringify(raw),
          done: true,
        },
      ];
    }
    return [];
  }

  if (eventType === "step_start" || eventType === "step_finish") {
    return [];
  }

  if (eventType === "error") {
    return [
      {
        type: "error",
        sessionId: topLevelSessionId ?? pickString(topLevelPart, ["sessionID", "sessionId"]),
        requestId: pickString(topLevelPart, ["id"]),
        content:
          pickString(raw, ["error", "message"]) ??
          pickString(topLevelPart, ["error", "text"]) ??
          JSON.stringify(raw),
        done: true,
      },
    ];
  }

  const partType = pickString(topLevelPart, ["type"]) ?? "";
  if (!partType) {
    return [];
  }

  return parseTextualPart(topLevelPart, raw.delta, textState, toolState, topLevelSessionId);
}

class OpenCodeSession extends BaseCliSession implements AgentSession {
  private readonly textState = new Map<string, string>();
  private readonly toolState = new Map<string, string>();

  constructor(
    logger: Logger,
    private readonly invocationBuilder: (prompt: string, sessionId: string) => Invocation,
    sessionId?: string,
  ) {
    super(logger, sessionId);
  }

  protected providerName(): string {
    return "opencode";
  }

  protected buildInvocation(prompt: string, sessionId: string): Invocation {
    return this.invocationBuilder(prompt, sessionId);
  }

  protected parseOutputLine(_source: "stdout" | "stderr", line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    const structured = parseOpencodeJsonLine(trimmed, this.textState, this.toolState);
    if (structured) {
      return structured;
    }

    return parseAgentLine("opencode", trimmed).events;
  }

  protected emitEvents(events: AgentEvent[], transcript: { value: string }, sawResult: { value: boolean }): void {
    for (const event of events) {
      if (event.sessionId) {
        this.currentId = event.sessionId;
      }
      if (
        (event.type === "text" || event.type === "result") &&
        typeof event.content === "string" &&
        event.content.length > 0
      ) {
        transcript.value += event.content;
      }
      if (event.type === "result") {
        sawResult.value = true;
      }
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
    this.interrupted = false;
    this.textState.clear();
    this.toolState.clear();

    try {
      try {
        await this.runOnce(prompt, this.currentId);
      } catch (error) {
        const message = (error as Error).message;
        if (!this.currentId || !MISSING_SESSION_PATTERN.test(message)) {
          this.emit("event", {
            type: "error",
            content: message,
            done: true,
          } satisfies AgentEvent);
          throw error;
        }

        this.logger.warn("opencode session missing, clearing session id and retrying without resume", {
          sessionId: this.currentId,
        });
        this.currentId = "";
        this.textState.clear();
        this.toolState.clear();

        try {
          await this.runOnce(prompt, this.currentId);
        } catch (retryError) {
          const retryMessage = (retryError as Error).message;
          this.emit("event", {
            type: "error",
            content: retryMessage,
            done: true,
          } satisfies AgentEvent);
          throw retryError;
        }
      }
    } finally {
      this.child = undefined;
      this.sending = false;
    }
  }
}

export class OpenCodeAdapter implements AgentAdapter, ModelSwitchable {
  readonly name = "opencode";

  private readonly logger: Logger;
  private readonly options: BaseAgentOptions;
  private readonly sessions = new Set<OpenCodeSession>();
  private modelValue: string;

  constructor(options: BaseAgentOptions, logger: Logger) {
    this.logger = logger.child("opencode");
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
    return "opencode";
  }

  private appendPromptArgs(args: string[], prompt: string): { stdinPrompt: boolean } {
    const promptArg = typeof this.options.promptArg === "string" ? this.options.promptArg.trim() : "";

    if (promptArg === "-") {
      args.push("-");
      return { stdinPrompt: true };
    }

    if (this.options.stdinPrompt) {
      return { stdinPrompt: true };
    }

    if (promptArg.length > 0) {
      args.push(promptArg, prompt);
      return { stdinPrompt: false };
    }

    args.push(prompt);
    return { stdinPrompt: false };
  }

  private buildInvocation(prompt: string, sessionId: string): Invocation {
    const extraArgs = Array.isArray(this.options.args) ? [...this.options.args] : [];
    const args = [...extraArgs, "run"];

    if (!hasArg(args, "-f") && !hasArg(args, "--format")) {
      args.push("--format", "json");
    }

    if (sessionId.length > 0 && !hasArg(args, "-s") && !hasArg(args, "--session")) {
      args.push("--session", sessionId);
    }

    if (this.modelValue.length > 0 && !hasArg(args, "-m") && !hasArg(args, "--model")) {
      args.push("--model", this.modelValue);
    }

    const promptMode = this.appendPromptArgs(args, prompt);

    return {
      cmd: this.defaultCommand(),
      args,
      stdinPrompt: promptMode.stdinPrompt,
      cwd: this.options.workDir,
      env: this.options.env,
    };
  }

  async startSession(sessionId?: string): Promise<AgentSession> {
    const session = new OpenCodeSession(
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

export function createOpenCodeAdapter(options: BaseAgentOptions, logger: Logger): AgentAdapter {
  return new OpenCodeAdapter(options, logger);
}
