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
type CodexMode = "suggest" | "full-auto" | "yolo";
type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

const MISSING_SESSION_PATTERN = /\b(session|thread)\b.*\b(not found|missing|unknown)\b/i;
const SHELL_SNAPSHOT_WARNING_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\S+\s+WARN\s+codex_core::shell_snapshot:/i;

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

function normalizeMode(value: unknown): CodexMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "auto-edit":
    case "autoedit":
    case "auto_edit":
    case "edit":
    case "full-auto":
    case "fullauto":
    case "full_auto":
    case "auto":
      return "full-auto";
    case "yolo":
    case "bypass":
    case "dangerously-bypass":
      return "yolo";
    default:
      return "suggest";
  }
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | "" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "low":
      return "low";
    case "medium":
    case "med":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "x-high":
    case "very-high":
      return "xhigh";
    default:
      return "";
  }
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function hasArg(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function hasConfigOverride(args: string[], key: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current !== "-c" && current !== "--config") {
      continue;
    }
    const next = args[index + 1];
    if (typeof next === "string" && next.startsWith(`${key}=`)) {
      return true;
    }
  }
  return false;
}

function extractItemText(item: RawRecord): string {
  const text = pickString(item, ["text", "content", "message", "summary"]);
  return text ?? "";
}

function parseCodexJsonLine(line: string): AgentEvent[] | null {
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

  if (eventType === "thread.started") {
    const sessionId = pickString(raw, ["thread_id", "threadId", "id"]);
    if (!sessionId) {
      return [];
    }
    return [
      {
        type: "text",
        content: "",
        sessionId,
      },
    ];
  }

  if (eventType === "turn.completed" || eventType === "turn.started") {
    return [];
  }

  if (eventType === "error" || eventType === "turn.failed") {
    const message = pickString(raw, ["message", "error", "content"]) ?? JSON.stringify(raw);
    return [
      {
        type: "error",
        content: message,
        done: true,
      },
    ];
  }

  if (
    eventType !== "item.started" &&
    eventType !== "item.updated" &&
    eventType !== "item.completed"
  ) {
    return null;
  }

  const item = asRecord(raw.item);
  if (!item) {
    return [];
  }

  const requestId = pickString(item, ["id"]);
  const itemType = pickString(item, ["type"]) ?? "";

  if (itemType === "command_execution") {
    if (eventType !== "item.started") {
      return [];
    }

    const command = pickString(item, ["command"]);
    if (!command) {
      return [];
    }

    return [
      {
        type: "tool_use",
        requestId,
        toolName: "Bash",
        toolInput: command,
        toolInputRaw: {
          command,
        },
      },
    ];
  }

  if (itemType === "reasoning") {
    const text = extractItemText(item);
    if (!text) {
      return [];
    }
    return [
      {
        type: "thinking",
        requestId,
        content: text,
      },
    ];
  }

  if (itemType === "agent_message") {
    const text = extractItemText(item);
    if (!text) {
      return [];
    }
    return [
      {
        type: eventType === "item.completed" ? "result" : "text",
        requestId,
        content: text,
        done: eventType === "item.completed",
      },
    ];
  }

  return [];
}

function parseCodexOutput(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed || SHELL_SNAPSHOT_WARNING_PATTERN.test(trimmed)) {
    return [];
  }

  const structured = parseCodexJsonLine(trimmed);
  if (structured) {
    return structured;
  }

  return parseAgentLine("codex", trimmed).events;
}

class CodexSession extends BaseCliSession implements AgentSession {
  constructor(
    logger: Logger,
    private readonly invocationBuilder: (prompt: string, sessionId: string) => Invocation,
    sessionId?: string,
  ) {
    super(logger, sessionId);
  }

  protected providerName(): string {
    return "codex";
  }

  protected buildInvocation(prompt: string, sessionId: string): Invocation {
    return this.invocationBuilder(prompt, sessionId);
  }

  protected parseOutputLine(_source: "stdout" | "stderr", line: string): AgentEvent[] {
    return parseCodexOutput(line);
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

        this.logger.warn("codex session missing, clearing session id and retrying without resume", {
          sessionId: this.currentId,
        });
        this.currentId = "";

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

export class CodexAdapter implements AgentAdapter, ModelSwitchable {
  readonly name = "codex";

  private readonly logger: Logger;
  private readonly options: BaseAgentOptions;
  private readonly sessions = new Set<CodexSession>();
  private readonly unknownOptions: Record<string, unknown>;
  private readonly modeValue: CodexMode;
  private readonly extraAddDirs: string[];
  private readonly searchEnabled: boolean;
  private readonly skipGitRepoCheckEnabled: boolean;
  private modelValue: string;
  private reasoningEffortValue: CodexReasoningEffort | "";

  constructor(options: BaseAgentOptions, logger: Logger) {
    this.logger = logger.child("codex");
    this.options = options;
    this.unknownOptions = options as Record<string, unknown>;
    this.modeValue = normalizeMode(this.unknownOptions.mode);
    this.modelValue = options.model ?? "";
    this.reasoningEffortValue = normalizeReasoningEffort(
      this.unknownOptions.reasoningEffort ??
        this.unknownOptions.reasoning_effort ??
        this.unknownOptions.modelReasoningEffort,
    );
    this.extraAddDirs = normalizeStringList(
      this.unknownOptions.addDirs ??
        this.unknownOptions.add_dirs ??
        this.unknownOptions.addDir ??
        this.unknownOptions["add-dir"],
    );
    this.searchEnabled = normalizeBoolean(this.unknownOptions.search);
    this.skipGitRepoCheckEnabled = normalizeBoolean(
      this.unknownOptions.skipGitRepoCheck ?? this.unknownOptions.skip_git_repo_check,
    );
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
    return "codex";
  }

  private appendModeArgs(args: string[]): void {
    if (this.modeValue === "full-auto" && !hasArg(args, "--full-auto")) {
      args.push("--full-auto");
      return;
    }

    if (
      this.modeValue === "yolo" &&
      !hasArg(args, "--dangerously-bypass-approvals-and-sandbox")
    ) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }

  private appendOptionalArgs(args: string[]): void {
    if (!hasArg(args, "--json")) {
      args.push("--json");
    }

    if (this.modelValue.length > 0 && !hasArg(args, "-m") && !hasArg(args, "--model")) {
      args.push("--model", this.modelValue);
    }

    if (
      this.reasoningEffortValue.length > 0 &&
      !hasConfigOverride(args, "model_reasoning_effort")
    ) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(this.reasoningEffortValue)}`);
    }

    if (this.searchEnabled && !hasArg(args, "--search")) {
      args.push("--search");
    }

    if (this.skipGitRepoCheckEnabled && !hasArg(args, "--skip-git-repo-check")) {
      args.push("--skip-git-repo-check");
    }

    for (const addDir of this.extraAddDirs) {
      args.push("--add-dir", addDir);
    }

    this.appendModeArgs(args);
  }

  private appendPromptArgs(args: string[], prompt: string): { stdinPrompt: boolean } {
    const promptArg = typeof this.options.promptArg === "string" ? this.options.promptArg.trim() : "";

    if (promptArg === "-") {
      args.push("-");
      return { stdinPrompt: true };
    }

    if (this.options.stdinPrompt) {
      args.push("-");
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
    const args = [...extraArgs, "exec"];

    if (sessionId.length > 0) {
      args.push("resume");
    }

    this.appendOptionalArgs(args);

    if (sessionId.length > 0) {
      args.push(sessionId);
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
    const session = new CodexSession(
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

export function createCodexAdapter(options: BaseAgentOptions, logger: Logger): AgentAdapter {
  return new CodexAdapter(options, logger);
}
