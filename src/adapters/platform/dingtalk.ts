import {
  DWClient,
  EventAck,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage,
} from "dingtalk-stream";
import type { MessageHandler, PlatformAdapter, PlatformMessage } from "../../runtime/types.js";
import { Logger } from "../../logging.js";

export interface DingTalkOptions {
  clientId: string;
  clientSecret: string;
  allowFrom?: string;
}

export interface DingTalkReplyContext {
  messageId: string;
  conversationId: string;
  senderId: string;
  sessionWebhook?: string;
}

function parseAllowFrom(value?: string): Set<string> | null {
  if (!value || value.trim() === "*") {
    return null;
  }
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return new Set(parts);
}

function normalizeUserId(msg: RobotMessage): string {
  return msg.senderStaffId || msg.senderId || msg.chatbotUserId;
}

function extractSessionKey(msg: RobotMessage): string {
  const userId = normalizeUserId(msg);
  return `${msg.conversationId}:${userId}`;
}

export class DingTalkAdapter implements PlatformAdapter {
  readonly name = "dingtalk";

  private client?: DWClient;
  private handler?: MessageHandler;
  private readonly allowList: Set<string> | null;

  constructor(private readonly options: DingTalkOptions, private readonly logger: Logger) {
    this.allowList = parseAllowFrom(options.allowFrom);
  }

  private isAllowed(userId: string): boolean {
    if (!this.allowList) {
      return true;
    }
    return this.allowList.has(userId);
  }

  private onDownstream = (downstream: DWClientDownStream): { status: EventAck; message?: string } => {
    try {
      if (downstream.headers.topic !== TOPIC_ROBOT) {
        return { status: EventAck.SUCCESS };
      }

      const raw = JSON.parse(downstream.data) as RobotMessage;
      const userId = normalizeUserId(raw);

      if (!this.isAllowed(userId)) {
        this.logger.warn("blocked dingtalk user", { userId });
        return { status: EventAck.SUCCESS };
      }

      if (raw.msgtype !== "text") {
        this.logger.warn("unsupported dingtalk message type", { msgtype: raw.msgtype, userId });
        return { status: EventAck.SUCCESS };
      }

      const message: PlatformMessage = {
        platform: this.name,
        sessionKey: extractSessionKey(raw),
        userId,
        userName: raw.senderNick,
        content: raw.text.content,
        replyCtx: {
          messageId: downstream.headers.messageId,
          conversationId: raw.conversationId,
          senderId: userId,
          sessionWebhook: raw.sessionWebhook,
        } satisfies DingTalkReplyContext,
      };

      if (this.handler) {
        void Promise.resolve(this.handler(message)).catch((error) => {
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

    this.client.registerAllEventListener(this.onDownstream);
    await this.client.connect();
    this.logger.info("dingtalk stream connected");
  }

  private async sendViaWebhook(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as DingTalkReplyContext;
    if (!ctx?.sessionWebhook) {
      throw new Error("missing sessionWebhook in reply context");
    }

    const res = await fetch(ctx.sessionWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "text",
        text: {
          content,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`dingtalk webhook failed: ${res.status} ${body}`);
    }
  }

  async reply(replyCtx: unknown, content: string): Promise<void> {
    await this.sendViaWebhook(replyCtx, content);
  }

  async send(replyCtx: unknown, content: string): Promise<void> {
    await this.sendViaWebhook(replyCtx, content);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = undefined;
    }
  }
}
