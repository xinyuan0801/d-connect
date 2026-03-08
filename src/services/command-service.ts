import type { ModeSwitchable } from "../core/types.js";
import type { ProjectRuntime } from "./project-registry.js";
import type { SessionRecord } from "./session-repository.js";
import { ConversationService } from "./conversation-service.js";
import { CronScheduler } from "../scheduler/cron.js";
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

function parseCronAddInput(raw: string): { cronExpr: string; prompt: string } | null {
  const tokens = raw.trim().split(/\s+/).slice(2);
  for (const fieldCount of [6, 5, 1]) {
    if (tokens.length <= fieldCount) {
      continue;
    }
    const cronExpr = tokens.slice(0, fieldCount).join(" ").trim();
    const prompt = tokens.slice(fieldCount).join(" ").trim();
    if (!prompt) {
      continue;
    }
    if (fieldCount === 1 || cron.validate(cronExpr)) {
      return { cronExpr, prompt };
    }
  }
  return null;
}

export class CommandService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly cronScheduler?: CronScheduler,
  ) {}

  async handle(context: CommandContext): Promise<string> {
    const { runtime, project, sessionKey, session, raw } = context;
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
        const created = this.conversations.createSession(project, sessionKey, name);
        await this.conversations.save();
        return `created session ${created.id} (${created.name})`;
      }

      case "list": {
        const active = this.conversations.getOrCreateActiveSession(project, sessionKey);
        const list = this.conversations.listSessions(project, sessionKey);
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
        const found = this.conversations.switchSession(project, sessionKey, target);
        if (!found) {
          return `session not found: ${target}`;
        }
        await this.conversations.save();
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
          const parsed = parseCronAddInput(raw);
          if (!parsed) {
            return "usage: /cron add <expr> <prompt>";
          }
          const job = await this.cronScheduler.addJob({
            project,
            sessionKey,
            cronExpr: parsed.cronExpr,
            prompt: parsed.prompt,
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
}
