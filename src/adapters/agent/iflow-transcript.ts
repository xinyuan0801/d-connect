export interface IFlowToolUse {
  id?: string;
  name: string;
  input?: unknown;
}

export interface IFlowToolResult {
  id: string;
  output: string;
}

export interface IFlowExecutionInfo {
  sessionId?: string;
  conversationId?: string;
}

export type IFlowAssistantPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; tool: IFlowToolUse };

interface IFlowContentItem {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

const EXECUTION_INFO_BLOCK_PATTERN = /<Execution Info>[\s\S]*?<\/Execution Info>/gi;
const EXECUTION_INFO_TAIL_PATTERN = /<Execution Info>[\s\S]*$/i;
const EXECUTION_INFO_CAPTURE_PATTERN = /<Execution Info>\s*([\s\S]*?)\s*<\/Execution Info>/gi;
const AONE_AUTH_LINE_PATTERN = /^using cached .* authentication\.?$/i;

function isBootstrapParagraph(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return true;
  }
  if (AONE_AUTH_LINE_PATTERN.test(text)) {
    return true;
  }
  if (/welcome to iflow cli/i.test(text)) {
    return true;
  }
  if (/^i see you're working in\b/i.test(text)) {
    return true;
  }
  if (/^the workspace appears to be empty currently\.?$/i.test(text)) {
    return true;
  }
  if (/^how can i assist you today\??$/i.test(text)) {
    return true;
  }
  return false;
}

export function sanitizeIFlowAssistantText(raw: string): string {
  if (!raw) {
    return "";
  }

  let text = raw.replace(/\r/g, "");
  text = text.replace(EXECUTION_INFO_BLOCK_PATTERN, "\n");
  text = text.replace(EXECUTION_INFO_TAIL_PATTERN, "\n");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !AONE_AUTH_LINE_PATTERN.test(line))
    .join("\n");

  const shouldFilterBootstrap =
    /welcome to iflow cli/i.test(text) || /^i see you're working in\b/im.test(text) || /^how can i assist you today\??$/im.test(text);
  if (!shouldFilterBootstrap) {
    return text.trim();
  }

  return text
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !isBootstrapParagraph(segment))
    .join("\n\n")
    .trim();
}

function parseExecutionInfoPayload(raw: string): IFlowExecutionInfo | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const objectText = text.slice(objectStart, objectEnd + 1);
    try {
      const parsed = JSON.parse(objectText) as unknown;
      const payload = asRecord(parsed);
      if (payload) {
        const sessionId = typeof payload["session-id"] === "string" ? payload["session-id"] : "";
        const conversationId = typeof payload["conversation-id"] === "string" ? payload["conversation-id"] : "";
        if (sessionId.length > 0 || conversationId.length > 0) {
          return {
            sessionId: sessionId || undefined,
            conversationId: conversationId || undefined,
          };
        }
      }
    } catch {
      // Fall through to regex extraction for partial / malformed payloads.
    }
  }

  const sessionIdMatch = text.match(/"session-id"\s*:\s*"([^"]+)"/i);
  const conversationIdMatch = text.match(/"conversation-id"\s*:\s*"([^"]+)"/i);
  if (!sessionIdMatch && !conversationIdMatch) {
    return undefined;
  }

  return {
    sessionId: sessionIdMatch?.[1],
    conversationId: conversationIdMatch?.[1],
  };
}

export function extractLatestExecutionInfo(raw: string): IFlowExecutionInfo | undefined {
  if (!raw) {
    return undefined;
  }

  let latest: IFlowExecutionInfo | undefined;
  for (const match of raw.matchAll(EXECUTION_INFO_CAPTURE_PATTERN)) {
    const parsed = parseExecutionInfoPayload(match[1] ?? "");
    if (parsed) {
      latest = parsed;
    }
  }
  if (latest) {
    return latest;
  }

  const tailMatch = raw.match(EXECUTION_INFO_TAIL_PATTERN);
  if (!tailMatch) {
    return undefined;
  }
  const payload = tailMatch[0].replace(/^<Execution Info>/i, "");
  return parseExecutionInfoPayload(payload);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nestedString(root: unknown, ...path: string[]): string {
  let current: unknown = root;
  for (const key of path) {
    const node = asRecord(current);
    if (!node) {
      return "";
    }
    current = node[key];
  }
  return typeof current === "string" ? current : "";
}

function truncateRunes(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

export function extractAssistantParts(content: unknown): IFlowAssistantPart[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }

  const parts: IFlowAssistantPart[] = [];

  for (const raw of asArray(content)) {
    const item = raw as IFlowContentItem;
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0) {
      parts.push({ type: "text", text: item.text.trim() });
      continue;
    }

    if (item?.type === "tool_use" && typeof item.name === "string" && item.name.length > 0) {
      parts.push({
        type: "tool_use",
        tool: {
          id: typeof item.id === "string" ? item.id : undefined,
          name: item.name,
          input: item.input,
        },
      });
    }
  }

  return parts;
}

export function extractAssistantEvents(content: unknown): { texts: string[]; tools: IFlowToolUse[] } {
  const texts: string[] = [];
  const tools: IFlowToolUse[] = [];

  for (const part of extractAssistantParts(content)) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }

    tools.push(part.tool);
  }

  return { texts, tools };
}

export function summarizeToolInput(input: unknown): string {
  const map = asRecord(input);
  if (!map) {
    return "";
  }

  for (const key of ["absolute_path", "path", "file_path", "command", "query", "pattern", "prompt", "url"]) {
    const value = map[key];
    if (typeof value === "string" && value.length > 0) {
      return truncateRunes(value, 300);
    }
  }

  try {
    return truncateRunes(JSON.stringify(map), 300);
  } catch {
    return "";
  }
}

export function summarizeToolResult(content: unknown): string {
  for (const path of [
    ["functionResponse", "response", "output"],
    ["responseParts", "functionResponse", "response", "output"],
    ["resultDisplay"],
    ["output"],
  ]) {
    const text = nestedString(content, ...path);
    if (text.trim().length > 0) {
      return truncateRunes(text.trim(), 2000);
    }
  }

  try {
    return truncateRunes(JSON.stringify(content), 2000);
  } catch {
    return "";
  }
}

export function extractToolResults(content: unknown): IFlowToolResult[] {
  const results: IFlowToolResult[] = [];
  for (const raw of asArray(content)) {
    const item = raw as IFlowContentItem;
    if (item?.type !== "tool_result") {
      continue;
    }
    if (typeof item.tool_use_id !== "string" || item.tool_use_id.length === 0) {
      continue;
    }
    results.push({
      id: item.tool_use_id,
      output: summarizeToolResult(item.content),
    });
  }
  return results;
}

export function iflowProjectKey(absDir: string): string {
  return absDir.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
}
