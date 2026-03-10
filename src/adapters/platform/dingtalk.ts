import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DWClient,
  EventAck,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";
import type { DeliveryTarget, InboundMessage, MessageHandler, PlatformAdapter } from "../../core/types.js";
import { writeJsonAtomic } from "../../infra/store-json/atomic.js";
import { Logger } from "../../logging.js";
import { buildDingTalkReplyPayload, buildDingTalkRobotSendPayload } from "./dingtalk-content.js";
import { parseAllowList } from "./shared/allow-list.js";
import { createDeliveryTarget } from "./shared/delivery-target.js";

const MESSAGE_DEDUP_TTL_MS = 10 * 60_000;
const STREAM_CONNECT_TIMEOUT_MS = 5_000;
const STREAM_CONNECT_POLL_MS = 100;
const WEBHOOK_SEND_TIMEOUT_MS = 30_000;
const PROCESSING_NOTICE_DELAY_MS = 1_000;
const DEFAULT_PROCESSING_NOTICE = "处理中...";
const LOG_CONTENT_PREVIEW_LENGTH = 120;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const QUOTED_CACHE_TTL_MS = 24 * 60 * 60_000;
const GROUP_FILE_MATCH_WINDOW_MS = 5_000;
const GROUP_FILE_MAX_PAGES = 3;
const GROUP_FILE_PAGE_SIZE = 50;
const DIRECT_CONVERSATION_TYPE = "1";
const DINGTALK_OAUTH_ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DINGTALK_MEDIA_DOWNLOAD_URL = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
const DINGTALK_API_BASE = "https://api.dingtalk.com";
const DINGTALK_ROBOT_GROUP_SEND_URL = `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`;
const DINGTALK_ROBOT_DIRECT_SEND_URL = `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`;
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";
const DEFAULT_INBOUND_MEDIA_DIR = join(tmpdir(), "d-connect", "dingtalk-media");

type DingTalkMediaKind = "image" | "audio" | "video" | "file";

export interface DingTalkOptions {
  clientId: string;
  clientSecret: string;
  allowFrom?: string;
  processingNotice?: string;
  inboundMediaDir?: string;
}

export interface DingTalkReplyContext {
  messageId: string;
  conversationId: string;
  senderId: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
}

interface DingTalkRichTextPart {
  type?: string;
  msgType?: string;
  text?: string;
  content?: string;
  atName?: string;
  downloadCode?: string;
}

interface DingTalkRepliedMessage {
  msgType?: string;
  msgId?: string;
  createdAt?: number;
  content?: {
    text?: string;
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: DingTalkRichTextPart[];
  };
}

interface DingTalkInboundMessage {
  conversationId: string;
  conversationType?: string;
  conversationTitle?: string;
  chatbotUserId: string;
  msgId: string;
  senderNick?: string;
  senderStaffId?: string;
  sessionWebhookExpiredTime?: number;
  createAt: number;
  senderId: string;
  sessionWebhook?: string;
  robotCode?: string;
  msgtype?: string;
  originalMsgId?: string;
  quoteMessage?: {
    msgId?: string;
    msgtype?: string;
    text?: { content?: string };
    senderNick?: string;
    senderId?: string;
  };
  text?: {
    content?: string;
    isReplyMsg?: boolean;
    repliedMsg?: DingTalkRepliedMessage;
  };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    spaceId?: string;
    fileId?: string;
    quoteContent?: string;
    richText?: DingTalkRichTextPart[];
  };
}

interface DingTalkActiveSendTarget {
  openConversationId?: string;
  conversationType?: string;
  robotCode?: string;
  userId?: string;
}

interface ParsedMediaAttachment {
  source: "current" | "quoted";
  kind: DingTalkMediaKind;
  downloadCode?: string;
  fileName?: string;
  quotedMsgId?: string;
  quotedCreatedAt?: number;
}

interface ParsedInboundContent {
  messageType: string;
  text: string;
  preview: string;
  currentMedia?: ParsedMediaAttachment;
  quotedMedia?: ParsedMediaAttachment;
}

interface DownloadedMediaFile {
  path: string;
  contentType: string;
}

interface DownloadCodeCacheEntry {
  downloadCode: string;
  msgType: DingTalkMediaKind;
  createdAt: number;
  expiresAt: number;
  spaceId?: string;
  fileId?: string;
  fileName?: string;
  recognition?: string;
}

interface PersistedQuotedMediaCache {
  conversations: Record<string, Record<string, DownloadCodeCacheEntry>>;
}

function normalizeUserId(msg: DingTalkInboundMessage): string {
  return msg.senderStaffId || msg.senderId || msg.chatbotUserId;
}

function extractSessionKey(msg: DingTalkInboundMessage): string {
  const userId = normalizeUserId(msg);
  return `dingtalk:${msg.conversationId}:${userId}`;
}

function isOldMessage(createAt: number, startedAt: number): boolean {
  return createAt > 0 && createAt < startedAt;
}

function normalizeProcessingNotice(value?: string): string {
  if (value === "none") {
    return "";
  }

  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_PROCESSING_NOTICE;
}

function previewContent(content: string): string {
  if (content.length <= LOG_CONTENT_PREVIEW_LENGTH) {
    return content;
  }

  return `${content.slice(0, LOG_CONTENT_PREVIEW_LENGTH)}...`;
}

function sanitizeFileToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return normalized.length > 0 ? normalized.slice(0, 80) : "media";
}

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/amr":
      return ".amr";
    case "video/mp4":
      return ".mp4";
    case "application/pdf":
      return ".pdf";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function parseDingTalkFileTime(timeText: string): number {
  const normalized = timeText.replace(/\bCST\b/, "+0800");
  const value = Date.parse(normalized);
  if (!Number.isFinite(value)) {
    throw new Error(`cannot parse DingTalk file time: ${timeText}`);
  }
  return value;
}

function extractQuoteRichText(parts: DingTalkRichTextPart[] = []): string {
  const textParts: string[] = [];

  for (const part of parts) {
    const type = (part.msgType ?? part.type ?? "").toLowerCase();
    if (type === "text" && typeof part.content === "string" && part.content.trim().length > 0) {
      textParts.push(part.content.trim());
      continue;
    }
    if (type === "emoji" && typeof part.content === "string" && part.content.trim().length > 0) {
      textParts.push(part.content.trim());
      continue;
    }
    if (type === "picture") {
      textParts.push("[图片]");
      continue;
    }
    if (type === "at") {
      const atName = typeof part.atName === "string" && part.atName.trim().length > 0
        ? part.atName.trim()
        : typeof part.content === "string"
          ? part.content.trim()
          : "";
      if (atName) {
        textParts.push(`@${atName}`);
      }
      continue;
    }
    if (typeof part.content === "string" && part.content.trim().length > 0) {
      textParts.push(part.content.trim());
    }
  }

  return textParts.join("").trim();
}

function extractRichTextContent(parts: DingTalkRichTextPart[] = []): { text: string; imageDownloadCode?: string } {
  const textParts: string[] = [];
  let imageDownloadCode: string | undefined;

  for (const part of parts) {
    const type = (part.type ?? part.msgType ?? "").toLowerCase();
    if ((type === "text" || !type) && typeof part.text === "string" && part.text.trim().length > 0) {
      textParts.push(part.text.trim());
      continue;
    }

    if ((type === "text" || !type) && typeof part.content === "string" && part.content.trim().length > 0) {
      textParts.push(part.content.trim());
      continue;
    }

    if (type === "at" && typeof part.atName === "string" && part.atName.trim().length > 0) {
      textParts.push(`@${part.atName.trim()}`);
      continue;
    }

    if (type === "picture" && typeof part.downloadCode === "string" && part.downloadCode.trim().length > 0 && !imageDownloadCode) {
      imageDownloadCode = part.downloadCode.trim();
    }
  }

  return {
    text: textParts.join(" ").trim(),
    imageDownloadCode,
  };
}

function buildMediaHeading(attachment: ParsedMediaAttachment): string {
  const quoted = attachment.source === "quoted" ? "Quoted " : "";
  return `[${quoted}DingTalk ${attachment.kind}]`;
}

function buildTypedMediaKey(kind: DingTalkMediaKind, suffix: string): string {
  if (kind === "file" && suffix === "file_name") {
    return "file_name";
  }

  return `${kind}_${suffix}`;
}

function buildPreviewContent(parsed: ParsedInboundContent): string {
  if (parsed.text.length > 0) {
    return parsed.text;
  }

  if (parsed.currentMedia) {
    return buildMediaHeading(parsed.currentMedia);
  }

  if (parsed.quotedMedia) {
    return buildMediaHeading(parsed.quotedMedia);
  }

  return `[${parsed.messageType}]`;
}

function buildMediaBlock(
  attachment: ParsedMediaAttachment,
  file: DownloadedMediaFile | null,
): string {
  const lines = [buildMediaHeading(attachment)];
  const kindKey = attachment.kind;

  if (attachment.fileName) {
    lines.push(`media_file_name: ${attachment.fileName}`);
    lines.push(`${buildTypedMediaKey(kindKey, "file_name")}: ${attachment.fileName}`);
  }

  if (file) {
    lines.push(`media_path: ${file.path}`);
    lines.push(`media_mime_type: ${file.contentType}`);
    lines.push(`${buildTypedMediaKey(kindKey, "path")}: ${file.path}`);
    lines.push(`${buildTypedMediaKey(kindKey, "mime_type")}: ${file.contentType}`);
    return lines.join("\n");
  }

  if (attachment.downloadCode) {
    lines.push(`media_download_code: ${attachment.downloadCode}`);
    lines.push(`${buildTypedMediaKey(kindKey, "download_code")}: ${attachment.downloadCode}`);
  }

  if (attachment.quotedMsgId) {
    lines.push(`quoted_msg_id: ${attachment.quotedMsgId}`);
  }

  if (attachment.quotedCreatedAt) {
    lines.push(`quoted_created_at: ${attachment.quotedCreatedAt}`);
  }

  lines.push("media_status: unavailable");
  lines.push(`${buildTypedMediaKey(kindKey, "status")}: unavailable`);
  return lines.join("\n");
}

function buildInboundContent(
  parsed: ParsedInboundContent,
  currentMediaFile: DownloadedMediaFile | null,
  quotedMediaFile: DownloadedMediaFile | null,
): string {
  const parts: string[] = [];

  if (parsed.text.trim().length > 0) {
    parts.push(parsed.text.trim());
  }

  if (parsed.currentMedia) {
    parts.push(buildMediaBlock(parsed.currentMedia, currentMediaFile));
  }

  if (parsed.quotedMedia) {
    parts.push(buildMediaBlock(parsed.quotedMedia, quotedMediaFile));
  }

  if (parts.length === 0) {
    return buildPreviewContent(parsed);
  }

  return parts.join("\n\n");
}

function replaceLeadingPrefix(text: string, fromPrefix: string, toPrefix: string): string {
  if (text.startsWith(fromPrefix)) {
    return `${toPrefix}${text.slice(fromPrefix.length)}`;
  }
  return text;
}

function parseQuotedInfo(raw: DingTalkInboundMessage): { prefix: string; media?: ParsedMediaAttachment } {
  const textField = raw.text;
  const repliedMsg = textField?.repliedMsg;

  if (textField?.isReplyMsg && repliedMsg) {
    const repliedMsgType = (repliedMsg.msgType ?? "").trim();
    const content = repliedMsg.content;

    if (repliedMsgType === "text" && content?.text?.trim()) {
      return { prefix: `[引用消息: "${content.text.trim()}"]\n\n` };
    }

    if ((repliedMsgType === "picture" || repliedMsgType === "image") && content?.downloadCode) {
      return {
        prefix: "[引用图片]\n\n",
        media: {
          source: "quoted",
          kind: "image",
          downloadCode: content.downloadCode.trim(),
          quotedMsgId: repliedMsg.msgId?.trim(),
          quotedCreatedAt: repliedMsg.createdAt,
        },
      };
    }

    if (repliedMsgType === "audio") {
      const recognition = content?.recognition?.trim();
      if (recognition) {
        return { prefix: `[引用语音: "${recognition}"]\n\n` };
      }

      if (content?.downloadCode) {
        return {
          prefix: "[引用语音]\n\n",
          media: {
            source: "quoted",
            kind: "audio",
            downloadCode: content.downloadCode.trim(),
            fileName: content.fileName?.trim(),
            quotedMsgId: repliedMsg.msgId?.trim(),
            quotedCreatedAt: repliedMsg.createdAt,
          },
        };
      }
    }

    if (repliedMsgType === "video" && content?.downloadCode) {
      return {
        prefix: "[引用视频]\n\n",
        media: {
          source: "quoted",
          kind: "video",
          downloadCode: content.downloadCode.trim(),
          fileName: content.fileName?.trim(),
          quotedMsgId: repliedMsg.msgId?.trim(),
          quotedCreatedAt: repliedMsg.createdAt,
        },
      };
    }

    if (repliedMsgType === "file" && content?.downloadCode) {
      return {
        prefix: "[引用文件]\n\n",
        media: {
          source: "quoted",
          kind: "file",
          downloadCode: content.downloadCode.trim(),
          fileName: content.fileName?.trim(),
          quotedMsgId: repliedMsg.msgId?.trim(),
          quotedCreatedAt: repliedMsg.createdAt,
        },
      };
    }

    if (repliedMsgType === "unknownMsgType") {
      return {
        prefix: "[引用文件/视频/语音]\n\n",
        media: {
          source: "quoted",
          kind: "file",
          downloadCode: content?.downloadCode?.trim(),
          fileName: content?.fileName?.trim(),
          quotedMsgId: repliedMsg.msgId?.trim(),
          quotedCreatedAt: repliedMsg.createdAt,
        },
      };
    }

    if (repliedMsgType === "interactiveCard") {
      return { prefix: "[引用了机器人的回复]\n\n" };
    }

    if (repliedMsgType) {
      return { prefix: "[引用了一条消息]\n\n" };
    }

    if (content?.text?.trim()) {
      return { prefix: `[引用消息: "${content.text.trim()}"]\n\n` };
    }

    const quoteText = extractQuoteRichText(content?.richText);
    if (quoteText) {
      return { prefix: `[引用消息: "${quoteText}"]\n\n` };
    }
  }

  if (textField?.isReplyMsg && !repliedMsg && raw.originalMsgId) {
    return { prefix: `[这是一条引用消息，原消息ID: ${raw.originalMsgId}]\n\n` };
  }

  const legacyQuoteText = raw.quoteMessage?.text?.content?.trim();
  if (legacyQuoteText) {
    return { prefix: `[引用消息: "${legacyQuoteText}"]\n\n` };
  }

  const quoteContent = raw.content?.quoteContent?.trim();
  if (quoteContent) {
    return { prefix: `[引用消息: "${quoteContent}"]\n\n` };
  }

  return { prefix: "" };
}

function parseInboundContent(raw: DingTalkInboundMessage): ParsedInboundContent | null {
  const quoted = parseQuotedInfo(raw);

  switch (raw.msgtype) {
    case "text": {
      const text = `${quoted.prefix}${raw.text?.content?.trim() ?? ""}`.trim();
      return {
        messageType: "text",
        text,
        preview: text || quoted.prefix.trim() || "[DingTalk text]",
        quotedMedia: quoted.media,
      };
    }
    case "richText": {
      const extracted = extractRichTextContent(raw.content?.richText);
      const text = `${quoted.prefix}${extracted.text}`.trim();
      const currentMedia = extracted.imageDownloadCode
        ? {
            source: "current" as const,
            kind: "image" as const,
            downloadCode: extracted.imageDownloadCode,
          }
        : undefined;
      return {
        messageType: "richText",
        text,
        preview: text || (currentMedia ? buildMediaHeading(currentMedia) : "[富文本消息]"),
        currentMedia,
        quotedMedia: quoted.media,
      };
    }
    case "picture":
    case "image": {
      const currentMedia: ParsedMediaAttachment = {
        source: "current",
        kind: "image",
        downloadCode: raw.content?.downloadCode?.trim(),
      };
      return {
        messageType: raw.msgtype,
        text: quoted.prefix.trim(),
        preview: quoted.prefix.trim() || buildMediaHeading(currentMedia),
        currentMedia,
        quotedMedia: quoted.media,
      };
    }
    case "audio": {
      const recognition = raw.content?.recognition?.trim() ?? "";
      const currentMedia: ParsedMediaAttachment | undefined = recognition.length > 0
        ? undefined
        : {
            source: "current" as const,
            kind: "audio" as const,
            downloadCode: raw.content?.downloadCode?.trim(),
          };
      const text = `${quoted.prefix}${recognition}`.trim();
      return {
        messageType: "audio",
        text,
        preview: text || (currentMedia ? buildMediaHeading(currentMedia) : "[DingTalk audio]"),
        currentMedia,
        quotedMedia: quoted.media,
      };
    }
    case "video": {
      const currentMedia: ParsedMediaAttachment = {
        source: "current",
        kind: "video",
        downloadCode: raw.content?.downloadCode?.trim(),
      };
      return {
        messageType: "video",
        text: quoted.prefix.trim(),
        preview: quoted.prefix.trim() || buildMediaHeading(currentMedia),
        currentMedia,
        quotedMedia: quoted.media,
      };
    }
    case "file": {
      const currentMedia: ParsedMediaAttachment = {
        source: "current",
        kind: "file",
        downloadCode: raw.content?.downloadCode?.trim(),
        fileName: raw.content?.fileName?.trim(),
      };
      return {
        messageType: "file",
        text: quoted.prefix.trim(),
        preview: quoted.prefix.trim() || buildMediaHeading(currentMedia),
        currentMedia,
        quotedMedia: quoted.media,
      };
    }
    default:
      return null;
  }
}

export class DingTalkAdapter implements PlatformAdapter {
  readonly name = "dingtalk";

  private client?: DWClient;
  private handler?: MessageHandler;
  private readonly allowList: Set<string> | null;
  private readonly dedup = new Map<string, number>();
  private readonly startedAt = Date.now();
  private readonly processingNotice: string;
  private readonly inboundMediaDir: string;
  private readonly quotedCachePath: string;
  private readonly quotedCache = new Map<string, Map<string, DownloadCodeCacheEntry>>();
  private quotedCacheLoaded = false;
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private accessTokenPromise?: Promise<string>;
  private readonly unionIdCache = new Map<string, string>();
  private readonly groupSpaceIdCache = new Map<string, string>();

  constructor(private readonly options: DingTalkOptions, private readonly logger: Logger) {
    this.allowList = parseAllowList(options.allowFrom);
    this.processingNotice = normalizeProcessingNotice(options.processingNotice);
    this.inboundMediaDir = options.inboundMediaDir?.trim() || DEFAULT_INBOUND_MEDIA_DIR;
    this.quotedCachePath = join(
      this.inboundMediaDir,
      `.quoted-msg-cache-${sanitizeFileToken(options.clientId)}.json`,
    );
  }

  private isAllowed(userId: string): boolean {
    if (!this.allowList) {
      return true;
    }
    return this.allowList.has(userId);
  }

  private rememberMessageId(messageId: string): boolean {
    const now = Date.now();

    for (const [seenMessageId, seenAt] of this.dedup) {
      if (now - seenAt > MESSAGE_DEDUP_TTL_MS) {
        this.dedup.delete(seenMessageId);
      }
    }

    if (!messageId) {
      return true;
    }

    if (this.dedup.has(messageId)) {
      return false;
    }

    this.dedup.set(messageId, now);
    return true;
  }

  private async waitForConnected(client: DWClient): Promise<void> {
    const deadline = Date.now() + STREAM_CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (client.connected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STREAM_CONNECT_POLL_MS));
    }

    throw new Error(`dingtalk stream did not connect within ${STREAM_CONNECT_TIMEOUT_MS}ms`);
  }

  private assertWebhookAvailable(sessionWebhook: string, sessionWebhookExpiredTime?: number): void {
    if (!sessionWebhook) {
      throw new Error("missing sessionWebhook in reply context");
    }

    if (typeof sessionWebhookExpiredTime === "number" && sessionWebhookExpiredTime > 0 && sessionWebhookExpiredTime <= Date.now()) {
      throw new Error("dingtalk sessionWebhook expired; wait for a fresh DingTalk message to refresh the delivery target");
    }
  }

  private hasFreshWebhook(sessionWebhook: string, sessionWebhookExpiredTime?: number): boolean {
    return !!sessionWebhook
      && (sessionWebhookExpiredTime === undefined || sessionWebhookExpiredTime <= 0 || sessionWebhookExpiredTime > Date.now());
  }

  private extractActiveSendTarget(payload: DeliveryTarget["payload"]): DingTalkActiveSendTarget {
    const openConversationId = typeof payload.openConversationId === "string"
      ? payload.openConversationId.trim()
      : typeof payload.conversationId === "string"
        ? payload.conversationId.trim()
        : "";
    const conversationType = typeof payload.conversationType === "string" ? payload.conversationType.trim() : "";
    const robotCode = typeof payload.robotCode === "string" ? payload.robotCode.trim() : "";
    const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";

    return {
      ...(openConversationId ? { openConversationId } : {}),
      ...(conversationType ? { conversationType } : {}),
      ...(robotCode ? { robotCode } : {}),
      ...(userId ? { userId } : {}),
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async saveMediaResponse(hint: string, response: Response): Promise<DownloadedMediaFile> {
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    const extension = extensionFromContentType(contentType);
    const filename = `${Date.now()}-${sanitizeFileToken(hint)}${extension}`;

    await mkdir(this.inboundMediaDir, { recursive: true });
    const path = join(this.inboundMediaDir, filename);
    await writeFile(path, buffer);

    return {
      path,
      contentType,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now()) {
      return this.accessToken;
    }

    if (this.accessTokenPromise) {
      return this.accessTokenPromise;
    }

    this.accessTokenPromise = (async () => {
      const res = await this.fetchWithTimeout(
        DINGTALK_OAUTH_ACCESS_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            appKey: this.options.clientId,
            appSecret: this.options.clientSecret,
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`dingtalk token fetch failed: ${res.status} ${body}`);
      }

      const payload = await res.json() as {
        accessToken?: string;
        expireIn?: number;
        access_token?: string;
        expires_in?: number;
      };
      const accessToken = payload.accessToken?.trim() || payload.access_token?.trim();
      if (!accessToken) {
        throw new Error("dingtalk token response missing access token");
      }

      const expiresInMs = Math.max(
        ((payload.expireIn ?? payload.expires_in ?? 7200) * 1000) - ACCESS_TOKEN_REFRESH_BUFFER_MS,
        1_000,
      );
      this.accessToken = accessToken;
      this.accessTokenExpiresAt = Date.now() + expiresInMs;
      return accessToken;
    })();

    try {
      return await this.accessTokenPromise;
    } finally {
      this.accessTokenPromise = undefined;
    }
  }

  private async ensureQuotedCacheLoaded(): Promise<void> {
    if (this.quotedCacheLoaded) {
      return;
    }

    this.quotedCacheLoaded = true;
    try {
      const raw = await readFile(this.quotedCachePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedQuotedMediaCache;
      const now = Date.now();

      for (const [conversationId, entries] of Object.entries(parsed.conversations ?? {})) {
        const bucket = new Map<string, DownloadCodeCacheEntry>();
        for (const [msgId, entry] of Object.entries(entries ?? {})) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          if (typeof entry.downloadCode !== "string" || entry.downloadCode.length === 0) {
            continue;
          }
          if (typeof entry.expiresAt !== "number" || entry.expiresAt <= now) {
            continue;
          }
          bucket.set(msgId, entry);
        }
        if (bucket.size > 0) {
          this.quotedCache.set(conversationId, bucket);
        }
      }
    } catch {
      // ignore missing or invalid cache files
    }
  }

  private quotedCacheSnapshot(): PersistedQuotedMediaCache {
    const conversations: Record<string, Record<string, DownloadCodeCacheEntry>> = {};

    for (const [conversationId, bucket] of this.quotedCache) {
      const entries: Record<string, DownloadCodeCacheEntry> = {};
      for (const [msgId, entry] of bucket) {
        entries[msgId] = entry;
      }
      if (Object.keys(entries).length > 0) {
        conversations[conversationId] = entries;
      }
    }

    return { conversations };
  }

  private purgeExpiredQuotedCache(): void {
    const now = Date.now();

    for (const [conversationId, bucket] of this.quotedCache) {
      for (const [msgId, entry] of bucket) {
        if (entry.expiresAt <= now) {
          bucket.delete(msgId);
        }
      }
      if (bucket.size === 0) {
        this.quotedCache.delete(conversationId);
      }
    }
  }

  private async saveQuotedCache(): Promise<void> {
    this.purgeExpiredQuotedCache();
    await writeJsonAtomic(this.quotedCachePath, this.quotedCacheSnapshot());
  }

  private async rememberInboundMedia(raw: DingTalkInboundMessage, attachment?: ParsedMediaAttachment): Promise<void> {
    if (!attachment || attachment.source !== "current" || !attachment.downloadCode || !raw.msgId || !raw.conversationId) {
      return;
    }

    await this.ensureQuotedCacheLoaded();

    const bucket = this.quotedCache.get(raw.conversationId) ?? new Map<string, DownloadCodeCacheEntry>();
    bucket.set(raw.msgId, {
      downloadCode: attachment.downloadCode,
      msgType: attachment.kind,
      createdAt: raw.createAt,
      expiresAt: Date.now() + QUOTED_CACHE_TTL_MS,
      spaceId: raw.content?.spaceId?.trim(),
      fileId: raw.content?.fileId?.trim(),
      fileName: attachment.fileName,
      recognition: attachment.kind === "audio" ? raw.content?.recognition?.trim() : undefined,
    });
    this.quotedCache.set(raw.conversationId, bucket);
    await this.saveQuotedCache();
  }

  private cacheableCurrentAttachment(
    raw: DingTalkInboundMessage,
    parsed: ParsedInboundContent,
  ): ParsedMediaAttachment | undefined {
    if (parsed.currentMedia) {
      return parsed.currentMedia;
    }

    if (raw.msgtype === "audio" && raw.content?.recognition?.trim() && raw.content?.downloadCode?.trim()) {
      return {
        source: "current",
        kind: "audio",
        downloadCode: raw.content.downloadCode.trim(),
      };
    }

    return undefined;
  }

  private async findQuotedCacheEntry(conversationId: string, msgId: string): Promise<DownloadCodeCacheEntry | null> {
    await this.ensureQuotedCacheLoaded();
    this.purgeExpiredQuotedCache();
    return this.quotedCache.get(conversationId)?.get(msgId) ?? null;
  }

  private async findQuotedCacheEntryByCreatedAt(
    conversationId: string,
    createdAt: number,
  ): Promise<DownloadCodeCacheEntry | null> {
    await this.ensureQuotedCacheLoaded();
    this.purgeExpiredQuotedCache();

    const bucket = this.quotedCache.get(conversationId);
    if (!bucket) {
      return null;
    }

    let bestMatch: DownloadCodeCacheEntry | null = null;
    let bestDelta = Infinity;

    for (const entry of bucket.values()) {
      const delta = Math.abs(entry.createdAt - createdAt);
      if (delta <= GROUP_FILE_MATCH_WINDOW_MS && delta < bestDelta) {
        bestDelta = delta;
        bestMatch = entry;
      }
    }

    return bestMatch;
  }

  private async findBestQuotedCacheEntry(
    conversationId: string,
    msgId?: string,
    createdAt?: number,
  ): Promise<DownloadCodeCacheEntry | null> {
    if (msgId) {
      const directMatch = await this.findQuotedCacheEntry(conversationId, msgId);
      if (directMatch) {
        return directMatch;
      }
    }

    if (!createdAt) {
      return null;
    }

    return this.findQuotedCacheEntryByCreatedAt(conversationId, createdAt);
  }

  private async enrichQuotedAudioRecognition(
    raw: DingTalkInboundMessage,
    parsed: ParsedInboundContent,
  ): Promise<void> {
    const repliedMsg = raw.text?.repliedMsg;
    if (!repliedMsg || !parsed.quotedMedia) {
      return;
    }

    const repliedMsgType = repliedMsg.msgType?.trim();
    if (repliedMsgType !== "unknownMsgType" && repliedMsgType !== "audio") {
      return;
    }

    const cached = await this.findBestQuotedCacheEntry(
      raw.conversationId,
      repliedMsg.msgId?.trim(),
      repliedMsg.createdAt,
    );
    if (!cached) {
      return;
    }

    parsed.quotedMedia.kind = cached.msgType;
    parsed.quotedMedia.fileName = parsed.quotedMedia.fileName ?? cached.fileName;
    parsed.quotedMedia.downloadCode = parsed.quotedMedia.downloadCode ?? cached.downloadCode;

    if (cached.msgType !== "audio" || !cached.recognition?.trim()) {
      return;
    }

    const fromPrefix = repliedMsgType === "audio" ? "[引用语音]\n\n" : "[引用文件/视频/语音]\n\n";
    const toPrefix = `[引用语音: "${cached.recognition.trim()}"]\n\n`;
    parsed.text = replaceLeadingPrefix(parsed.text, fromPrefix, toPrefix).trim();
    parsed.preview = parsed.text || toPrefix.trim();
    parsed.quotedMedia = undefined;
  }

  private async downloadMediaByDownloadCode(downloadCode: string, robotCode?: string): Promise<DownloadedMediaFile | null> {
    if (!downloadCode || !robotCode) {
      return null;
    }

    const token = await this.getAccessToken();
    const downloadRes = await this.fetchWithTimeout(
      DINGTALK_MEDIA_DOWNLOAD_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          downloadCode,
          robotCode,
        }),
      },
    );

    if (!downloadRes.ok) {
      const body = await downloadRes.text();
      throw new Error(`dingtalk media download failed: ${downloadRes.status} ${body}`);
    }

    const payload = await downloadRes.json() as { downloadUrl?: string; data?: { downloadUrl?: string } };
    const downloadUrl = payload.downloadUrl ?? payload.data?.downloadUrl;
    if (!downloadUrl) {
      throw new Error("dingtalk media download response missing downloadUrl");
    }

    const fileRes = await this.fetchWithTimeout(downloadUrl, { method: "GET" });
    if (!fileRes.ok) {
      const body = await fileRes.text();
      throw new Error(`dingtalk media file fetch failed: ${fileRes.status} ${body}`);
    }

    return this.saveMediaResponse(downloadCode, fileRes);
  }

  private async getUnionIdByStaffId(staffId: string): Promise<string> {
    const cached = this.unionIdCache.get(staffId);
    if (cached) {
      return cached;
    }

    const token = await this.getAccessToken();
    const res = await this.fetchWithTimeout(
      `${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userid: staffId,
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`topapi/v2/user/get failed: ${res.status} ${body}`);
    }

    const payload = await res.json() as {
      errcode?: number;
      errmsg?: string;
      result?: {
        unionid?: string;
      };
    };
    if (payload.errcode !== 0 || !payload.result?.unionid) {
      throw new Error(`topapi/v2/user/get failed: ${payload.errmsg ?? "missing unionid"}`);
    }

    this.unionIdCache.set(staffId, payload.result.unionid);
    return payload.result.unionid;
  }

  private async getGroupFileSpaceId(conversationId: string, unionId: string): Promise<string> {
    const cacheKey = `${conversationId}:${unionId}`;
    const cached = this.groupSpaceIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const token = await this.getAccessToken();
    const res = await this.fetchWithTimeout(
      `${DINGTALK_API_BASE}/v1.0/convFile/conversations/spaces/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          openConversationId: conversationId,
          unionId,
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`convFile spaces/query failed: ${res.status} ${body}`);
    }

    const payload = await res.json() as {
      space?: {
        spaceId?: string;
      };
    };
    const spaceId = payload.space?.spaceId?.trim();
    if (!spaceId) {
      throw new Error("convFile spaces/query returned no spaceId");
    }

    this.groupSpaceIdCache.set(cacheKey, spaceId);
    return spaceId;
  }

  private async findGroupFileByTimestamp(
    spaceId: string,
    unionId: string,
    createdAt: number,
  ): Promise<{ dentryId: string; name: string } | null> {
    const token = await this.getAccessToken();
    let bestMatch: { dentryId: string; name: string } | null = null;
    let bestDelta = Infinity;
    let nextToken: string | undefined;

    for (let page = 0; page < GROUP_FILE_MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        option: {
          maxResults: GROUP_FILE_PAGE_SIZE,
        },
      };
      if (nextToken) {
        body.option = {
          ...(body.option as Record<string, unknown>),
          nextToken,
        };
      }

      const res = await this.fetchWithTimeout(
        `${DINGTALK_API_BASE}/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/listAll?unionId=${encodeURIComponent(unionId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const responseBody = await res.text();
        throw new Error(`storage dentries/listAll failed: ${res.status} ${responseBody}`);
      }

      const payload = await res.json() as {
        dentries?: Array<{
          id?: string;
          name?: string;
          type?: string;
          createTime?: string;
        }>;
        nextToken?: string;
      };

      for (const entry of payload.dentries ?? []) {
        if (entry.type !== "FILE" || !entry.id || !entry.createTime) {
          continue;
        }

        try {
          const fileTime = parseDingTalkFileTime(entry.createTime);
          const delta = Math.abs(fileTime - createdAt);
          if (delta <= GROUP_FILE_MATCH_WINDOW_MS && delta < bestDelta) {
            bestDelta = delta;
            bestMatch = {
              dentryId: entry.id,
              name: entry.name ?? entry.id,
            };
          }
        } catch {
          // ignore malformed timestamps
        }
      }

      if (bestMatch && bestDelta < 1_000) {
        break;
      }

      nextToken = payload.nextToken;
      if (!nextToken) {
        break;
      }
    }

    return bestMatch;
  }

  private async downloadGroupFile(spaceId: string, fileId: string, unionId: string): Promise<DownloadedMediaFile | null> {
    const token = await this.getAccessToken();
    const infoRes = await this.fetchWithTimeout(
      `${DINGTALK_API_BASE}/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(fileId)}/downloadInfos/query?unionId=${encodeURIComponent(unionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({}),
      },
    );

    if (!infoRes.ok) {
      const body = await infoRes.text();
      throw new Error(`storage downloadInfos/query failed: ${infoRes.status} ${body}`);
    }

    const payload = await infoRes.json() as {
      headerSignatureInfo?: {
        resourceUrls?: string[];
        headers?: Record<string, string>;
      };
    };
    const resourceUrl = payload.headerSignatureInfo?.resourceUrls?.[0];
    if (!resourceUrl) {
      throw new Error("storage downloadInfos/query returned no resourceUrl");
    }

    const fileRes = await this.fetchWithTimeout(resourceUrl, {
      method: "GET",
      headers: payload.headerSignatureInfo?.headers,
    });

    if (!fileRes.ok) {
      const body = await fileRes.text();
      throw new Error(`group file download failed: ${fileRes.status} ${body}`);
    }

    return this.saveMediaResponse(fileId, fileRes);
  }

  private async resolveQuotedMediaFromGroup(
    raw: DingTalkInboundMessage,
    attachment: ParsedMediaAttachment,
    cached?: DownloadCodeCacheEntry | null,
  ): Promise<DownloadedMediaFile | null> {
    if (raw.conversationType === DIRECT_CONVERSATION_TYPE || !raw.senderStaffId) {
      return null;
    }

    const unionId = await this.getUnionIdByStaffId(raw.senderStaffId);

    if (cached?.spaceId && cached.fileId) {
      return this.downloadGroupFile(cached.spaceId, cached.fileId, unionId);
    }

    if (!attachment.quotedCreatedAt) {
      return null;
    }

    const spaceId = await this.getGroupFileSpaceId(raw.conversationId, unionId);
    const match = await this.findGroupFileByTimestamp(spaceId, unionId, attachment.quotedCreatedAt);
    if (!match) {
      return null;
    }

    return this.downloadGroupFile(spaceId, match.dentryId, unionId);
  }

  private async resolveMediaAttachment(
    raw: DingTalkInboundMessage,
    attachment: ParsedMediaAttachment | undefined,
  ): Promise<DownloadedMediaFile | null> {
    if (!attachment) {
      return null;
    }

    try {
      if (attachment.source === "current") {
        if (!attachment.downloadCode) {
          return null;
        }
        return await this.downloadMediaByDownloadCode(attachment.downloadCode, raw.robotCode);
      }

      const cached = await this.findBestQuotedCacheEntry(
        raw.conversationId,
        attachment.quotedMsgId,
        attachment.quotedCreatedAt,
      );
      if (cached) {
        attachment.kind = cached.msgType;
        attachment.fileName = attachment.fileName ?? cached.fileName;

        if (cached.downloadCode) {
          try {
            return await this.downloadMediaByDownloadCode(cached.downloadCode, raw.robotCode);
          } catch (error) {
            this.logger.warn("failed to download quoted dingtalk media by cached downloadCode", {
              conversationId: raw.conversationId,
              quotedMsgId: attachment.quotedMsgId,
              error: (error as Error).message,
            });
          }
        }
      }

      if (attachment.downloadCode) {
        try {
          return await this.downloadMediaByDownloadCode(attachment.downloadCode, raw.robotCode);
        } catch (error) {
          this.logger.warn("failed to download quoted dingtalk media by replied downloadCode", {
            conversationId: raw.conversationId,
            quotedMsgId: attachment.quotedMsgId,
            error: (error as Error).message,
          });
        }
      }

      if (!attachment.quotedMsgId) {
        return null;
      }

      return await this.resolveQuotedMediaFromGroup(raw, attachment, cached);
    } catch (error) {
      this.logger.warn("failed to resolve dingtalk media attachment", {
        messageId: raw.msgId,
        msgtype: raw.msgtype,
        source: attachment.source,
        kind: attachment.kind,
        error: (error as Error).message,
      });
      return null;
    }
  }

  private async resolveInboundContent(message: InboundMessage, raw: DingTalkInboundMessage): Promise<InboundMessage> {
    const parsed = parseInboundContent(raw);
    if (!parsed) {
      return message;
    }

    await this.rememberInboundMedia(raw, this.cacheableCurrentAttachment(raw, parsed));
    await this.enrichQuotedAudioRecognition(raw, parsed);

    const currentMediaFile = await this.resolveMediaAttachment(raw, parsed.currentMedia);
    const quotedMediaFile = await this.resolveMediaAttachment(raw, parsed.quotedMedia);

    return {
      ...message,
      content: buildInboundContent(parsed, currentMediaFile, quotedMediaFile),
    };
  }

  private async handleMessage(
    message: InboundMessage,
    raw: DingTalkInboundMessage,
    replyContext: DingTalkReplyContext,
    hasFreshWebhook: boolean,
  ): Promise<void> {
    if (!this.handler) {
      return;
    }

    const parsed = parseInboundContent(raw);
    const cacheableCurrentAttachment = parsed ? this.cacheableCurrentAttachment(raw, parsed) : undefined;
    const needsResolvedInboundContent = !!(parsed?.currentMedia || parsed?.quotedMedia || cacheableCurrentAttachment);
    const handlerPromise = needsResolvedInboundContent
      ? (async () => {
          const resolvedMessage = await this.resolveInboundContent(message, raw);
          await this.handler?.(resolvedMessage);
        })()
      : Promise.resolve(this.handler(message));

    const shouldSendProcessingNotice =
      this.processingNotice.length > 0
      && hasFreshWebhook
      && !message.content.trim().startsWith("/");

    if (!shouldSendProcessingNotice) {
      await handlerPromise;
      return;
    }

    let completed = false;
    const timer = setTimeout(() => {
      if (completed) {
        return;
      }

      void this.sendViaWebhook(
        replyContext.sessionWebhook ?? "",
        this.processingNotice,
        replyContext.sessionWebhookExpiredTime,
      ).catch((error) => {
        this.logger.debug("dingtalk processing notice failed", {
          messageId: replyContext.messageId,
          error: (error as Error).message,
        });
      });
    }, PROCESSING_NOTICE_DELAY_MS);

    try {
      await handlerPromise;
    } finally {
      completed = true;
      clearTimeout(timer);
    }
  }

  private ackCallback(downstream: DWClientDownStream, ack: { status: EventAck; message?: string }): void {
    if (!this.client || ack.status !== EventAck.SUCCESS) {
      return;
    }

    this.client.socketCallBackResponse(downstream.headers.messageId, "");
  }

  private onDownstream = (downstream: DWClientDownStream): { status: EventAck; message?: string } => {
    try {
      if (downstream.headers.topic !== TOPIC_ROBOT) {
        return { status: EventAck.SUCCESS };
      }

      const raw = JSON.parse(downstream.data) as DingTalkInboundMessage;
      const userId = normalizeUserId(raw);
      const messageId = raw.msgId || downstream.headers.messageId;

      if (!this.rememberMessageId(messageId)) {
        this.logger.debug("ignore duplicated dingtalk message", { messageId });
        return { status: EventAck.SUCCESS };
      }

      if (isOldMessage(raw.createAt, this.startedAt)) {
        this.logger.debug("ignore old dingtalk message after startup", {
          messageId,
          createAt: raw.createAt,
        });
        return { status: EventAck.SUCCESS };
      }

      if (!this.isAllowed(userId)) {
        this.logger.warn("blocked dingtalk user", { userId });
        return { status: EventAck.SUCCESS };
      }

      const parsedContent = parseInboundContent(raw);
      if (!parsedContent) {
        this.logger.warn("unsupported dingtalk message type", { msgtype: raw.msgtype, userId });
        return { status: EventAck.SUCCESS };
      }

      const content = buildInboundContent(parsedContent, null, null);
      this.logger.debug("received dingtalk message", {
        messageId,
        streamMessageId: downstream.headers.messageId,
        conversationId: raw.conversationId,
        userId,
        createAt: raw.createAt,
        msgtype: raw.msgtype,
        contentPreview: previewContent(parsedContent.preview),
      });

      const sessionWebhook = raw.sessionWebhook?.trim();
      const sessionWebhookExpiredTime = typeof raw.sessionWebhookExpiredTime === "number"
        ? raw.sessionWebhookExpiredTime
        : undefined;
      const hasFreshWebhook = this.hasFreshWebhook(sessionWebhook ?? "", sessionWebhookExpiredTime);

      const deliveryTarget = createDeliveryTarget(this.name, {
        openConversationId: raw.conversationId,
        conversationId: raw.conversationId,
        ...(raw.conversationType ? { conversationType: raw.conversationType } : {}),
        ...(raw.robotCode?.trim() ? { robotCode: raw.robotCode.trim() } : {}),
        ...(userId ? { userId } : {}),
        ...(hasFreshWebhook && sessionWebhook
          ? {
              sessionWebhook,
              ...(sessionWebhookExpiredTime === undefined ? {} : { sessionWebhookExpiredTime }),
            }
          : {}),
      });

      if (raw.sessionWebhook && !hasFreshWebhook) {
        this.logger.debug("skip expired dingtalk delivery target", {
          messageId,
          sessionWebhookExpiredTime: raw.sessionWebhookExpiredTime,
        });
      }

      const message: InboundMessage = {
        platform: this.name,
        sessionKey: extractSessionKey(raw),
        userId,
        userName: raw.senderNick ?? userId,
        content,
        replyContext: {
          messageId,
          conversationId: raw.conversationId,
          senderId: userId,
          sessionWebhook: raw.sessionWebhook,
          sessionWebhookExpiredTime: raw.sessionWebhookExpiredTime,
        } satisfies DingTalkReplyContext,
        deliveryTarget,
      };

      if (this.handler) {
        const replyContext = message.replyContext as DingTalkReplyContext;
        void this.handleMessage(message, raw, replyContext, hasFreshWebhook).catch((error) => {
          this.logger.error("dingtalk handler failed", {
            error: (error as Error).message,
          });
        });
      }

      return { status: EventAck.SUCCESS };
    } catch (error) {
      this.logger.error("failed to parse dingtalk message", {
        error: (error as Error).message,
      });
      return { status: EventAck.LATER, message: "parse failed" };
    }
  };

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    this.client = new DWClient({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      ua: "d-connect/0.1.0",
      debug: false,
      keepAlive: true,
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
      const ack = this.onDownstream(downstream);
      this.ackCallback(downstream, ack);
    });
    try {
      await this.client.connect();
      await this.waitForConnected(this.client);
    } catch (error) {
      if (this.client) {
        this.client.disconnect();
        this.client = undefined;
      }
      throw error;
    }
    this.logger.info("dingtalk stream connected");
  }

  private async sendViaWebhook(sessionWebhook: string, content: string, sessionWebhookExpiredTime?: number): Promise<void> {
    this.assertWebhookAvailable(sessionWebhook, sessionWebhookExpiredTime);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_SEND_TIMEOUT_MS);

    try {
      const res = await fetch(sessionWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildDingTalkReplyPayload(content)),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`dingtalk webhook failed: ${res.status} ${body}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`dingtalk webhook timed out after ${WEBHOOK_SEND_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendViaRobotApi(target: DingTalkActiveSendTarget, content: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const robotCode = target.robotCode || this.options.clientId;
    const proactivePayload = buildDingTalkRobotSendPayload(content);
    const isDirectConversation = target.conversationType === DIRECT_CONVERSATION_TYPE;
    let url = DINGTALK_ROBOT_GROUP_SEND_URL;
    let requestBody: Record<string, unknown>;

    if (isDirectConversation) {
      if (!target.userId) {
        throw new Error("missing userId in dingtalk delivery target for direct proactive send");
      }

      url = DINGTALK_ROBOT_DIRECT_SEND_URL;
      requestBody = {
        robotCode,
        msgKey: proactivePayload.msgKey,
        msgParam: proactivePayload.msgParam,
        userIds: [target.userId],
      };
    } else {
      if (!target.openConversationId) {
        throw new Error("missing openConversationId in dingtalk delivery target for group proactive send");
      }

      requestBody = {
        robotCode,
        msgKey: proactivePayload.msgKey,
        msgParam: proactivePayload.msgParam,
        openConversationId: target.openConversationId,
      };
    }

    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`dingtalk robot send failed: ${res.status} ${body}`);
    }
  }

  async reply(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as DingTalkReplyContext;
    await this.sendViaWebhook(ctx?.sessionWebhook ?? "", content, ctx?.sessionWebhookExpiredTime);
  }

  async send(target: DeliveryTarget, content: string): Promise<void> {
    const sessionWebhook = typeof target.payload.sessionWebhook === "string" ? target.payload.sessionWebhook : "";
    const sessionWebhookExpiredTime =
      typeof target.payload.sessionWebhookExpiredTime === "number" ? target.payload.sessionWebhookExpiredTime : undefined;
    const activeTarget = this.extractActiveSendTarget(target.payload);
    if (activeTarget.openConversationId || activeTarget.userId) {
      await this.sendViaRobotApi(activeTarget, content);
      return;
    }

    await this.sendViaWebhook(sessionWebhook, content, sessionWebhookExpiredTime);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = undefined;
    }
  }
}
