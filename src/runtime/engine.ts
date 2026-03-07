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

export function summarizeToolMessages(events: AgentEvent[]): string[] {
  const toolNames = new Map<string, string>();
  const lines: string[] = [];

  for (const event of events) {
    if (event.type === "tool_use") {
      const toolName = event.toolName?.trim() || "unknown";
      if (event.requestId) {
        toolNames.set(event.requestId, toolName);
      }
      const idPart = event.requestId ? ` (id: ${event.requestId})` : "";
      const inputPart = event.toolInput?.trim() ? ` 输入: ${event.toolInput.trim()}` : "";
      lines.push(`调用 \`${toolName}\`${idPart}${inputPart}`);
      continue;
    }

    if (event.type === "tool_result") {
      const toolName = (event.requestId ? toolNames.get(event.requestId) : "") || event.toolName?.trim() || "unknown";
      const idPart = event.requestId ? ` (id: ${event.requestId})` : "";
      lines.push(`返回 \`${toolName}\`${idPart}`);
    }
  }

  return lines;
}

export function splitResponseMessages(response: string, events: AgentEvent[]): string[] {
  const body = response.trim() || "done";
  const toolNames = new Map<string, string>();
  const messages: string[] = [];
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === "text") {
      const content = event.content?.trim();
      if (!content) {
        continue;
      }
      messages.push(content);
      textParts.push(content);
      continue;
    }

    if (event.type === "tool_use") {
      const toolName = event.toolName?.trim() || "unknown";
      if (event.requestId) {
        toolNames.set(event.requestId, toolName);
      }
      const idPart = event.requestId ? ` (id: ${event.requestId})` : "";
      const inputPart = event.toolInput?.trim() ? ` 输入: ${event.toolInput.trim()}` : "";
      messages.push(`调用 \`${toolName}\`${idPart}${inputPart}`);
      continue;
    }

    if (event.type === "tool_result") {
      const toolName = (event.requestId ? toolNames.get(event.requestId) : "") || event.toolName?.trim() || "unknown";
      const idPart = event.requestId ? ` (id: ${event.requestId})` : "";
      messages.push(`返回 \`${toolName}\`${idPart}`);
      continue;
    }

    if (event.type === "error") {
      const content = event.content?.trim();
      if (content) {
        messages.push(`agent error: ${content}`);
      }
    }
  }

  if (messages.length === 0) {
    return [body];
  }

  const renderedBody = messages.join("\n\n");
  if (renderedBody === body || body === "done") {
    return messages;
  }

  const textBody = textParts.join("\n\n");
  if (!textBody) {
    messages.push(body);
    return messages;
  }

  if (body === textBody) {
    return messages;
  }

  if (body.startsWith(textBody)) {
    const suffix = body.slice(textBody.length).trim();
    if (suffix.length > 0) {
      messages.push(suffix);
    }
    return messages;
  }

  messages.push(body);
  return messages;
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
  ): Promise<{ response: string; events: AgentEvent[] }> {
    if (!this.sessionStore.tryLock(session)) {
      return {
        response: "session is busy, please retry in a few seconds",
        events: [],
      };
    }

    const events: AgentEvent[] = [];

    try {
      const agentSession = await this.ensureAgentSession(runtime, session);

      const onEvent = (event: AgentEvent): void => {
        events.push(event);
        if (event.sessionId && event.sessionId.length > 0) {
          this.sessionStore.setAgentSessionId(session, event.sessionId);
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

      this.sessionStore.setAgentSessionId(session, agentSession.currentSessionId());

      const resultEvents = events.filter((event) => event.type === "result" && event.content && event.content.trim().length > 0);
      const textEvents = events.filter((event) => event.type === "text" && event.content && event.content.trim().length > 0);
      const errorEvents = events.filter((event) => event.type === "error" && event.content && event.content.trim().length > 0);

      const resultText = resultEvents.at(-1)?.content?.trim() ?? "";
      const text = textEvents.length > 0 ? textEvents.map((event) => event.content?.trim()).join("\n").trim() : "";
      const errorText = errorEvents.length > 0 ? `agent error: ${errorEvents.at(-1)?.content}` : "";
      const response = formatResponseFromEvents(resultText || text || errorText || "done", events);

      this.sessionStore.addHistory(session, "assistant", response);
      await this.sessionStore.save();

      return {
        response,
        events,
      };
    } catch (error) {
      const message = formatResponseFromEvents(`agent execution failed: ${(error as Error).message}`, events);
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

    if (input.content.trim().startsWith("/")) {
      response = await this.handleCommand(runtime, input.project, input.sessionKey, userKey, session, input.content);
    } else {
      const output = await this.runAgent(runtime, session, input.content);
      response = output.response;
      events = output.events;
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

    const result = await this.dispatch(
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

    for (const reply of splitResponseMessages(result.response, result.events)) {
      if (reply.trim().length === 0) {
        continue;
      }
      await platform.reply(message.replyCtx, reply);
    }
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
