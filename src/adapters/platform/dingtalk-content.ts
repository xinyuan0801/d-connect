const MARKDOWN_INDICATORS = ["```", "**", "~~", "\n- ", "\n* ", "\n1. ", "\n# ", "\n## ", "\n### ", "---", "|"];
const DEFAULT_MARKDOWN_TITLE = "reply";
const MARKDOWN_TITLE_MAX_LENGTH = 64;

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

function containsMarkdown(input: string): boolean {
  return MARKDOWN_INDICATORS.some((token) => input.includes(token));
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
