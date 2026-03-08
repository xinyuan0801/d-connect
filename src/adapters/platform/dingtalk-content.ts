const MARKDOWN_INDICATORS = ["```", "**", "~~", "\n- ", "\n* ", "\n1. ", "\n# ", "\n## ", "\n### ", "---"];
const DEFAULT_MARKDOWN_TITLE = "reply";
const MARKDOWN_TITLE_MAX_LENGTH = 64;
const TOOL_STATUS_PREFIX = "🛠️ ";

interface DingTalkReplyPayload {
  msgtype: "text" | "markdown";
  text?: {
    content: string;
  };
  markdown?: {
    title: string;
    text: string;
  };
}

function containsMarkdownTable(input: string): boolean {
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
      return true;
    }
  }
  return false;
}

function containsMarkdown(input: string): boolean {
  return MARKDOWN_INDICATORS.some((token) => input.includes(token)) || containsMarkdownTable(input);
}

function unwrapInlineCode(line: string): string | null {
  const match = line.match(/^(`+)([\s\S]*)\1$/);
  if (!match) {
    return null;
  }

  let content = match[2] ?? "";
  if (content.startsWith(" ") && content.endsWith(" ")) {
    content = content.slice(1, -1);
  }
  return content;
}

function wrapFencedCodeBlock(content: string): string {
  const matches = content.match(/`+/g);
  const longestFence = matches ? Math.max(...matches.map((match) => match.length)) : 0;
  const fence = "`".repeat(Math.max(longestFence + 1, 3));
  return `${fence}json\n${content}\n${fence}`;
}

function normalizeToolStatusMarkdown(content: string): DingTalkReplyPayload | null {
  const [header, codeLine, ...rest] = content.split("\n");
  if (!header?.startsWith(TOOL_STATUS_PREFIX) || !codeLine || rest.length > 0) {
    return null;
  }

  const code = unwrapInlineCode(codeLine.trim());
  if (code === null) {
    return null;
  }

  return {
    msgtype: "markdown",
    markdown: {
      title: header.trim(),
      text: `${header.trim()}\n${wrapFencedCodeBlock(code)}`,
    },
  };
}

function normalizeMarkdownTitle(content: string): string {
  if (content.trimStart().startsWith("```")) {
    return DEFAULT_MARKDOWN_TITLE;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("```")) {
      continue;
    }

    const normalized = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/[`*_~]+/g, "")
      .trim();

    if (!normalized) {
      continue;
    }

    if (normalized.length <= MARKDOWN_TITLE_MAX_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, MARKDOWN_TITLE_MAX_LENGTH - 3)}...`;
  }

  return DEFAULT_MARKDOWN_TITLE;
}

export function buildDingTalkReplyPayload(content: string): DingTalkReplyPayload {
  const toolStatusPayload = normalizeToolStatusMarkdown(content);
  if (toolStatusPayload) {
    return toolStatusPayload;
  }

  if (!containsMarkdown(content)) {
    return {
      msgtype: "text",
      text: {
        content,
      },
    };
  }

  return {
    msgtype: "markdown",
    markdown: {
      title: normalizeMarkdownTitle(content),
      text: content,
    },
  };
}
