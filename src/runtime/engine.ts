import type { AppConfig, ProjectConfig } from "../config/schema.js";
import { Logger } from "../logging.js";
import { createAgentAdapter } from "../adapters/agent/index.js";
import { createPlatformAdapters } from "../adapters/platform/index.js";
import { createSessionStore, type SessionRecord, type SessionStore } from "./session-store.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  CronExecutor,
  CronJob,
  ModeSwitchable,
  PlatformAdapter,
  PlatformMessage,
} from "./types.js";
import { CronScheduler } from "../scheduler/cron.js";

interface ProjectRuntime {
  config: ProjectConfig;
  agent: AgentAdapter;
  platforms: PlatformAdapter[];
  sessions: Map<string, AgentSession>;
}

interface ReplyTarget {
  platform: PlatformAdapter;
  replyCtx: unknown;
}

export interface RuntimeSendInput {
  project: string;
  sessionKey: string;
  content: string;
  userId?: string;
  userName?: string;
}

export interface RuntimeSendResult {
  project: string;
  sessionKey: string;
  response: string;
  sessionId: string;
  events: AgentEvent[];
}

function hasModeControl(agent: AgentAdapter): agent is AgentAdapter & ModeSwitchable {
  const candidate = agent as Partial<ModeSwitchable>;
  return (
    typeof candidate.setMode === "function" &&
    typeof candidate.getMode === "function" &&
    typeof candidate.supportedModes === "function"
  );
}

interface PendingToolUse {
  toolName: string;
  requestId?: string;
  toolInput?: string;
}

interface EventRenderState {
  toolNames: Map<string, string>;
}

interface EventRenderOptions {
  includeText: boolean;
  includeErrors: boolean;
}

const MAX_TOOL_INPUT_LENGTH = 180;
const TOOL_CALL_EMOJI = "🛠️";

function normalizeInlineText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function normalizeToolInput(toolInput?: string): string {
  if (!toolInput) {
    return "";
  }
  return normalizeInlineText(toolInput, MAX_TOOL_INPUT_LENGTH);
}

function createEventRenderState(): EventRenderState {
  return {
    toolNames: new Map<string, string>(),
  };
}

function toolTag(toolName: string, requestId?: string): string {
  if (!requestId) {
    return `\`${toolName}\``;
  }
  return `\`${toolName}\` (id: ${requestId})`;
}

function renderToolRunning(use: PendingToolUse): string {
  const inputPart = use.toolInput ? `，输入: ${use.toolInput}` : "";
  return `${TOOL_CALL_EMOJI} 调用工具 ${toolTag(use.toolName, use.requestId)}${inputPart}`;
}

function flushPendingToolUseMessages(state: EventRenderState): string[] {
  return [];
}

function renderToolUseEvent(event: AgentEvent, state: EventRenderState): string[] {
  const toolName = event.toolName?.trim() || "unknown";
  const toolInput = normalizeToolInput(event.toolInput);
  const requestId = event.requestId?.trim();
  if (requestId) {
    state.toolNames.set(requestId, toolName);
  }

  return [
    renderToolRunning({
      toolName,
      requestId,
      toolInput: toolInput || undefined,
    }),
  ];
}

function renderToolResultEvent(event: AgentEvent, state: EventRenderState): string[] {
  return [];
}

function renderEventToMessages(event: AgentEvent, state: EventRenderState, options: EventRenderOptions): string[] {
  if (event.type === "tool_use") {
    return renderToolUseEvent(event, state);
  }

  if (event.type === "tool_result") {
    return renderToolResultEvent(event, state);
  }

  const messages = flushPendingToolUseMessages(state);

  if (event.type === "text" && options.includeText) {
    const content = event.content?.trim();
    if (content) {
      messages.push(content);
    }
    return messages;
  }

  if (event.type === "error" && options.includeErrors) {
    const content = event.content?.trim();
    if (content) {
      messages.push(`agent error: ${content}`);
    }
    return messages;
  }

  return messages;
}

function buildMessagesFromEvents(events: AgentEvent[], options: EventRenderOptions): string[] {
  const state = createEventRenderState();
  const messages: string[] = [];
  for (const event of events) {
    messages.push(...renderEventToMessages(event, state, options));
  }
  messages.push(...flushPendingToolUseMessages(state));
  return messages;
}

export function summarizeToolMessages(events: AgentEvent[]): string[] {
  return buildMessagesFromEvents(events, { includeText: false, includeErrors: false });
}

export function splitResponseMessages(response: string, events: AgentEvent[]): string[] {
  const messages = buildEventMessages(events);
  return messages.concat(buildSuffixMessage(response, events, messages));
}

function buildEventMessages(events: AgentEvent[]): string[] {
  return buildMessagesFromEvents(events, { includeText: true, includeErrors: true });
}

function buildSuffixMessage(response: string, events: AgentEvent[], messages: string[]): string[] {
  const body = response.trim() || "done";
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === "text") {
      const content = event.content?.trim();
      if (content) {
        textParts.push(content);
      }
    }
  }

  if (messages.length === 0) {
    return [body];
  }

  const lastMessage = messages.at(-1)?.trim();
  if (lastMessage && lastMessage === body) {
    return [];
  }

  const renderedBody = messages.join("\n\n");
  if (renderedBody === body || body === "done") {
    return [];
  }

  const textBody = textParts.join("\n\n");
  const lastText = textParts.at(-1);
  if (lastText && lastText === body) {
    return [];
  }
  if (!textBody) {
    return [body];
  }

  if (body === textBody) {
    return [];
  }

  if (body.startsWith(textBody)) {
    const suffix = body.slice(textBody.length).trim();
    if (suffix.length > 0) {
      return [suffix];
    }
    return [];
  }

  return [body];
}

function previewLogText(value: string | undefined, max = 320): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeAgentEventForLog(event: AgentEvent): Record<string, unknown> {
  return {
    type: event.type,
    sessionId: event.sessionId,
    requestId: event.requestId,
    toolName: event.toolName,
    toolInput: previewLogText(event.toolInput),
    content: previewLogText(event.content),
    done: event.done === true,
  };
}

export function formatResponseFromEvents(response: string, events: AgentEvent[]): string {
  return splitResponseMessages(response, events).join("\n\n");
}

export class RuntimeEngine implements CronExecutor {
  private readonly projects = new Map<string, ProjectRuntime>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private sessionStore!: SessionStore;
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly cronScheduler?: CronScheduler,
  ) {}

  private key(project: string, sessionKey: string): string {
    return `${project}:${sessionKey}`;
  }

  private getProjectRuntime(project: string): ProjectRuntime {
    const runtime = this.projects.get(project);
    if (!runtime) {
      throw new Error(`project not found: ${project}`);
    }
    return runtime;
  }

  private async startProject(project: ProjectConfig): Promise<void> {
    const projectLogger = this.logger.child(`project:${project.name}`);
    const agent = createAgentAdapter(project, projectLogger.child("agent"));
    const platforms = createPlatformAdapters(project, projectLogger);

    const runtime: ProjectRuntime = {
      config: project,
      agent,
      platforms,
      sessions: new Map<string, AgentSession>(),
    };

    this.projects.set(project.name, runtime);

    for (const platform of platforms) {
      await platform.start((message: PlatformMessage) => this.handlePlatformMessage(project.name, platform, message));
    }

    if (this.cronScheduler) {
      this.cronScheduler.registerExecutor(project.name, this);
    }

    projectLogger.info("project started", {
      agent: project.agent.type,
      platforms: project.platforms.map((p) => p.type).join(","),
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.sessionStore = await createSessionStore(this.config.dataDir!);

    for (const project of this.config.projects) {
      await this.startProject(project);
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    for (const runtime of this.projects.values()) {
      for (const platform of runtime.platforms) {
        await platform.stop();
      }

      for (const session of runtime.sessions.values()) {
        await session.close();
      }

      runtime.sessions.clear();
      await runtime.agent.stop();
    }

    this.projects.clear();
    if (this.sessionStore) {
      await this.sessionStore.save();
    }
    this.started = false;
  }

  private async ensureAgentSession(runtime: ProjectRuntime, session: SessionRecord): Promise<AgentSession> {
    let found = runtime.sessions.get(session.id);
    if (found && found.isAlive()) {
      return found;
    }

    found = await runtime.agent.startSession(session.agentSessionId || undefined);
    runtime.sessions.set(session.id, found);
    return found;
  }

  private async runAgent(
    runtime: ProjectRuntime,
    session: SessionRecord,
    prompt: string,
    options?: { onMessage?: (message: string) => Promise<void> },
  ): Promise<{ response: string; events: AgentEvent[] }> {
    if (!this.sessionStore.tryLock(session)) {
      return {
        response: "session is busy, please retry in a few seconds",
        events: [],
      };
    }

    const events: AgentEvent[] = [];
    const onMessage = options?.onMessage;
    const streaming = typeof onMessage === "function";
    const renderState = createEventRenderState();
    let queuedMessages = Promise.resolve();
    let emittedMessages = 0;

    this.logger.debug("runtime agent run start", {
      project: runtime.config.name,
      sessionId: session.id,
      agentSessionId: session.agentSessionId,
      streaming,
      prompt: previewLogText(prompt, 1000),
    });

    const enqueueMessage = (message: string): void => {
      const content = message.trim();
      if (!content) {
        return;
      }
      this.logger.debug("runtime streaming message", {
        project: runtime.config.name,
        sessionId: session.id,
        index: emittedMessages + 1,
        content: previewLogText(content, 1000),
      });
      if (streaming && onMessage) {
        queuedMessages = queuedMessages.then(() => onMessage(content));
        emittedMessages += 1;
      }
    };

    try {
      const agentSession = await this.ensureAgentSession(runtime, session);

      const onEvent = (event: AgentEvent): void => {
        events.push(event);
        this.logger.debug("runtime agent event", {
          project: runtime.config.name,
          sessionId: session.id,
          ...summarizeAgentEventForLog(event),
        });
        if (event.sessionId && event.sessionId.length > 0) {
          this.sessionStore.setAgentSessionId(session, event.sessionId);
        }
        for (const message of renderEventToMessages(event, renderState, { includeText: true, includeErrors: true })) {
          enqueueMessage(message);
        }
      };

      agentSession.on("event", onEvent);

      this.sessionStore.addHistory(session, "user", prompt);
      await this.sessionStore.save();

      try {
        await agentSession.send(prompt);
      } finally {
        agentSession.off("event", onEvent);
      }

      for (const message of flushPendingToolUseMessages(renderState)) {
        enqueueMessage(message);
      }

      this.sessionStore.setAgentSessionId(session, agentSession.currentSessionId());

      const resultEvents = events.filter((event) => event.type === "result" && event.content && event.content.trim().length > 0);
      const textEvents = events.filter((event) => event.type === "text" && event.content && event.content.trim().length > 0);
      const errorEvents = events.filter((event) => event.type === "error" && event.content && event.content.trim().length > 0);

      const resultText = resultEvents.at(-1)?.content?.trim() ?? "";
      const text = textEvents.length > 0 ? textEvents.map((event) => event.content?.trim()).join("\n").trim() : "";
      const errorText = errorEvents.length > 0 ? `agent error: ${errorEvents.at(-1)?.content}` : "";
      const response = formatResponseFromEvents(resultText || text || errorText || "done", events);
      this.logger.info("runtime agent run completed", {
        project: runtime.config.name,
        sessionId: session.id,
        agentSessionId: agentSession.currentSessionId(),
        eventCount: events.length,
        textEvents: textEvents.length,
        resultEvents: resultEvents.length,
        errorEvents: errorEvents.length,
        response: previewLogText(response, 2000),
      });
      if (streaming) {
        const finalMessages = splitResponseMessages(resultText || text || errorText || "done", events);
        for (let i = emittedMessages; i < finalMessages.length; i += 1) {
          const message = finalMessages[i];
          enqueueMessage(message);
        }
      }

      await queuedMessages;

      this.sessionStore.addHistory(session, "assistant", response);
      await this.sessionStore.save();

      return {
        response,
        events,
      };
    } catch (error) {
      const message = formatResponseFromEvents(`agent execution failed: ${(error as Error).message}`, events);
      this.logger.error("runtime agent run failed", {
        project: runtime.config.name,
        sessionId: session.id,
        error: (error as Error).message,
        eventCount: events.length,
        response: previewLogText(message, 2000),
      });
      if (streaming) {
        const finalMessages = splitResponseMessages(message, events);
        for (let i = emittedMessages; i < finalMessages.length; i += 1) {
          enqueueMessage(finalMessages[i]);
        }
        await queuedMessages;
      }
      this.sessionStore.addHistory(session, "assistant", message);
      await this.sessionStore.save();
      return {
        response: message,
        events,
      };
    } finally {
      this.sessionStore.unlock(session);
      await this.sessionStore.save();
    }
  }

  private async handleCommand(
    runtime: ProjectRuntime,
    project: string,
    sessionKey: string,
    userKey: string,
    session: SessionRecord,
    raw: string,
  ): Promise<string> {
    const parts = raw.trim().slice(1).split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();

    switch (command) {
      case "help":
        return [
          "commands:",
          "/help",
          "/new [name]",
          "/list",
          "/switch <id|name>",
          "/mode [name]",
          "/cron list",
          "/cron add <expr> <prompt>",
          "/cron del <id>",
        ].join("\n");

      case "new": {
        const name = parts.slice(1).join(" ").trim() || `session-${Date.now()}`;
        const created = this.sessionStore.newSession(userKey, name);
        await this.sessionStore.save();
        return `created session ${created.id} (${created.name})`;
      }

      case "list": {
        const active = this.sessionStore.getOrCreateActive(userKey);
        const list = this.sessionStore.listSessions(userKey);
        if (list.length === 0) {
          return "no sessions";
        }
        return list
          .map((item) => `${item.id === active.id ? "*" : " "} ${item.id}\t${item.name}\t${item.updatedAt}`)
          .join("\n");
      }

      case "switch": {
        const target = parts[1];
        if (!target) {
          return "usage: /switch <id|name>";
        }
        const found = this.sessionStore.switchSession(userKey, target);
        if (!found) {
          return `session not found: ${target}`;
        }
        await this.sessionStore.save();
        return `active session: ${found.id} (${found.name})`;
      }

      case "mode": {
        if (!hasModeControl(runtime.agent)) {
          return "this agent does not support mode switching";
        }
        const nextMode = parts[1];
        if (!nextMode) {
          return `mode=${runtime.agent.getMode()} supported=${runtime.agent.supportedModes().join(",")}`;
        }
        runtime.agent.setMode(nextMode);
        return `mode updated: ${runtime.agent.getMode()}`;
      }

      case "cron": {
        if (!this.cronScheduler) {
          return "cron scheduler is not enabled";
        }

        const sub = (parts[1] ?? "").toLowerCase();
        if (!sub || sub === "help") {
          return "usage: /cron list | /cron add <expr> <prompt> | /cron del <id>";
        }

        if (sub === "list") {
          const jobs = this.cronScheduler
            .list(project)
            .filter((job) => job.sessionKey === sessionKey)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          if (jobs.length === 0) {
            return "no cron jobs";
          }
          return jobs
            .map((job) => `${job.id}\t${job.cronExpr}\t${job.prompt}\tlastRun=${job.lastRun ?? "-"}`)
            .join("\n");
        }

        if (sub === "add") {
          if (parts.length < 4) {
            return "usage: /cron add <expr> <prompt>";
          }
          const cronExpr = parts[2];
          const prompt = raw.trim().split(/\s+/).slice(3).join(" ").trim();
          const job = await this.cronScheduler.addJob({
            project,
            sessionKey,
            cronExpr,
            prompt,
            description: `chat:${session.id}`,
            silent: false,
          });
          return `cron created: ${job.id}`;
        }

        if (sub === "del") {
          const id = parts[2];
          if (!id) {
            return "usage: /cron del <id>";
          }
          const removed = await this.cronScheduler.removeJob(id);
          return removed ? `cron removed: ${id}` : `cron not found: ${id}`;
        }

        return `unknown /cron command: ${sub}`;
      }

      default:
        return `unknown command: ${command}. use /help`;
    }
  }

  private async dispatch(
    runtime: ProjectRuntime,
    input: RuntimeSendInput,
    replyTarget?: ReplyTarget,
  ): Promise<RuntimeSendResult> {
    const userKey = this.key(input.project, input.sessionKey);
    const session = this.sessionStore.getOrCreateActive(userKey);

    if (replyTarget) {
      this.replyTargets.set(userKey, replyTarget);
    }

    let response = "";
    let events: AgentEvent[] = [];
    const isCommand = input.content.trim().startsWith("/");

    if (isCommand) {
      response = await this.handleCommand(runtime, input.project, input.sessionKey, userKey, session, input.content);
    } else {
      const output = await this.runAgent(runtime, session, input.content, {
        onMessage: replyTarget
          ? async (message: string): Promise<void> => {
              await replyTarget.platform.reply(replyTarget.replyCtx, message);
            }
          : undefined,
      });
      response = output.response;
      events = output.events;
    }

    if (replyTarget && isCommand && response.trim().length > 0) {
      for (const reply of splitResponseMessages(response, events)) {
        if (reply.trim().length === 0) {
          continue;
        }
        await replyTarget.platform.reply(replyTarget.replyCtx, reply);
      }
    }

    return {
      project: input.project,
      sessionKey: input.sessionKey,
      response,
      sessionId: session.id,
      events,
    };
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    const runtime = this.getProjectRuntime(input.project);
    return this.dispatch(runtime, input);
  }

  private async replyIfPossible(project: string, sessionKey: string, content: string, events: AgentEvent[] = []): Promise<void> {
    const target = this.replyTargets.get(this.key(project, sessionKey));
    if (!target) {
      return;
    }
    for (const message of splitResponseMessages(content, events)) {
      if (message.trim().length === 0) {
        continue;
      }
      await target.platform.reply(target.replyCtx, message);
    }
  }

  private async handlePlatformMessage(project: string, platform: PlatformAdapter, message: PlatformMessage): Promise<void> {
    const runtime = this.getProjectRuntime(project);

    await this.dispatch(
      runtime,
      {
        project,
        sessionKey: message.sessionKey,
        content: message.content,
        userId: message.userId,
        userName: message.userName,
      },
      {
        platform,
        replyCtx: message.replyCtx,
      },
    );
  }

  async executeCronJob(job: CronJob): Promise<void> {
    const runtime = this.getProjectRuntime(job.project);
    const result = await this.dispatch(runtime, {
      project: job.project,
      sessionKey: job.sessionKey,
      content: job.prompt,
      userId: "cron",
      userName: "cron",
    });

    if (!job.silent && result.response.trim().length > 0) {
      await this.replyIfPossible(job.project, job.sessionKey, result.response, result.events);
    }
  }
}
