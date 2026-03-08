const MESSAGE_OLD_GRACE_MS = 2_000;

export interface FeishuReplyContext {
  messageId: string;
  chatId: string;
}

interface FeishuSenderId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

export interface FeishuMention {
  key?: string;
  id?: FeishuSenderId;
  name?: string;
}

interface FeishuSender {
  sender_id?: FeishuSenderId;
  sender_type?: string;
}

export interface FeishuMessagePayload {
  message_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
}

export interface FeishuReceiveEvent {
  sender?: FeishuSender;
  message?: FeishuMessagePayload;
  event?: {
    sender?: FeishuSender;
    message?: FeishuMessagePayload;
  };
}

interface FeishuPostElement {
  tag?: string;
  text?: string;
}

interface FeishuPostLang {
  title?: string;
  content?: FeishuPostElement[][];
}

function stripXmlAtMentions(text: string): string {
  return text.replace(/<at\b[^>]*>.*?<\/at>/gi, "");
}

export function stripFeishuMentions(text: string, mentions?: FeishuMention[]): string {
  let cleaned = text;
  for (const mention of mentions ?? []) {
    if (mention.key) {
      cleaned = cleaned.replaceAll(mention.key, "");
    }
  }
  return stripXmlAtMentions(cleaned).trim();
}

export function asTextContent(raw?: string, mentions?: FeishuMention[]): string {
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === "string") {
      return stripFeishuMentions(parsed.text, mentions);
    }
  } catch {
    // fall through to raw content
  }

  return stripFeishuMentions(raw, mentions);
}

function asPostLang(value: unknown): FeishuPostLang | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const post = value as FeishuPostLang;
  return Array.isArray(post.content) ? post : null;
}

function extractPostText(post: FeishuPostLang): string {
  const parts: string[] = [];

  if (post.title) {
    parts.push(post.title);
  }

  for (const line of post.content ?? []) {
    for (const element of line) {
      if ((element.tag === "text" || element.tag === "a" || element.tag === "md") && element.text) {
        parts.push(element.text);
      }
    }
  }

  return parts.join("\n");
}

export function parsePostTextContent(raw?: string, mentions?: FeishuMention[]): string {
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const flat = asPostLang(parsed);
    if (flat) {
      return stripFeishuMentions(extractPostText(flat), mentions);
    }

    if (parsed && typeof parsed === "object") {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        const lang = asPostLang(value);
        if (lang) {
          return stripFeishuMentions(extractPostText(lang), mentions);
        }
      }
    }
  } catch {
    return stripFeishuMentions(raw, mentions);
  }

  return stripFeishuMentions(raw, mentions);
}

export function getSenderId(event: FeishuReceiveEvent): string {
  const sender = event.sender?.sender_id ?? event.event?.sender?.sender_id;
  return sender?.open_id || sender?.user_id || sender?.union_id || "";
}

export function isFeishuOk(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const payload = response as { code?: number };
  return typeof payload.code === "undefined" || payload.code === 0;
}

export function isOldMessage(createTime?: string, startedAt = Date.now()): boolean {
  if (!createTime) {
    return false;
  }
  const createdAt = Number.parseInt(createTime, 10);
  if (!Number.isFinite(createdAt)) {
    return false;
  }
  return createdAt < startedAt - MESSAGE_OLD_GRACE_MS;
}

export function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenId: string): boolean {
  return (mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}
