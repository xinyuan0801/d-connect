import type { AgentEvent, AgentSession, DeliveryTarget, TurnResult } from "../core/types.js";
import type { ProjectRuntime } from "./project-registry.js";
import type { SessionRecord, SessionRepository } from "./session-repository.js";
import { Logger } from "../infra/logging/logger.js";
import { createEventMessageRenderer, formatResponseFromEvents, previewLogText, splitResponseMessages } from "./message-relay.js";
import { applyTeamEventToState } from "./team-state.js";

export interface RunConversationOptions {
  onMessage?: (message: string) => Promise<void>;
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

export class ConversationService {
  constructor(private readonly sessions: SessionRepository, private readonly logger: Logger) {}

  key(project: string, sessionKey: string): string {
    return `${project}:${sessionKey}`;
  }

  getOrCreateActiveSession(project: string, sessionKey: string): SessionRecord {
    return this.sessions.getOrCreateActive(this.key(project, sessionKey));
  }

  async save(): Promise<void> {
    await this.sessions.save();
  }

  setTeamState(session: SessionRecord, teamState?: SessionRecord["teamState"]): void {
    this.sessions.setTeamState(session, teamState);
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

  async runTurn(
    runtime: ProjectRuntime,
    project: string,
    sessionKey: string,
    session: SessionRecord,
    prompt: string,
    options?: RunConversationOptions,
  ): Promise<TurnResult> {
    if (!this.sessions.tryLock(session)) {
      return {
        response: "session is busy, please retry in a few seconds",
        events: [],
      };
    }

    const events: AgentEvent[] = [];
    const onMessage = options?.onMessage;
    const streaming = typeof onMessage === "function";
    const renderer = createEventMessageRenderer({ includeText: true, includeErrors: true });
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
      const stillOwnsSession = (): boolean => runtime.sessions.get(session.id) === agentSession;

      const onEvent = (event: AgentEvent): void => {
        events.push(event);
        this.logger.debug("runtime agent event", {
          project: runtime.config.name,
          sessionId: session.id,
          ...summarizeAgentEventForLog(event),
        });
        if (stillOwnsSession() && event.sessionId && event.sessionId.length > 0) {
          this.sessions.setAgentSessionId(session, event.sessionId);
        }
        if (event.type === "team_event" || event.type === "team_message") {
          this.sessions.setTeamState(session, applyTeamEventToState(session.teamState, event));
        }
        for (const message of renderer.push(event)) {
          enqueueMessage(message);
        }
      };

      agentSession.on("event", onEvent);

      this.sessions.addHistory(session, "user", prompt);
      await this.sessions.save();

      try {
        await agentSession.send(prompt);
      } finally {
        agentSession.off("event", onEvent);
      }

      for (const message of renderer.flush()) {
        enqueueMessage(message);
      }

      if (stillOwnsSession()) {
        this.sessions.setAgentSessionId(session, agentSession.currentSessionId());
      }

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
        for (let index = emittedMessages; index < finalMessages.length; index += 1) {
          enqueueMessage(finalMessages[index] ?? "");
        }
      }

      await queuedMessages;

      this.sessions.addHistory(session, "assistant", response);
      await this.sessions.save();

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
        for (let index = emittedMessages; index < finalMessages.length; index += 1) {
          enqueueMessage(finalMessages[index] ?? "");
        }
        await queuedMessages;
      }
      this.sessions.addHistory(session, "assistant", message);
      await this.sessions.save();
      return {
        response: message,
        events,
      };
    } finally {
      this.sessions.unlock(session);
      await this.sessions.save();
    }
  }

  rememberDeliveryTarget(project: string, sessionKey: string, deliveryTarget: DeliveryTarget): void {
    this.sessions.setDeliveryTarget(this.key(project, sessionKey), deliveryTarget);
  }

  findDeliveryTarget(project: string, sessionKey: string) {
    return this.sessions.getDeliveryTarget(this.key(project, sessionKey));
  }

  listSessions(project: string, sessionKey: string): SessionRecord[] {
    return this.sessions.listSessions(this.key(project, sessionKey));
  }

  switchSession(project: string, sessionKey: string, target: string): SessionRecord | null {
    return this.sessions.switchSession(this.key(project, sessionKey), target);
  }

  createSession(project: string, sessionKey: string, name: string): SessionRecord {
    return this.sessions.newSession(this.key(project, sessionKey), name);
  }

  clearAgentSession(session: SessionRecord): void {
    this.sessions.setAgentSessionId(session, "");
  }
}
