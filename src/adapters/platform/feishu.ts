import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type EventHandles,
} from "@larksuiteoapi/node-sdk";
import type { DeliveryTarget, InboundMessage, MessageHandler, PlatformAdapter } from "../../core/types.js";
import { Logger } from "../../logging.js";
import { parseAllowList } from "./shared/allow-list.js";
import { createDeliveryTarget } from "./shared/delivery-target.js";
import {
  asTextContent,
  getSenderId,
  isBotMentioned,
  isFeishuOk,
  isOldMessage,
  parsePostTextContent,
  type FeishuReceiveEvent,
  type FeishuReplyContext,
} from "./feishu-message.js";
import {
  buildReplyContent,
  hasComplexMarkdown,
  preprocessFeishuMarkdown,
} from "./feishu-content.js";

const MESSAGE_DEDUP_TTL_MS = 60_000;

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  allowFrom?: string;
  groupReplyAll?: boolean;
  reactionEmoji?: string;
}

function normalizeReactionEmoji(value?: string): string {
  if (value === "none") {
    return "";
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : "OnIt";
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
    this.allowList = parseAllowList(options.allowFrom);
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

  private buildInboundMessage(event: FeishuReceiveEvent): InboundMessage | null {
    const msg = event.message ?? event.event?.message;
    if (!msg) {
      this.logger.debug("feishu event without message");
      return null;
    }

    const messageId = msg.message_id ?? "";
    const chatId = msg.chat_id ?? "";
    const userId = getSenderId(event);

    if (!messageId || !chatId || !userId) {
      return null;
    }

    if (isOldMessage(msg.create_time, this.startedAt)) {
      this.logger.debug("ignore old feishu message after startup", {
        messageId,
        createTime: msg.create_time,
      });
      return null;
    }

    if (!this.rememberMessageId(messageId)) {
      this.logger.debug("ignore duplicated feishu message", { messageId });
      return null;
    }

    if (!this.isAllowed(userId)) {
      this.logger.warn("blocked feishu user", { userId });
      return null;
    }

    if (msg.chat_type === "group" && !this.options.groupReplyAll && this.botOpenId) {
      if (!isBotMentioned(msg.mentions, this.botOpenId)) {
        this.logger.debug("ignore group message without bot mention", {
          chatId,
          messageId,
        });
        return null;
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
        return null;
    }

    if (!text) {
      this.logger.debug("feishu content is empty after parsing", {
        messageId,
        messageType: msg.message_type,
      });
      return null;
    }

    return {
      platform: this.name,
      sessionKey: `feishu:${chatId}:${userId}`,
      userId,
      userName: userId,
      content: text,
      replyContext: {
        messageId,
        chatId,
      } satisfies FeishuReplyContext,
      deliveryTarget: createDeliveryTarget(this.name, { chatId }),
    };
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

          const message = this.buildInboundMessage(event);
          if (!message || !this.handler) {
            return;
          }

          const replyContext = message.replyContext as FeishuReplyContext;
          const reactionId = await this.addReaction(replyContext.messageId);
          try {
            await this.handler(message);
          } finally {
            if (reactionId) {
              void this.removeReaction(replyContext.messageId, reactionId);
            }
          }
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

  async send(target: DeliveryTarget, content: string): Promise<void> {
    const chatId = typeof target.payload.chatId === "string" ? target.payload.chatId : "";
    if (!chatId) {
      throw new Error("feishu reply context missing chatId");
    }

    const payload = buildReplyContent(content);
    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
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

export {
  asTextContent,
  buildReplyContent,
  hasComplexMarkdown,
  parsePostTextContent,
  preprocessFeishuMarkdown,
};
export type { FeishuReplyContext } from "./feishu-message.js";
