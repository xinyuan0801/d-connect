export interface IFlowToolUse {
  id?: string;
  name: string;
  input?: unknown;
}

export interface IFlowToolResult {
  id: string;
  output: string;
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

export function normalizeIFlowMode(raw: string | undefined): "default" | "auto-edit" | "plan" | "yolo" {
  const value = (raw ?? "").trim().toLowerCase();
  switch (value) {
    case "auto-edit":
    case "auto_edit":
    case "autoedit":
    case "edit":
      return "auto-edit";
    case "plan":
      return "plan";
    case "yolo":
    case "force":
    case "auto":
    case "bypasspermissions":
      return "yolo";
    default:
      return "default";
  }
}

export function iflowProjectKey(absDir: string): string {
  return absDir.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
}
