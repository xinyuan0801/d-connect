import type { DeliveryTarget, InboundMessage, MessageHandler, PlatformAdapter } from "../../core/types.js";
import { Logger } from "../../logging.js";
import { parseAllowList } from "./shared/allow-list.js";
import { createDeliveryTarget } from "./shared/delivery-target.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_PATH = "/gateway/bot";
const DISCORD_GATEWAY_QUERY = "v=10&encoding=json";
const DISCORD_GATEWAY_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const DISCORD_READY_TIMEOUT_MS = 10_000;
const DISCORD_RECONNECT_DELAY_MS = 2_000;
const DISCORD_REQUEST_TIMEOUT_MS = 15_000;
const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_REPLY_REACTION = "👀";

interface DiscordSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface DiscordCloseEventLike {
  code?: number;
  reason?: string;
}

interface DiscordGatewayPacket {
  op?: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface DiscordGatewayHello {
  heartbeat_interval?: number;
}

interface DiscordGatewayReady {
  user?: {
    id?: string;
  };
}

interface DiscordGatewayDiscoveryResponse {
  url?: string;
}

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordAttachment {
  filename?: string;
  url?: string;
  content_type?: string | null;
  size?: number;
  description?: string | null;
  width?: number | null;
  height?: number | null;
}

interface DiscordReferencedMessage {
  author?: DiscordUser;
}

interface DiscordGuildMember {
  nick?: string | null;
  user?: DiscordUser;
}

interface DiscordMessageCreate {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
  member?: DiscordGuildMember;
  mentions?: Array<{ id?: string }>;
  attachments?: DiscordAttachment[];
  referenced_message?: DiscordReferencedMessage | null;
  webhook_id?: string;
}

interface DiscordReplyContext {
  channelId: string;
  messageId: string;
}

interface PendingGatewayConnect {
  socket: DiscordSocketLike;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ReplyReactionState {
  count: number;
  added: boolean;
}

export interface DiscordOptions {
  botToken: string;
  allowFrom: string;
  requireMention?: boolean;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function readEventText(event: unknown): string {
  if (!event || typeof event !== "object" || !("data" in event)) {
    return "";
  }

  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") {
    return data;
  }
  if (isArrayBufferLike(data)) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

function closeCode(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || !("code" in event)) {
    return undefined;
  }
  return typeof (event as DiscordCloseEventLike).code === "number" ? (event as DiscordCloseEventLike).code : undefined;
}

function closeReason(event: unknown): string {
  if (!event || typeof event !== "object" || !("reason" in event)) {
    return "";
  }
  return trimString((event as DiscordCloseEventLike).reason);
}

function fatalCloseMessage(code?: number): string | null {
  switch (code) {
    case 4004:
      return "discord gateway authentication failed: invalid bot token";
    case 4013:
      return "discord gateway rejected intents: invalid intents";
    case 4014:
      return "discord gateway rejected intents: enable the MESSAGE CONTENT intent for this bot in Discord Developer Portal";
    default:
      return null;
  }
}

function describeClose(event: unknown): string {
  const code = closeCode(event);
  const reason = closeReason(event);
  const fatal = fatalCloseMessage(code);
  if (fatal) {
    return fatal;
  }

  const parts = ["discord gateway closed"];
  if (typeof code === "number") {
    parts.push(`code=${code}`);
  }
  if (reason) {
    parts.push(`reason=${reason}`);
  }
  return parts.join(" ");
}

function gatewayUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const separator = trimmed.includes("?") ? "&" : "?";
  return `${trimmed}${separator}${DISCORD_GATEWAY_QUERY}`;
}

function displayName(raw: DiscordMessageCreate, userId: string): string {
  const nick = trimString(raw.member?.nick);
  if (nick) {
    return nick;
  }

  const globalName = trimString(raw.author?.global_name);
  if (globalName) {
    return globalName;
  }

  const username = trimString(raw.author?.username);
  if (username) {
    return username;
  }

  return userId;
}

function attachmentLabel(attachment: DiscordAttachment): string {
  const contentType = trimString(attachment.content_type);
  if (contentType.startsWith("image/")) {
    return "Discord image";
  }
  if (contentType.startsWith("video/")) {
    return "Discord video";
  }
  if (contentType.startsWith("audio/")) {
    return "Discord audio";
  }
  return "Discord attachment";
}

function formatAttachment(attachment: DiscordAttachment): string {
  const lines = [`[${attachmentLabel(attachment)}]`];

  const filename = trimString(attachment.filename);
  if (filename) {
    lines.push(`filename: ${filename}`);
  }

  const description = trimString(attachment.description);
  if (description) {
    lines.push(`description: ${description}`);
  }

  const contentType = trimString(attachment.content_type);
  if (contentType) {
    lines.push(`content_type: ${contentType}`);
  }

  if (typeof attachment.size === "number" && Number.isFinite(attachment.size)) {
    lines.push(`size_bytes: ${attachment.size}`);
  }

  if (typeof attachment.width === "number" && typeof attachment.height === "number") {
    lines.push(`dimensions: ${attachment.width}x${attachment.height}`);
  }

  const url = trimString(attachment.url);
  if (url) {
    lines.push(`url: ${url}`);
  }

  return lines.join("\n");
}

function stripBotMentions(content: string, botUserId?: string): string {
  if (!botUserId) {
    return normalizeContent(content);
  }

  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g");
  return normalizeContent(content.replace(mentionPattern, " "));
}

function buildInboundContent(raw: DiscordMessageCreate, botUserId?: string): string {
  const parts: string[] = [];
  const content = trimString(raw.content);
  const text = raw.guild_id ? stripBotMentions(content, botUserId) : normalizeContent(content);

  if (text) {
    parts.push(text);
  }

  for (const attachment of raw.attachments ?? []) {
    parts.push(formatAttachment(attachment));
  }

  return parts.join("\n\n").trim();
}

function splitMessage(content: string): string[] {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const window = remaining.slice(0, DISCORD_MESSAGE_LIMIT + 1);
    const splitAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const index = splitAt >= Math.floor(DISCORD_MESSAGE_LIMIT / 2) ? splitAt : DISCORD_MESSAGE_LIMIT;
    const chunk = remaining.slice(0, index).trimEnd();
    chunks.push(chunk.length > 0 ? chunk : remaining.slice(0, DISCORD_MESSAGE_LIMIT));
    remaining = remaining.slice(index).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function parsePacket(text: string): DiscordGatewayPacket {
  const parsed = JSON.parse(text) as DiscordGatewayPacket;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function asHello(payload: unknown): DiscordGatewayHello {
  return payload && typeof payload === "object" ? payload as DiscordGatewayHello : {};
}

function asReady(payload: unknown): DiscordGatewayReady {
  return payload && typeof payload === "object" ? payload as DiscordGatewayReady : {};
}

function asMessageCreate(payload: unknown): DiscordMessageCreate {
  return payload && typeof payload === "object" ? payload as DiscordMessageCreate : {};
}

function extractSessionKey(channelId: string, userId: string): string {
  return `discord:${channelId}:${userId}`;
}

function replyReactionCacheKey(channelId: string, messageId: string): string {
  return `${channelId}:${messageId}:${DISCORD_REPLY_REACTION}`;
}

function reactionPath(channelId: string, messageId: string): string {
  return `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(DISCORD_REPLY_REACTION)}/@me`;
}

function webSocketCtor(): (new (url: string) => DiscordSocketLike) {
  const ctor = globalThis.WebSocket as unknown as (new (url: string) => DiscordSocketLike) | undefined;
  if (!ctor) {
    throw new Error("global WebSocket is unavailable in this Node.js runtime");
  }
  return ctor;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord";

  private readonly allowList: Set<string> | null;
  private readonly requireMention: boolean;
  private socket?: DiscordSocketLike;
  private handler?: MessageHandler;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private pendingConnect?: PendingGatewayConnect;
  private stopped = false;
  private seq: number | null = null;
  private botUserId?: string;
  private readonly replyReactions = new Map<string, ReplyReactionState>();

  constructor(private readonly options: DiscordOptions, private readonly logger: Logger) {
    this.allowList = parseAllowList(options.allowFrom);
    this.requireMention = options.requireMention ?? true;
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.clearReconnectTimer();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.close(1000, "shutdown");
    }
  }

  async beginResponse(replyCtx: unknown): Promise<void> {
    const { channelId, messageId } = this.getReplyContext(replyCtx);
    const key = replyReactionCacheKey(channelId, messageId);
    const existing = this.replyReactions.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    const state: ReplyReactionState = {
      count: 1,
      added: false,
    };
    this.replyReactions.set(key, state);

    try {
      await this.discordFetch(reactionPath(channelId, messageId), {
        method: "PUT",
      });
      state.added = true;
    } catch (error) {
      this.logger.warn("failed to add discord reply reaction", {
        error: (error as Error).message,
        channelId,
        messageId,
        reaction: DISCORD_REPLY_REACTION,
      });
    }
  }

  async endResponse(replyCtx: unknown): Promise<void> {
    const { channelId, messageId } = this.getReplyContext(replyCtx);
    const key = replyReactionCacheKey(channelId, messageId);
    const state = this.replyReactions.get(key);
    if (!state) {
      return;
    }

    state.count -= 1;
    if (state.count > 0) {
      return;
    }

    this.replyReactions.delete(key);
    if (!state.added) {
      return;
    }

    try {
      await this.discordFetch(reactionPath(channelId, messageId), {
        method: "DELETE",
      });
    } catch (error) {
      this.logger.warn("failed to remove discord reply reaction", {
        error: (error as Error).message,
        channelId,
        messageId,
        reaction: DISCORD_REPLY_REACTION,
      });
    }
  }

  async reply(replyCtx: unknown, content: string): Promise<void> {
    const { channelId, messageId } = this.getReplyContext(replyCtx);
    await this.sendToChannel(channelId, content, messageId);
  }

  async send(target: DeliveryTarget, content: string): Promise<void> {
    const channelId = trimString(target.payload.channelId);
    if (!channelId) {
      this.logger.debug("skip discord proactive send due to incomplete delivery target", {
        hasChannelId: false,
      });
      return;
    }

    await this.sendToChannel(channelId, content);
  }

  private async connect(): Promise<void> {
    const gatewayBase = await this.fetchGatewayUrl();
    const socket = new (webSocketCtor())(gatewayUrl(gatewayBase));
    this.socket = socket;
    this.bindSocket(socket);
    await this.waitForReady(socket);
  }

  private bindSocket(socket: DiscordSocketLike): void {
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(socket, event);
    });
    socket.addEventListener("close", (event) => {
      this.handleSocketClose(socket, event);
    });
    socket.addEventListener("error", () => {
      this.logger.warn("discord gateway emitted socket error");
    });
  }

  private waitForReady(socket: DiscordSocketLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingConnect?.socket !== socket) {
          return;
        }
        this.pendingConnect = undefined;
        socket.close(4000, "ready timeout");
        reject(new Error(`discord gateway did not become ready within ${DISCORD_READY_TIMEOUT_MS}ms`));
      }, DISCORD_READY_TIMEOUT_MS);

      this.pendingConnect = {
        socket,
        timer,
        resolve,
        reject,
      };
    });
  }

  private resolvePendingConnect(socket: DiscordSocketLike): void {
    if (this.pendingConnect?.socket !== socket) {
      return;
    }

    const pending = this.pendingConnect;
    this.pendingConnect = undefined;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectPendingConnect(socket: DiscordSocketLike, error: Error): void {
    if (this.pendingConnect?.socket !== socket) {
      return;
    }

    const pending = this.pendingConnect;
    this.pendingConnect = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async handleSocketMessage(socket: DiscordSocketLike, event: unknown): Promise<void> {
    if (this.socket !== socket) {
      return;
    }

    const text = readEventText(event);
    if (!text) {
      return;
    }

    let packet: DiscordGatewayPacket;
    try {
      packet = parsePacket(text);
    } catch (error) {
      this.rejectPendingConnect(socket, new Error(`discord gateway returned invalid json: ${(error as Error).message}`));
      socket.close(4002, "invalid json");
      return;
    }

    if (typeof packet.s === "number") {
      this.seq = packet.s;
    }

    switch (packet.op) {
      case 0:
        await this.handleDispatch(socket, packet.t, packet.d);
        return;
      case 1:
        this.sendHeartbeat(socket);
        return;
      case 7:
        this.logger.warn("discord gateway requested reconnect");
        socket.close(4000, "gateway requested reconnect");
        return;
      case 9:
        this.logger.warn("discord gateway reported invalid session");
        this.seq = null;
        socket.close(4001, "invalid session");
        return;
      case 10:
        this.handleHello(socket, packet.d);
        return;
      case 11:
        this.logger.debug("discord heartbeat acknowledged");
        return;
      default:
        return;
    }
  }

  private handleHello(socket: DiscordSocketLike, payload: unknown): void {
    const hello = asHello(payload);
    const heartbeatInterval = typeof hello.heartbeat_interval === "number" && hello.heartbeat_interval > 0
      ? hello.heartbeat_interval
      : 30_000;

    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) {
        return;
      }
      this.sendHeartbeat(socket);
    }, heartbeatInterval);

    this.sendGateway(socket, {
      op: 2,
      d: {
        token: this.options.botToken,
        intents: DISCORD_GATEWAY_INTENTS,
        properties: {
          os: process.platform,
          browser: "d-connect",
          device: "d-connect",
        },
      },
    });
  }

  private async handleDispatch(socket: DiscordSocketLike, eventType: string | null | undefined, payload: unknown): Promise<void> {
    if (eventType === "READY") {
      const ready = asReady(payload);
      const botUserId = trimString(ready.user?.id);
      this.botUserId = botUserId || undefined;
      this.logger.info("discord gateway ready", {
        botUserId: this.botUserId,
      });
      this.resolvePendingConnect(socket);
      return;
    }

    if (eventType !== "MESSAGE_CREATE") {
      return;
    }

    const message = this.parseInboundMessage(asMessageCreate(payload));
    if (!message || !this.handler) {
      return;
    }

    try {
      await this.handler(message);
    } catch (error) {
      this.logger.error("discord handler failed", {
        error: (error as Error).message,
        sessionKey: message.sessionKey,
      });
    }
  }

  private parseInboundMessage(raw: DiscordMessageCreate): InboundMessage | null {
    const channelId = trimString(raw.channel_id);
    const messageId = trimString(raw.id);
    const userId = trimString(raw.author?.id ?? raw.member?.user?.id);

    if (!channelId || !messageId || !userId) {
      return null;
    }

    if (raw.author?.bot || trimString(raw.webhook_id)) {
      return null;
    }

    if (this.allowList && !this.allowList.has(userId)) {
      this.logger.warn("blocked discord user", {
        userId,
        channelId,
        guildId: trimString(raw.guild_id),
      });
      return null;
    }

    if (raw.guild_id && this.requireMention && !this.isAddressedToBot(raw)) {
      this.logger.debug("ignore discord guild message without bot mention", {
        userId,
        channelId,
      });
      return null;
    }

    const content = buildInboundContent(raw, this.botUserId);
    if (!content) {
      this.logger.debug("ignore empty discord message", {
        userId,
        channelId,
      });
      return null;
    }

    return {
      platform: this.name,
      sessionKey: extractSessionKey(channelId, userId),
      userId,
      userName: displayName(raw, userId),
      content,
      replyContext: {
        channelId,
        messageId,
      } satisfies DiscordReplyContext,
      deliveryTarget: createDeliveryTarget(this.name, {
        channelId,
        ...(trimString(raw.guild_id) ? { guildId: trimString(raw.guild_id) } : {}),
        userId,
      }),
    };
  }

  private isAddressedToBot(raw: DiscordMessageCreate): boolean {
    if (!this.botUserId) {
      return false;
    }

    const mentioned = (raw.mentions ?? []).some((mention) => trimString(mention.id) === this.botUserId);
    if (mentioned) {
      return true;
    }

    return trimString(raw.referenced_message?.author?.id) === this.botUserId;
  }

  private handleSocketClose(socket: DiscordSocketLike, event: unknown): void {
    if (this.socket === socket) {
      this.socket = undefined;
      this.clearHeartbeat();
    }

    const error = new Error(describeClose(event));
    if (this.pendingConnect?.socket === socket) {
      this.rejectPendingConnect(socket, error);
      return;
    }

    if (this.stopped) {
      return;
    }

    const code = closeCode(event);
    if (fatalCloseMessage(code)) {
      this.logger.error("discord gateway closed with fatal error", {
        code,
        reason: closeReason(event),
      });
      return;
    }

    this.logger.warn("discord gateway disconnected; scheduling reconnect", {
      code,
      reason: closeReason(event),
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().then(() => {
        this.logger.info("discord gateway reconnected");
      }).catch((error: unknown) => {
        this.logger.error("discord reconnect failed", {
          error: (error as Error).message,
        });
        this.scheduleReconnect();
      });
    }, DISCORD_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private sendHeartbeat(socket: DiscordSocketLike): void {
    this.sendGateway(socket, {
      op: 1,
      d: this.seq,
    });
  }

  private sendGateway(socket: DiscordSocketLike, payload: Record<string, unknown>): void {
    if (this.socket !== socket) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn("failed to write discord gateway frame", {
        error: (error as Error).message,
      });
      socket.close(4000, "gateway send failed");
    }
  }

  private async fetchGatewayUrl(): Promise<string> {
    const response = await this.discordFetch(DISCORD_GATEWAY_PATH, {
      method: "GET",
    });
    const payload = await response.json() as DiscordGatewayDiscoveryResponse;
    const url = trimString(payload.url);
    if (!url) {
      throw new Error("discord gateway discovery response missing url");
    }
    return url;
  }

  private getReplyContext(replyCtx: unknown): DiscordReplyContext {
    const ctx = replyCtx as DiscordReplyContext | undefined;
    const channelId = trimString(ctx?.channelId);
    const messageId = trimString(ctx?.messageId);

    if (!channelId || !messageId) {
      throw new Error("missing Discord reply context");
    }

    return {
      channelId,
      messageId,
    };
  }

  private async sendToChannel(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
    const chunks = splitMessage(content);
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        content: chunk,
        allowed_mentions: {
          parse: [],
          replied_user: false,
        },
      };

      if (index === 0 && replyToMessageId) {
        payload.message_reference = {
          message_id: replyToMessageId,
          fail_if_not_exists: false,
        };
      }

      await this.discordFetch(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  }

  private async discordFetch(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${DISCORD_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bot ${this.options.botToken}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if ((error as { name?: string }).name === "TimeoutError") {
        throw new Error(`discord request timed out after ${DISCORD_REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`discord api request failed: ${response.status} ${body}`);
    }

    return response;
  }
}
