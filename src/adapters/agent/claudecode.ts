import { Logger } from "../../logging.js";
import {
  parseAgentLine,
} from "./parsers.js";
import type { AgentAdapter, AgentEvent, AgentSession, ModelSwitchable } from "../../runtime/types.js";
import type { BaseAgentOptions } from "./options.js";
import { BaseCliSession, type Invocation } from "./shared/base-cli-session.js";
import { ClaudeTeamWatcher } from "./claudecode-team.js";

type RawRecord = Record<string, unknown>;

type ClaudePermissionMode = "bypassPermissions";

const NO_CONVERSATION_ERROR_PATTERN = /no conversation found with session id/i;

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

function normalizeToolList(value: unknown): string[] {
  if (!value) {
    return [];
  }
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

function summarizeToolInput(toolName: string, input: unknown): string {
  const payload = asRecord(input);
  if (!payload) {
    return "";
  }

  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write": {
      const filePath = pickString(payload, ["file_path", "filePath", "path"]);
      if (filePath) {
        return filePath;
      }
      break;
    }
    case "Bash": {
      const command = pickString(payload, ["command", "cmd"]);
      if (command) {
        return command;
      }
      break;
    }
    case "Grep":
    case "Glob": {
      const pattern = pickString(payload, ["pattern", "glob_pattern", "glob"]);
      if (pattern) {
        return pattern;
      }
      break;
    }
  }

  const payloadText = JSON.stringify(payload);
  return payloadText.length > 512 ? `${payloadText.slice(0, 512)}...` : payloadText;
}

function summarizeToolResultContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const lines: string[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }
    const text = pickString(item, ["text", "content"]);
    if (text) {
      lines.push(text);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n").trim() || undefined;
}

function requestToolName(requestId: string | undefined): string {
  const prefix = requestId?.split(":")[0]?.trim();
  return prefix && prefix.length > 0 ? prefix : "unknown";
}

function parseTeamToolResult(toolName: string, toolResult: RawRecord | undefined): AgentEvent | null {
  if (toolName === "TeamCreate" && toolResult) {
    return {
      type: "team_event",
      team: {
        kind: "team_created",
        teamName: pickString(toolResult, ["team_name", "teamName"]),
        teamFilePath: pickString(toolResult, ["team_file_path", "teamFilePath"]),
        leadAgentId: pickString(toolResult, ["lead_agent_id", "leadAgentId"]),
      },
    };
  }

  if (toolName === "Agent" && toolResult) {
    return {
      type: "team_event",
      team: {
        kind: "member_spawned",
        teamName: pickString(toolResult, ["team_name", "teamName"]),
        memberName: pickString(toolResult, ["name"]),
        memberId: pickString(toolResult, ["teammate_id", "teammateId", "agent_id", "agentId"]),
        agentType: pickString(toolResult, ["agent_type", "agentType"]),
        model: pickString(toolResult, ["model"]),
        color: pickString(toolResult, ["color"]),
        planModeRequired:
          typeof toolResult.plan_mode_required === "boolean"
            ? toolResult.plan_mode_required
            : typeof toolResult.planModeRequired === "boolean"
              ? toolResult.planModeRequired
              : undefined,
      },
    };
  }

  if (toolName === "TeamDelete") {
    return {
      type: "team_event",
      team: {
        kind: "team_deleted",
        teamName: pickString(toolResult ?? {}, ["team_name", "teamName"]),
      },
    };
  }

  return null;
}

interface ParseContentBlockOptions {
  parseAsToolResult?: boolean;
  fallbackRequestId?: string;
  fallbackStructuredResult?: RawRecord;
}

function parseContentBlocks(content: unknown, options: ParseContentBlockOptions = {}): AgentEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const events: AgentEvent[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }

    const contentType = pickString(item, ["type"]) ?? "";
    if (contentType === "text") {
      const text = pickString(item, ["text", "content"]);
      if (text) {
        events.push({ type: "text", content: text });
      }
    } else if (contentType === "thinking") {
      const text = pickString(item, ["thinking"]);
      if (text) {
        events.push({ type: "thinking", content: text });
      }
    } else if (contentType === "tool_use") {
      const toolName = pickString(item, ["name", "tool_name"]) ?? "unknown";
      events.push({
        type: "tool_use",
        requestId: pickString(item, ["id"]),
        toolName,
        toolInput: summarizeToolInput(toolName, item.input),
        toolInputRaw: asRecord(item.input),
      });
    } else if (options.parseAsToolResult && contentType === "tool_result") {
      const requestId = pickString(item, ["tool_use_id", "toolUseId", "id"]) ?? options.fallbackRequestId;
      const toolName = requestToolName(requestId);
      const structuredResult = asRecord(item.tool_use_result) ?? options.fallbackStructuredResult;
      const result = summarizeToolResultContent(item.content) ?? pickString(item, ["content"]);
      const isError = Boolean(item.is_error);
      const teamEvent = !isError ? parseTeamToolResult(toolName, structuredResult) : null;
      if (teamEvent) {
        events.push({
          ...teamEvent,
          ...(requestId ? { requestId } : {}),
        });
      }
      const baseEvent: AgentEvent = {
        type: isError ? "error" : "tool_result",
        content: result,
      };
      if (requestId) {
        baseEvent.requestId = requestId;
        baseEvent.toolName = toolName;
      }
      events.push(baseEvent);
    }
  }

  return events;
}

function parseClaudeLine(line: string): AgentEvent[] | null {
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
  const sessionId = pickString(raw, ["session_id", "sessionId"]);
  const requestId = pickString(raw, ["request_id", "requestId", "id"]);
  const setSession = (event: AgentEvent): AgentEvent =>
    sessionId ? { ...event, sessionId } : event;
  const setRequest = (event: AgentEvent): AgentEvent =>
    requestId && !event.requestId ? { ...event, requestId } : event;

  if (eventType === "assistant" || eventType === "user") {
    const message = asRecord(raw.message);
    if (!message) {
      return [setSession({ type: "text", content: "" })];
    }

    const events = parseContentBlocks(message.content, {
      parseAsToolResult: eventType === "user",
      fallbackRequestId: pickString(raw, ["tool_use_id", "toolUseId"]),
      fallbackStructuredResult: asRecord(raw.tool_use_result) ?? asRecord(raw.toolUseResult),
    });
    return events.map((event) => setSession(setRequest(event)));
  }

  if (eventType === "result") {
    const content = pickString(raw, ["result", "content"]) ?? "";
    return [setSession(setRequest({ type: "result", content, done: true }))];
  }

  if (eventType === "system") {
    const subtype = pickString(raw, ["subtype"]) ?? "";
    if (subtype === "task_started" && pickString(raw, ["task_type", "taskType"]) === "in_process_teammate") {
      return [
        setSession({
          type: "team_event",
          requestId: pickString(raw, ["tool_use_id", "toolUseId"]),
          team: {
            kind: "task_started",
            memberName: pickString(raw, ["description"])?.split(":")[0]?.trim(),
            taskId: pickString(raw, ["task_id", "taskId"]),
            taskStatus: "in_progress",
            taskDescription: pickString(raw, ["description"]),
          },
        }),
      ];
    }

    const sid = sessionId;
    if (!sid) {
      return [];
    }
    return [setSession({ type: "text", content: "" })];
  }

  if (eventType === "control_request") {
    const request = asRecord(raw.request);
    if (!request) {
      return [];
    }
    const subtype = pickString(request, ["subtype"]) ?? "";
    if (subtype !== "can_use_tool") {
      return [];
    }

    const toolName = pickString(request, ["tool_name", "toolName", "name"]) ?? "unknown";
    return [
      setSession({
        type: "permission_request",
        requestId,
        toolName,
        toolInput: summarizeToolInput(toolName, request.input),
        toolInputRaw: asRecord(request.input),
      }),
    ];
  }

  return null;
}

function parseClaudeOutput(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  const specific = parseClaudeLine(trimmed);
  if (specific && specific.length > 0) {
    return specific;
  }

  return parseAgentLine("claudecode", trimmed).events;
}

function mergeEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  delete env.CLAUDECODE;
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      env[key] = value;
    }
  }
  if (!env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS || env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS.trim().length === 0) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  }
  return env;
}

class ClaudeCodeSession extends BaseCliSession implements AgentSession {
  private teamWatcher?: ClaudeTeamWatcher;

  constructor(
    logger: Logger,
    private readonly invocationBuilder: (prompt: string, sessionId: string) => Invocation,
    private readonly watcherHomeDir?: string,
    sessionId?: string,
  ) {
    super(logger, sessionId);
  }

  protected providerName(): string {
    return "claudecode";
  }

  protected buildInvocation(prompt: string, sessionId: string): Invocation {
    return this.invocationBuilder(prompt, sessionId);
  }

  protected parseOutputLine(_source: "stdout" | "stderr", line: string): AgentEvent[] {
    const events = parseClaudeOutput(line);
    this.teamWatcher?.observe(events);
    return events;
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
      this.teamWatcher = new ClaudeTeamWatcher(
        this.logger.child("team"),
        (event) => {
          this.emit("event", event);
        },
        {
          homeDir: this.watcherHomeDir,
        },
      );
      if (this.currentId.trim().length > 0) {
        this.teamWatcher.observe([{ type: "text", sessionId: this.currentId }]);
      }
      await this.teamWatcher.start();

      try {
        await this.runOnce(prompt, this.currentId);
      } catch (error) {
        const message = (error as Error).message;
        if (!NO_CONVERSATION_ERROR_PATTERN.test(message)) {
          this.emit("event", {
            type: "error",
            content: message,
            done: true,
          });
          throw error;
        }

        this.logger.warn("conversation missing, clearing session id and retrying without resume", {
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
          });
          throw retryError;
        }
      }
    } finally {
      if (this.teamWatcher) {
        await this.teamWatcher.stop();
      }
      this.teamWatcher = undefined;
      this.child = undefined;
      this.sending = false;
    }
  }
}

export class ClaudeCodeAdapter implements AgentAdapter, ModelSwitchable {
  readonly name = "claudecode";
  private readonly logger: Logger;
  private readonly options: BaseAgentOptions;
  private readonly sessions = new Set<ClaudeCodeSession>();
  private readonly modeValue: ClaudePermissionMode = "bypassPermissions";
  private modelValue: string;
  private allowedTools: string[] = [];
  private unknownOptions: Record<string, unknown>;

  constructor(options: BaseAgentOptions, logger: Logger) {
    this.logger = logger.child("claudecode");
    this.options = options;
    this.modelValue = options.model ?? "";
    this.unknownOptions = options as unknown as Record<string, unknown>;
    this.allowedTools = normalizeToolList(
      this.unknownOptions.allowedTools ??
        this.unknownOptions.allowed_tools ??
        this.unknownOptions["allowed-tools"] ??
        this.unknownOptions.routerAllowedTools ??
        [],
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
    return "claude";
  }

  private buildInvocation(prompt: string, sessionId: string): Invocation {
    const extraArgs = Array.isArray(this.options.args) ? [...this.options.args] : [];
    const args = [
      ...extraArgs,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
    ];

    args.push("--permission-mode", this.modeValue);
    if (sessionId.length > 0) {
      args.push("--resume", sessionId);
    }
    if (this.modelValue.length > 0) {
      args.push("--model", this.modelValue);
    }
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", this.allowedTools.join(","));
    }

    const promptArg = typeof this.options.promptArg === "string" ? this.options.promptArg : undefined;
    if (promptArg) {
      args.push(promptArg, prompt);
      return {
        cmd: this.defaultCommand(),
        args,
        stdinPrompt: false,
        cwd: this.options.workDir,
        env: mergeEnv(this.options.env),
      };
    }

    if (this.options.stdinPrompt) {
      return {
        cmd: this.defaultCommand(),
        args,
        stdinPrompt: true,
        cwd: this.options.workDir,
        env: mergeEnv(this.options.env),
      };
    }

    args.push("-p", prompt);
    return {
      cmd: this.defaultCommand(),
      args,
      stdinPrompt: false,
      cwd: this.options.workDir,
      env: mergeEnv(this.options.env),
    };
  }

  async startSession(sessionId?: string): Promise<AgentSession> {
    const session = new ClaudeCodeSession(
      this.logger,
      (prompt, sid) => this.buildInvocation(prompt, sid),
      typeof this.options.env?.HOME === "string" ? this.options.env.HOME : undefined,
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

export function createClaudeCodeAdapter(options: BaseAgentOptions, logger: Logger): AgentAdapter {
  return new ClaudeCodeAdapter(options, logger);
}
