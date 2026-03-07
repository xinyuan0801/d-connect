import type { AgentEvent } from "../../runtime/types.js";

export interface ParseOutcome {
  events: AgentEvent[];
  structured: boolean;
}

const textKeys = ["content", "text", "message", "delta", "output"] as const;

function pickString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickObject(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mapStructuredType(raw: string): AgentEvent["type"] {
  const value = raw.toLowerCase();
  if (value.includes("permission")) return "permission_request";
  if (value.includes("thinking") || value.includes("thought")) return "thinking";
  if (value.includes("tool") && value.includes("result")) return "tool_result";
  if (value.includes("tool")) return "tool_use";
  if (value.includes("error") || value.includes("fatal") || value.includes("exception")) return "error";
  if (value.includes("result") || value.includes("final") || value.includes("done") || value.includes("complete")) return "result";
  if (value.includes("text") || value.includes("message") || value.includes("assistant")) return "text";
  return "text";
}

function fromStructuredJson(payload: Record<string, unknown>): AgentEvent {
  const rawType = pickString(payload, ["type", "event", "kind", "level"]) ?? "text";
  const eventType = mapStructuredType(rawType);

  const toolName = pickString(payload, ["toolName", "tool", "name"]);
  const toolInputRaw = pickObject(payload, "toolInput") ?? pickObject(payload, "input");

  return {
    type: eventType,
    content: pickString(payload, textKeys),
    toolName,
    toolInput: typeof payload.toolInput === "string" ? payload.toolInput : undefined,
    toolInputRaw,
    sessionId: pickString(payload, ["sessionId", "session_id", "conversationId", "conversation_id"]),
    requestId: pickString(payload, ["requestId", "request_id", "id"]),
    done: Boolean(payload.done) || eventType === "result",
  };
}

function fromTextLine(line: string): AgentEvent {
  const text = line.trim();
  if (!text) {
    return { type: "text", content: "" };
  }

  if (/^(error|fatal|exception)\b/i.test(text)) {
    return { type: "error", content: text, done: true };
  }
  if (/\bpermission\b/i.test(text)) {
    return { type: "permission_request", content: text };
  }
  if (/^(thinking|thought)\b/i.test(text)) {
    return { type: "thinking", content: text };
  }
  if (/\btool\b.*\b(result|output|observation)\b/i.test(text)) {
    return { type: "tool_result", content: text };
  }
  if (/\b(tool|function)\b.*\b(use|call|invoke|running)\b/i.test(text) || /^tool\s*:/i.test(text)) {
    return { type: "tool_use", content: text };
  }
  if (/\b(final answer|done|completed)\b/i.test(text)) {
    return { type: "result", content: text, done: true };
  }
  return { type: "text", content: text };
}

export function parseAgentLine(_agentType: string, line: string): ParseOutcome {
  const trimmed = line.trim();
  if (!trimmed) {
    return { events: [], structured: false };
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const event = fromStructuredJson(parsed as Record<string, unknown>);
        return { events: [event], structured: true };
      }
    } catch {
      // keep text-mode parsing
    }
  }

  return {
    events: [fromTextLine(trimmed)],
    structured: false,
  };
}
