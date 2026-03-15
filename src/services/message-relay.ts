import type { AgentEvent, DeliveryTarget } from "../core/types.js";
import type { PlatformAdapter } from "../core/types.js";

interface PendingToolUse {
  toolName: string;
  requestId?: string;
  toolInput?: string;
}

interface EventRenderState {
  toolNames: Map<string, string>;
}

interface EventRenderOptions {
  includeText: boolean;
  includeErrors: boolean;
}

export interface EventMessageRenderer {
  push(event: AgentEvent): string[];
  flush(): string[];
}

const MAX_TOOL_INPUT_LENGTH = 180;
const TOOL_CALL_EMOJI = "🛠️";

function pickString(payload: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function normalizeInlineText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function wrapInlineCode(text: string): string {
  const matches = text.match(/`+/g);
  const longestFence = matches ? Math.max(...matches.map((match) => match.length)) : 0;
  const fence = "`".repeat(longestFence + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const content = needsPadding ? ` ${text} ` : text;
  return `${fence}${content}${fence}`;
}

function summarizeAgentToolInput(toolInputRaw?: Record<string, unknown>): string {
  if (!toolInputRaw) {
    return "";
  }

  const subagentType = pickString(toolInputRaw, ["subagent_type", "subagentType"]);
  const description = pickString(toolInputRaw, ["description"]);
  const prompt = pickString(toolInputRaw, ["prompt"]);

  const summaryParts = [subagentType, description].filter((part, index, parts) => part && parts.indexOf(part) === index);
  if (summaryParts.length > 0) {
    return summaryParts.join(" | ");
  }

  if (prompt) {
    return normalizeInlineText(prompt, MAX_TOOL_INPUT_LENGTH);
  }

  return "";
}

function normalizeToolDescription(event: AgentEvent): string {
  if (event.toolName === "Agent") {
    return "";
  }

  const toolInputRaw = event.toolInputRaw;
  if (!toolInputRaw) {
    return "";
  }

  return normalizeInlineText(pickString(toolInputRaw, ["description"]), MAX_TOOL_INPUT_LENGTH);
}

function isStructuredTeamToolUse(event: AgentEvent): boolean {
  if (event.type !== "tool_use") {
    return false;
  }

  if (event.toolName === "TeamCreate" || event.toolName === "TaskOutput" || event.toolName === "SendMessage") {
    return true;
  }

  if (event.toolName !== "Agent") {
    return false;
  }

  return typeof event.toolInputRaw?.team_name === "string" && event.toolInputRaw.team_name.trim().length > 0;
}

function normalizeToolInput(event: AgentEvent): string {
  if (event.toolName === "Agent") {
    const summarized = summarizeAgentToolInput(event.toolInputRaw);
    if (summarized) {
      return summarized;
    }
  }

  const toolInput = event.toolInput;
  if (!toolInput) {
    return "";
  }
  return normalizeInlineText(toolInput, MAX_TOOL_INPUT_LENGTH);
}

function formatTeamMemberRuntime(event: AgentEvent): string {
  return [event.team?.agentType?.trim(), event.team?.model?.trim()].filter(Boolean).join("/");
}

function formatTeamEvent(event: AgentEvent): string[] {
  if (!event.team) {
    return [];
  }

  switch (event.team.kind) {
    case "team_created": {
      const teamName = event.team.teamName?.trim() || "unknown";
      return [`🤝 Team ${teamName} 已创建`];
    }

    case "member_spawned": {
      const memberName = event.team.memberName?.trim() || event.team.memberId?.trim() || "unknown";
      const runtime = formatTeamMemberRuntime(event);
      return [`👤 ${memberName}${runtime ? ` · ${runtime}` : ""} 已加入`];
    }

    case "task_started": {
      const memberName = event.team.memberName?.trim() || event.team.memberId?.trim() || "unknown";
      const description = event.team.taskDescription?.trim() || event.team.taskSubject?.trim() || event.content?.trim() || event.team.taskId?.trim() || "-";
      return [`📌 ${memberName} 开始：${description}`];
    }

    case "task_completed": {
      const memberName = event.team.memberName?.trim() || event.team.memberId?.trim() || "unknown";
      const subject = event.team.taskSubject?.trim() || event.team.taskDescription?.trim() || event.content?.trim() || event.team.taskId?.trim() || "-";
      return [`✅ ${memberName} 完成：${subject}`];
    }

    case "team_deleted": {
      const teamName = event.team.teamName?.trim() || "unknown";
      return [`🧹 Team ${teamName} 已结束`];
    }

    case "member_idle":
      return [];

    default:
      return [];
  }
}

function formatTeamMessage(event: AgentEvent): string[] {
  if (!event.team) {
    return [];
  }

  const memberName = event.team.memberName?.trim() || event.team.memberId?.trim() || "unknown";
  const content = event.content?.trim();
  if (!content) {
    return [];
  }

  const lines = [`👤 ${memberName}`];
  if (event.team.summary?.trim()) {
    lines.push(`摘要：${event.team.summary.trim()}`);
  }
  lines.push(content);
  return [lines.join("\n")];
}

function createEventRenderState(): EventRenderState {
  return {
    toolNames: new Map<string, string>(),
  };
}

function renderToolRunning(use: PendingToolUse & { description?: string }): string {
  const header = `${TOOL_CALL_EMOJI} ${use.toolName}`;
  const lines = [header];
  if (use.description) {
    lines.push(use.description);
  }
  if (use.toolInput) {
    lines.push(wrapInlineCode(use.toolInput));
  }
  return lines.join("\n");
}

function flushPendingToolUseMessages(_state: EventRenderState): string[] {
  return [];
}

function renderToolUseEvent(event: AgentEvent, state: EventRenderState): string[] {
  if (isStructuredTeamToolUse(event)) {
    return [];
  }

  const toolName = event.toolName?.trim() || "unknown";
  const description = normalizeToolDescription(event);
  const toolInput = normalizeToolInput(event);
  const requestId = event.requestId?.trim();
  if (requestId) {
    state.toolNames.set(requestId, toolName);
  }

  const effectiveToolInput = description && toolInput === description ? "" : toolInput;

  return [
    renderToolRunning({
      toolName,
      requestId,
      description: description || undefined,
      toolInput: effectiveToolInput || undefined,
    }),
  ];
}

function renderToolResultEvent(_event: AgentEvent, _state: EventRenderState): string[] {
  return [];
}

function renderEventToMessages(event: AgentEvent, state: EventRenderState, options: EventRenderOptions): string[] {
  if (event.type === "tool_use") {
    return renderToolUseEvent(event, state);
  }

  if (event.type === "tool_result") {
    return renderToolResultEvent(event, state);
  }

  const messages = flushPendingToolUseMessages(state);

  if (event.type === "team_event") {
    messages.push(...formatTeamEvent(event));
    return messages;
  }

  if (event.type === "team_message") {
    messages.push(...formatTeamMessage(event));
    return messages;
  }

  if (event.type === "text" && options.includeText) {
    const content = event.content?.trim();
    if (content) {
      messages.push(content);
    }
    return messages;
  }

  if (event.type === "error" && options.includeErrors) {
    const content = event.content?.trim();
    if (content) {
      messages.push(`agent error: ${content}`);
    }
    return messages;
  }

  return messages;
}

function buildMessagesFromEvents(events: AgentEvent[], options: EventRenderOptions): string[] {
  const state = createEventRenderState();
  const messages: string[] = [];
  for (const event of events) {
    messages.push(...renderEventToMessages(event, state, options));
  }
  messages.push(...flushPendingToolUseMessages(state));
  return messages;
}

export function summarizeToolMessages(events: AgentEvent[]): string[] {
  return buildMessagesFromEvents(events, { includeText: false, includeErrors: false });
}

export function createEventMessageRenderer(options: EventRenderOptions): EventMessageRenderer {
  const state = createEventRenderState();
  return {
    push(event: AgentEvent): string[] {
      return renderEventToMessages(event, state, options);
    },
    flush(): string[] {
      return flushPendingToolUseMessages(state);
    },
  };
}

export function splitResponseMessages(response: string, events: AgentEvent[]): string[] {
  const messages = buildEventMessages(events);
  return messages.concat(buildSuffixMessage(response, events, messages));
}

function buildEventMessages(events: AgentEvent[]): string[] {
  return buildMessagesFromEvents(events, { includeText: true, includeErrors: true });
}

function buildSuffixMessage(response: string, events: AgentEvent[], messages: string[]): string[] {
  const body = response.trim() || "done";
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === "text") {
      const content = event.content?.trim();
      if (content) {
        textParts.push(content);
      }
    }
  }

  if (messages.length === 0) {
    return [body];
  }

  const lastMessage = messages.at(-1)?.trim();
  if (lastMessage && lastMessage === body) {
    return [];
  }

  const renderedBody = messages.join("\n\n");
  if (renderedBody === body || body === "done") {
    return [];
  }

  const textBody = textParts.join("\n\n");
  const lastText = textParts.at(-1);
  if (lastText && lastText === body) {
    return [];
  }
  if (!textBody) {
    return [body];
  }

  if (body === textBody) {
    return [];
  }

  if (body.startsWith(textBody)) {
    const suffix = body.slice(textBody.length).trim();
    if (suffix.length > 0) {
      return [suffix];
    }
    return [];
  }

  return [body];
}

export function formatResponseFromEvents(response: string, events: AgentEvent[]): string {
  return splitResponseMessages(response, events).join("\n\n");
}

export function previewLogText(value: string | undefined, max = 320): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export class MessageRelay {
  async reply(platform: PlatformAdapter, replyContext: unknown, response: string, events: AgentEvent[] = []): Promise<void> {
    for (const message of splitResponseMessages(response, events)) {
      if (message.trim().length === 0) {
        continue;
      }
      await platform.reply(replyContext, message);
    }
  }

  async send(platform: PlatformAdapter, target: DeliveryTarget, response: string, events: AgentEvent[] = []): Promise<void> {
    for (const message of splitResponseMessages(response, events)) {
      if (message.trim().length === 0) {
        continue;
      }
      await platform.send(target, message);
    }
  }
}
