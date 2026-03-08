const MARKDOWN_INDICATORS = ["```", "**", "~~", "`", "\n- ", "\n* ", "\n1. ", "\n# ", "---"];

interface FeishuReplyPayload {
  msgType: "text" | "post" | "interactive";
  body: string;
}

function countOccurrences(input: string, token: string): number {
  if (!token) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const next = input.indexOf(token, index);
    if (next < 0) {
      return count;
    }
    count += 1;
    index = next + token.length;
  }
}

function containsMarkdown(input: string): boolean {
  return MARKDOWN_INDICATORS.some((token) => input.includes(token));
}

export function hasComplexMarkdown(input: string): boolean {
  if (input.includes("```")) {
    return true;
  }

  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
      return true;
    }
  }

  return false;
}

export function preprocessFeishuMarkdown(markdown: string): string {
  let next = "";
  for (let index = 0; index < markdown.length; index += 1) {
    const isCodeFence =
      index > 0 &&
      markdown[index] === "`" &&
      markdown[index + 1] === "`" &&
      markdown[index + 2] === "`" &&
      markdown[index - 1] !== "\n";
    if (isCodeFence) {
      next += "\n";
    }
    next += markdown[index];
  }
  return next;
}

function buildCardJSON(content: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content,
        },
      ],
    },
  });
}

function buildPostMdJSON(content: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: "md",
            text: content,
          },
        ],
      ],
    },
  });
}

function findSingleAsterisk(input: string): number {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "*") {
      continue;
    }
    if (input[index + 1] === "*") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function parseInlineMarkdown(line: string): Array<Record<string, unknown>> {
  type Marker = {
    pattern: string;
    style: string;
  };

  const markers: Marker[] = [
    { pattern: "**", style: "bold" },
    { pattern: "~~", style: "lineThrough" },
    { pattern: "`", style: "code" },
    { pattern: "*", style: "italic" },
  ];

  const elements: Array<Record<string, unknown>> = [];
  let remaining = line;

  while (remaining.length > 0) {
    const linkStart = remaining.indexOf("[");
    if (linkStart >= 0) {
      let parenClose = -1;
      const bracketClose = remaining.indexOf("](", linkStart);
      if (bracketClose >= 0) {
        parenClose = remaining.indexOf(")", bracketClose + 2);
      }
      if (bracketClose >= 0 && parenClose >= 0) {
        const hasEarlierMarker = markers.some((marker) => {
          const markerIndex = remaining.indexOf(marker.pattern);
          return markerIndex >= 0 && markerIndex < linkStart;
        });
        if (!hasEarlierMarker) {
          if (linkStart > 0) {
            elements.push({ tag: "text", text: remaining.slice(0, linkStart) });
          }
          elements.push({
            tag: "a",
            text: remaining.slice(linkStart + 1, bracketClose),
            href: remaining.slice(bracketClose + 2, parenClose),
          });
          remaining = remaining.slice(parenClose + 1);
          continue;
        }
      }
    }

    let bestIndex = -1;
    let bestMarker: Marker | undefined;
    for (const marker of markers) {
      let markerIndex = remaining.indexOf(marker.pattern);
      if (markerIndex < 0) {
        continue;
      }
      if (marker.pattern === "*" && markerIndex + 1 < remaining.length && remaining[markerIndex + 1] === "*") {
        markerIndex = findSingleAsterisk(remaining);
        if (markerIndex < 0) {
          continue;
        }
      }
      if (bestIndex < 0 || markerIndex < bestIndex) {
        bestIndex = markerIndex;
        bestMarker = marker;
      }
    }

    if (bestIndex < 0 || !bestMarker) {
      elements.push({ tag: "text", text: remaining });
      break;
    }

    if (bestIndex > 0) {
      elements.push({ tag: "text", text: remaining.slice(0, bestIndex) });
    }

    remaining = remaining.slice(bestIndex + bestMarker.pattern.length);
    const closeIndex = bestMarker.pattern === "*" ? findSingleAsterisk(remaining) : remaining.indexOf(bestMarker.pattern);

    if (closeIndex < 0) {
      elements.push({ tag: "text", text: `${bestMarker.pattern}${remaining}` });
      break;
    }

    const inner = remaining.slice(0, closeIndex);
    remaining = remaining.slice(closeIndex + bestMarker.pattern.length);
    elements.push({
      tag: "text",
      text: inner,
      style: [bestMarker.style],
    });
  }

  return elements;
}

function buildPostJSON(content: string): string {
  const lines = content.split("\n");
  const postLines: Array<Array<Record<string, unknown>>> = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = trimmed.slice(3);
        codeLines = [];
      } else {
        inCodeBlock = false;
        postLines.push([
          {
            tag: "code_block",
            language: codeLang,
            text: codeLines.join("\n"),
          },
        ]);
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    let headerLine = line;
    for (let level = 6; level >= 1; level -= 1) {
      const prefix = `${"#".repeat(level)} `;
      if (line.startsWith(prefix)) {
        headerLine = `**${line.slice(prefix.length)}**`;
        break;
      }
    }

    const elements = parseInlineMarkdown(headerLine);
    if (elements.length > 0) {
      postLines.push(elements);
    } else {
      postLines.push([{ tag: "text", text: "" }]);
    }
  }

  if (inCodeBlock && codeLines.length > 0) {
    postLines.push([
      {
        tag: "code_block",
        language: codeLang,
        text: codeLines.join("\n"),
      },
    ]);
  }

  return JSON.stringify({
    zh_cn: {
      content: postLines,
    },
  });
}

export function buildReplyContent(content: string): FeishuReplyPayload {
  if (!containsMarkdown(content)) {
    return {
      msgType: "text",
      body: JSON.stringify({ text: content }),
    };
  }

  if (hasComplexMarkdown(content)) {
    return {
      msgType: "interactive",
      body: buildCardJSON(preprocessFeishuMarkdown(content)),
    };
  }

  if (countOccurrences(content, "\n\n") >= 4) {
    return {
      msgType: "post",
      body: buildPostJSON(content),
    };
  }

  return {
    msgType: "post",
    body: buildPostMdJSON(content),
  };
}
