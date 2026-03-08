import type { LoopJob, DeliveryTarget, InboundMessage, JobExecutor, TurnResult } from "../core/types.js";
import type { ResolvedAppConfig } from "../config/normalize.js";
import type { SessionRecord } from "./session-repository.js";
import { Logger } from "../infra/logging/logger.js";
import { MessageRelay } from "./message-relay.js";
import { ProjectRegistry, type ProjectRuntime } from "./project-registry.js";
import { ConversationService } from "./conversation-service.js";
import { CommandService } from "./command-service.js";
import { GuardService, buildGuardBlockedMessage } from "./guard-service.js";
import { createSessionStore } from "../infra/store-json/session-store.js";
import { LoopScheduler } from "../scheduler/loop.js";
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

interface CommandDispatchResult {
  commandResponse: boolean;
  result: TurnResult;
}

export class DaemonRuntime implements JobExecutor {
  private readonly registry: ProjectRegistry;
  private readonly relay = new MessageRelay();
  private readonly conversations: ConversationService;
  private readonly commandService: CommandService;
  private readonly guardService: GuardService;
  private readonly sessions: SessionRepository;
  private started = false;

  private constructor(
    private readonly config: ResolvedAppConfig,
    private readonly logger: Logger,
    sessions: SessionRepository,
    private readonly loopScheduler?: LoopScheduler,
  ) {
    this.sessions = sessions;
    this.registry = new ProjectRegistry(config, logger.child("runtime"));
    this.conversations = new ConversationService(sessions, logger.child("conversation"));
    this.commandService = new CommandService(this.conversations, loopScheduler);
    this.guardService = new GuardService(logger.child("guard"));
  }

  static async create(config: ResolvedAppConfig, logger: Logger, loopScheduler?: LoopScheduler): Promise<DaemonRuntime> {
    const sessions = await createSessionStore(config.dataDir);
    return new DaemonRuntime(config, logger, sessions, loopScheduler);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.registry.start((project, platform, message) => this.handlePlatformMessage(project, platform.name, message));

    if (this.loopScheduler) {
      for (const project of this.config.projects) {
        this.loopScheduler.registerExecutor(project.name, this);
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
  ): Promise<CommandDispatchResult> {
    if (input.content.trim().startsWith("/")) {
      const commandResult = await this.commandService.handle({
        runtime,
        project: input.project,
        sessionKey: input.sessionKey,
        session,
        raw: input.content,
      });

      if (commandResult.kind === "handled") {
        return {
          commandResponse: true,
          result: {
            response: commandResult.response,
            events: [],
          },
        };
      }

      return {
        commandResponse: false,
        result: await this.conversations.runTurn(runtime, input.project, input.sessionKey, session, commandResult.prompt, {
          onMessage:
            options.replyContext && options.replyPlatformName
              ? async (message: string): Promise<void> => {
                  const platform = this.registry.get(input.project).platformMap.get(options.replyPlatformName ?? "");
                  if (!platform) {
                    return;
                  }
                  await platform.reply(options.replyContext, message);
                }
              : undefined,
        }),
      };
    }

    const replyPlatformName = options.replyPlatformName;
    const replyContext = options.replyContext;
    return {
      commandResponse: false,
      result: await this.conversations.runTurn(runtime, input.project, input.sessionKey, session, input.content, {
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
      }),
    };
  }

  private async dispatch(input: RuntimeSendInput, options: DispatchOptions = {}): Promise<RuntimeSendResult> {
    const runtime = this.getProjectRuntime(input.project);
    const session = this.conversations.getOrCreateActiveSession(input.project, input.sessionKey);

    if (options.deliveryTarget) {
      this.conversations.rememberDeliveryTarget(input.project, input.sessionKey, options.deliveryTarget);
      await this.conversations.save();
    }

    const dispatched = await this.runCommandOrConversation(runtime, input, session, options);
    const result = dispatched.result;

    if (options.replyContext && options.replyPlatformName && dispatched.commandResponse && result.response.trim().length > 0) {
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
    const runtime = this.getProjectRuntime(project);
    const platform = runtime.platformMap.get(platformName);
    if (!platform) {
      throw new Error(`platform not found for project ${project}: ${platformName}`);
    }

    if (runtime.config.guard?.enabled === true) {
      const decision = await this.guardService.evaluate(runtime, {
        project,
        sessionKey: message.sessionKey,
        userId: message.userId,
        userName: message.userName,
        content: message.content,
      });

      if (decision.action === "block") {
        const response = buildGuardBlockedMessage(decision.reason);
        this.logger.warn("platform message blocked by guard", {
          project,
          platform: platformName,
          sessionKey: message.sessionKey,
          userId: message.userId,
          reason: decision.reason,
          content: message.content,
        });
        await this.relay.reply(platform, message.replyContext, response);
        return;
      }
    }

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

  async executeJob(job: LoopJob): Promise<void> {
    const result = await this.dispatch({
      project: job.project,
      sessionKey: job.sessionKey,
      content: job.prompt,
      userId: "loop",
      userName: "loop",
    });

    if (!job.silent && result.response.trim().length > 0) {
      await this.sendAsync(job.project, job.sessionKey, result.response, result.events);
    }
  }

  async executeLoopJob(job: LoopJob): Promise<void> {
    await this.executeJob(job);
  }
}
