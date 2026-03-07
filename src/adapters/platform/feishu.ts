import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type EventHandles,
} from "@larksuiteoapi/node-sdk";
import type { MessageHandler, PlatformAdapter, PlatformMessage } from "../../runtime/types.js";
import { Logger } from "../../logging.js";

const MESSAGE_DEDUP_TTL_MS = 60_000;
const MESSAGE_OLD_GRACE_MS = 2_000;
const MARKDOWN_INDICATORS = ["```", "**", "~~", "`", "\n- ", "\n* ", "\n1. ", "\n# ", "---"];

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  allowFrom?: string;
  groupReplyAll?: boolean;
  reactionEmoji?: string;
}

export interface FeishuReplyContext {
  messageId: string;
  chatId: string;
}

interface FeishuSenderId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

interface FeishuMention {
  key?: string;
  id?: FeishuSenderId;
  name?: string;
}

interface FeishuSender {
  sender_id?: FeishuSenderId;
  sender_type?: string;
}

interface FeishuMessagePayload {
  message_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
}

interface FeishuReceiveEvent {
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

interface FeishuReplyPayload {
  msgType: "text" | "post" | "interactive";
  body: string;
}

function parseAllowFrom(value?: string): Set<string> | null {
  if (!value || value.trim() === "*") {
    return null;
  }
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return new Set(list);
}

function normalizeReactionEmoji(value?: string): string {
  if (value === "none") {
    return "";
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : "OnIt";
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

function getSenderId(event: FeishuReceiveEvent): string {
  const sender = event.sender?.sender_id ?? event.event?.sender?.sender_id;
  return sender?.open_id || sender?.user_id || sender?.union_id || "";
}

function isFeishuOk(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const payload = response as { code?: number };
  return typeof payload.code === "undefined" || payload.code === 0;
}

function isOldMessage(createTime?: string, startedAt = Date.now()): boolean {
  if (!createTime) {
    return false;
  }
  const createdAt = Number.parseInt(createTime, 10);
  if (!Number.isFinite(createdAt)) {
    return false;
  }
  return createdAt < startedAt - MESSAGE_OLD_GRACE_MS;
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
      let bracketClose = remaining.indexOf("](", linkStart);
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
    let closeIndex =
      bestMarker.pattern === "*" ? findSingleAsterisk(remaining) : remaining.indexOf(bestMarker.pattern);

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

function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenId: string): boolean {
  return (mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}

export class FeishuAdapter implements PlatformAdapter {
  readonly name = "feishu";

  private readonly allowList: Set<string> | null;
  private readonly client: Client;
  private readonly dedup = new Map<string, number>();
  private readonly reactionEmoji: string;
  private readonly startedAt = Date.now();

  private botOpenId = "";
  private handler?: MessageHandler;
  private wsClient?: WSClient;

  constructor(private readonly options: FeishuOptions, private readonly logger: Logger) {
    this.allowList = parseAllowFrom(options.allowFrom);
    this.reactionEmoji = normalizeReactionEmoji(options.reactionEmoji);
    this.client = new Client({
      appId: options.appId,
      appSecret: options.appSecret,
      appType: AppType.SelfBuild,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.error,
    });
  }

  private async fetchBotOpenId(): Promise<string> {
    const response = await this.client.request<{ code?: number; bot?: { open_id?: string } }>({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });

    if (response.code !== 0 || !response.bot?.open_id) {
      throw new Error(`unexpected bot info response: ${JSON.stringify(response)}`);
    }

    return response.bot.open_id;
  }

  private rememberMessageId(messageId: string): boolean {
    const now = Date.now();

    for (const [seenMessageId, seenAt] of this.dedup) {
      if (now - seenAt > MESSAGE_DEDUP_TTL_MS) {
        this.dedup.delete(seenMessageId);
      }
    }

    if (this.dedup.has(messageId)) {
      return false;
    }

    this.dedup.set(messageId, now);
    return true;
  }

  private isAllowed(userId: string): boolean {
    if (!this.allowList) {
      return true;
    }
    return this.allowList.has(userId);
  }

  private async addReaction(messageId: string): Promise<string> {
    if (!messageId || !this.reactionEmoji) {
      return "";
    }

    try {
      const response = await this.client.im.v1.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: this.reactionEmoji,
          },
        },
      });

      if (!isFeishuOk(response)) {
        this.logger.debug("feishu add reaction failed", { messageId, response });
        return "";
      }

      return response.data?.reaction_id ?? "";
    } catch (error) {
      this.logger.debug("feishu add reaction failed", {
        messageId,
        error: (error as Error).message,
      });
      return "";
    }
  }

  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!messageId || !reactionId) {
      return;
    }

    try {
      const response = await this.client.im.v1.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });

      if (!isFeishuOk(response)) {
        this.logger.debug("feishu remove reaction failed", { messageId, reactionId, response });
      }
    } catch (error) {
      this.logger.debug("feishu remove reaction failed", {
        messageId,
        reactionId,
        error: (error as Error).message,
      });
    }
  }

  private async onMessage(event: FeishuReceiveEvent): Promise<void> {
    const msg = event.message ?? event.event?.message;
    if (!msg) {
      this.logger.debug("feishu event without message");
      return;
    }

    const messageId = msg.message_id ?? "";
    const chatId = msg.chat_id ?? "";
    const userId = getSenderId(event);

    if (!messageId || !chatId || !userId) {
      return;
    }

    if (isOldMessage(msg.create_time, this.startedAt)) {
      this.logger.debug("ignore old feishu message after startup", {
        messageId,
        createTime: msg.create_time,
      });
      return;
    }

    if (!this.rememberMessageId(messageId)) {
      this.logger.debug("ignore duplicated feishu message", { messageId });
      return;
    }

    if (!this.isAllowed(userId)) {
      this.logger.warn("blocked feishu user", { userId });
      return;
    }

    if (msg.chat_type === "group" && !this.options.groupReplyAll && this.botOpenId) {
      if (!isBotMentioned(msg.mentions, this.botOpenId)) {
        this.logger.debug("ignore group message without bot mention", {
          chatId,
          messageId,
        });
        return;
      }
    }

    let text = "";
    switch (msg.message_type) {
      case "text":
        text = asTextContent(msg.content, msg.mentions);
        break;
      case "post":
        text = parsePostTextContent(msg.content, msg.mentions);
        break;
      default:
        this.logger.debug("ignore unsupported feishu message", {
          messageType: msg.message_type,
        });
        return;
    }

    if (!text) {
      this.logger.debug("feishu content is empty after parsing", {
        messageId,
        messageType: msg.message_type,
      });
      return;
    }

    if (!this.handler) {
      return;
    }

    const payload: PlatformMessage = {
      platform: this.name,
      sessionKey: `feishu:${chatId}:${userId}`,
      userId,
      userName: userId,
      content: text,
      replyCtx: {
        messageId,
        chatId,
      } satisfies FeishuReplyContext,
    };

    const reactionId = await this.addReaction(messageId);

    try {
      await this.handler(payload);
    } finally {
      if (reactionId) {
        void this.removeReaction(messageId, reactionId);
      }
    }
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;

    try {
      this.botOpenId = await this.fetchBotOpenId();
      this.logger.info("feishu bot identified", { botOpenId: this.botOpenId });
    } catch (error) {
      this.logger.warn("feishu bot open_id lookup failed, mention-only group filtering disabled", {
        error: (error as Error).message,
      });
    }

    const handles: EventHandles = {
      "im.message.receive_v1": async (data) => {
        try {
          const event = data as FeishuReceiveEvent;
          const rawMsg = event.message ?? event.event?.message;
          this.logger.info("feishu message event received", {
            messageId: rawMsg?.message_id,
            messageType: rawMsg?.message_type,
            chatType: rawMsg?.chat_type,
          });
          await this.onMessage(event);
        } catch (error) {
          this.logger.error("feishu message handler failed", {
            error: (error as Error).message,
          });
        }
      },
    };

    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register(handles);

    this.wsClient = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.logger.info("feishu websocket connected");
  }

  async reply(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as FeishuReplyContext;
    if (!ctx?.messageId) {
      throw new Error("feishu reply context missing messageId");
    }

    const payload = buildReplyContent(content);
    const response = await this.client.im.v1.message.reply({
      path: {
        message_id: ctx.messageId,
      },
      data: {
        msg_type: payload.msgType,
        content: payload.body,
      },
    });

    if (!isFeishuOk(response)) {
      throw new Error(`feishu reply failed: ${JSON.stringify(response)}`);
    }
  }

  async send(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as FeishuReplyContext;
    if (!ctx?.chatId) {
      throw new Error("feishu reply context missing chatId");
    }

    const payload = buildReplyContent(content);
    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: ctx.chatId,
        msg_type: payload.msgType,
        content: payload.body,
      },
    });

    if (!isFeishuOk(response)) {
      throw new Error(`feishu send failed: ${JSON.stringify(response)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = undefined;
    }
  }
}
