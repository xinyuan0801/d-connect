import type { ModeSwitchable } from "../core/types.js";
import type { ProjectRuntime } from "./project-registry.js";
import type { SessionRecord } from "./session-repository.js";
import { ConversationService } from "./conversation-service.js";
import { LoopScheduler } from "../scheduler/loop.js";
import cron from "node-cron";

function hasModeControl(agent: ProjectRuntime["agent"]): agent is ProjectRuntime["agent"] & ModeSwitchable {
  const candidate = agent as Partial<ModeSwitchable>;
  return (
    typeof candidate.setMode === "function" &&
    typeof candidate.getMode === "function" &&
    typeof candidate.supportedModes === "function"
  );
}

export interface CommandContext {
  runtime: ProjectRuntime;
  project: string;
  sessionKey: string;
  session: SessionRecord;
  raw: string;
}

export interface HandledCommandResult {
  kind: "handled";
  response: string;
}

export interface ForwardCommandResult {
  kind: "forward_to_agent";
  prompt: string;
}

export type CommandResult = HandledCommandResult | ForwardCommandResult;

function parseLoopAddInput(raw: string): { scheduleExpr: string; prompt: string } | null {
  const tokens = raw.trim().split(/\s+/).slice(2);
  for (const fieldCount of [6, 5, 1]) {
    if (tokens.length <= fieldCount) {
      continue;
    }
    const scheduleExpr = tokens.slice(0, fieldCount).join(" ").trim();
    const prompt = tokens.slice(fieldCount).join(" ").trim();
    if (!prompt) {
      continue;
    }
    if (fieldCount === 1 || cron.validate(scheduleExpr)) {
      return { scheduleExpr, prompt };
    }
  }
  return null;
}

function handled(response: string): HandledCommandResult {
  return {
    kind: "handled",
    response,
  };
}

function buildLoopCommandPrompt(project: string, sessionKey: string, request: string): string {
  const quotedProject = JSON.stringify(project);
  const quotedSessionKey = JSON.stringify(sessionKey);

  return [
    "用户想创建一个 d-connect loop 任务。",
    "d-connect 支持通过命令行添加 loop 任务。",
    `当前 project: ${project}`,
    `当前 sessionKey: ${sessionKey}`,
    "请根据下面的请求整理合适的调度表达式和任务 prompt，并优先直接使用命令行创建任务。",
    `可用命令：d-connect loop add -p ${quotedProject} -s ${quotedSessionKey} -e \"<scheduleExpr>\" \"<prompt>\"`,
    "如果用户请求里已经给出了调度规则，直接使用；如果信息不足，再向用户确认。",
    `用户请求：${request}`,
  ].join("\n");
}

export class CommandService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly loopScheduler?: LoopScheduler,
  ) {}

  async handle(context: CommandContext): Promise<CommandResult> {
    const { runtime, project, sessionKey, session, raw } = context;
    const parts = raw.trim().slice(1).split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();

    switch (command) {
      case "help":
        return handled([
          "commands:",
          "/help",
          "/new [name]",
          "/list",
          "/switch <id|name>",
          "/mode [name]",
          "/loop <request>",
          "/loop list",
          "/loop add <expr> <prompt>",
          "/loop del <id>",
        ].join("\n"));

      case "new": {
        const name = parts.slice(1).join(" ").trim() || `session-${Date.now()}`;
        const created = this.conversations.createSession(project, sessionKey, name);
        await this.conversations.save();
        return handled(`created session ${created.id} (${created.name})`);
      }

      case "list": {
        const active = this.conversations.getOrCreateActiveSession(project, sessionKey);
        const list = this.conversations.listSessions(project, sessionKey);
        if (list.length === 0) {
          return handled("no sessions");
        }
        return handled(
          list
            .map((item) => `${item.id === active.id ? "*" : " "} ${item.id}\t${item.name}\t${item.updatedAt}`)
            .join("\n"),
        );
      }

      case "switch": {
        const target = parts[1];
        if (!target) {
          return handled("usage: /switch <id|name>");
        }
        const found = this.conversations.switchSession(project, sessionKey, target);
        if (!found) {
          return handled(`session not found: ${target}`);
        }
        await this.conversations.save();
        return handled(`active session: ${found.id} (${found.name})`);
      }

      case "mode": {
        if (!hasModeControl(runtime.agent)) {
          return handled("this agent does not support mode switching");
        }
        const nextMode = parts[1];
        if (!nextMode) {
          return handled(`mode=${runtime.agent.getMode()} supported=${runtime.agent.supportedModes().join(",")}`);
        }
        runtime.agent.setMode(nextMode);
        return handled(`mode updated: ${runtime.agent.getMode()}`);
      }

      case "loop": {
        if (!this.loopScheduler) {
          return handled("loop scheduler is not enabled");
        }

        const sub = (parts[1] ?? "").toLowerCase();
        if (!sub || sub === "help") {
          return handled("usage: /loop <request> | /loop list | /loop add <expr> <prompt> | /loop del <id>");
        }

        if (sub === "list") {
          const jobs = this.loopScheduler
            .list(project)
            .filter((job) => job.sessionKey === sessionKey)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          if (jobs.length === 0) {
            return handled("no loop jobs");
          }
          return handled(
            jobs
              .map((job) => `${job.id}\t${job.scheduleExpr}\t${job.prompt}\tlastRun=${job.lastRun ?? "-"}`)
              .join("\n"),
          );
        }

        if (sub === "add") {
          const parsed = parseLoopAddInput(raw);
          if (!parsed) {
            return handled("usage: /loop add <expr> <prompt>");
          }
          const job = await this.loopScheduler.addJob({
            project,
            sessionKey,
            scheduleExpr: parsed.scheduleExpr,
            prompt: parsed.prompt,
            description: `chat:${session.id}`,
            silent: false,
          });
          return handled(`loop created: ${job.id}`);
        }

        if (sub === "del") {
          const id = parts[2];
          if (!id) {
            return handled("usage: /loop del <id>");
          }
          const removed = await this.loopScheduler.removeJob(id);
          return handled(removed ? `loop removed: ${id}` : `loop not found: ${id}`);
        }

        return {
          kind: "forward_to_agent",
          prompt: buildLoopCommandPrompt(project, sessionKey, raw.trim().slice("/loop".length).trim()),
        };
      }

      default:
        return handled(`unknown command: ${command}. use /help`);
    }
  }
}
