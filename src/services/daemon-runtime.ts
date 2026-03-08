import type { CronJob, DeliveryTarget, InboundMessage, JobExecutor, TurnResult } from "../core/types.js";
import type { ResolvedAppConfig } from "../config/normalize.js";
import type { SessionRecord } from "./session-repository.js";
import { Logger } from "../infra/logging/logger.js";
import { MessageRelay } from "./message-relay.js";
import { ProjectRegistry, type ProjectRuntime } from "./project-registry.js";
import { ConversationService } from "./conversation-service.js";
import { CommandService } from "./command-service.js";
import { createSessionStore } from "../infra/store-json/session-store.js";
import { CronScheduler } from "../scheduler/cron.js";
import type { AgentEvent } from "../core/types.js";
import type { SessionRepository } from "./session-repository.js";

export interface RuntimeSendInput {
  project: string;
  sessionKey: string;
  content: string;
  userId?: string;
  userName?: string;
}

export interface RuntimeSendResult extends TurnResult {
  project: string;
  sessionKey: string;
  sessionId: string;
}

interface DispatchOptions {
  replyContext?: unknown;
  deliveryTarget?: DeliveryTarget;
  replyPlatformName?: string;
}

export class DaemonRuntime implements JobExecutor {
  private readonly registry: ProjectRegistry;
  private readonly relay = new MessageRelay();
  private readonly conversations: ConversationService;
  private readonly commandService: CommandService;
  private readonly sessions: SessionRepository;
  private started = false;

  private constructor(
    private readonly config: ResolvedAppConfig,
    private readonly logger: Logger,
    sessions: SessionRepository,
    private readonly cronScheduler?: CronScheduler,
  ) {
    this.sessions = sessions;
    this.registry = new ProjectRegistry(config, logger.child("runtime"));
    this.conversations = new ConversationService(sessions, logger.child("conversation"));
    this.commandService = new CommandService(this.conversations, cronScheduler);
  }

  static async create(config: ResolvedAppConfig, logger: Logger, cronScheduler?: CronScheduler): Promise<DaemonRuntime> {
    const sessions = await createSessionStore(config.dataDir);
    return new DaemonRuntime(config, logger, sessions, cronScheduler);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.registry.start((project, platform, message) => this.handlePlatformMessage(project, platform.name, message));

    if (this.cronScheduler) {
      for (const project of this.config.projects) {
        this.cronScheduler.registerExecutor(project.name, this);
      }
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    await this.registry.stop();
    await this.sessions.save();
    this.started = false;
  }

  private getProjectRuntime(project: string): ProjectRuntime {
    return this.registry.get(project);
  }

  private async runCommandOrConversation(
    runtime: ProjectRuntime,
    input: RuntimeSendInput,
    session: SessionRecord,
    options: DispatchOptions,
  ): Promise<TurnResult> {
    if (input.content.trim().startsWith("/")) {
      return {
        response: await this.commandService.handle({
          runtime,
          project: input.project,
          sessionKey: input.sessionKey,
          session,
          raw: input.content,
        }),
        events: [],
      };
    }

    const replyPlatformName = options.replyPlatformName;
    const replyContext = options.replyContext;
    return this.conversations.runTurn(runtime, input.project, input.sessionKey, session, input.content, {
      onMessage:
        replyContext && replyPlatformName
          ? async (message: string): Promise<void> => {
              const platform = this.registry.get(input.project).platformMap.get(replyPlatformName);
              if (!platform) {
                return;
              }
              await platform.reply(replyContext, message);
            }
          : undefined,
    });
  }

  private async dispatch(input: RuntimeSendInput, options: DispatchOptions = {}): Promise<RuntimeSendResult> {
    const runtime = this.getProjectRuntime(input.project);
    const session = this.conversations.getOrCreateActiveSession(input.project, input.sessionKey);

    if (options.deliveryTarget) {
      this.conversations.rememberDeliveryTarget(input.project, input.sessionKey, options.deliveryTarget);
      await this.conversations.save();
    }

    const result = await this.runCommandOrConversation(runtime, input, session, options);

    if (options.replyContext && options.replyPlatformName && input.content.trim().startsWith("/") && result.response.trim().length > 0) {
      const platform = runtime.platformMap.get(options.replyPlatformName);
      if (platform) {
        await this.relay.reply(platform, options.replyContext, result.response, result.events);
      }
    }

    return {
      project: input.project,
      sessionKey: input.sessionKey,
      sessionId: session.id,
      response: result.response,
      events: result.events,
    };
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    return this.dispatch(input);
  }

  private async sendAsync(project: string, sessionKey: string, response: string, events: AgentEvent[] = []): Promise<void> {
    const runtime = this.getProjectRuntime(project);
    const deliveryTarget = this.conversations.findDeliveryTarget(project, sessionKey);
    if (!deliveryTarget) {
      return;
    }

    const platform = runtime.platformMap.get(deliveryTarget.platform);
    if (!platform) {
      this.logger.warn("delivery target platform unavailable", {
        project,
        sessionKey,
        platform: deliveryTarget.platform,
      });
      return;
    }

    await this.relay.send(platform, deliveryTarget, response, events);
  }

  private async handlePlatformMessage(project: string, platformName: string, message: InboundMessage): Promise<void> {
    await this.dispatch(
      {
        project,
        sessionKey: message.sessionKey,
        content: message.content,
        userId: message.userId,
        userName: message.userName,
      },
      {
        replyPlatformName: platformName,
        replyContext: message.replyContext,
        deliveryTarget: message.deliveryTarget,
      },
    );
  }

  async executeJob(job: CronJob): Promise<void> {
    const result = await this.dispatch({
      project: job.project,
      sessionKey: job.sessionKey,
      content: job.prompt,
      userId: "cron",
      userName: "cron",
    });

    if (!job.silent && result.response.trim().length > 0) {
      await this.sendAsync(job.project, job.sessionKey, result.response, result.events);
    }
  }

  async executeCronJob(job: CronJob): Promise<void> {
    await this.executeJob(job);
  }
}
