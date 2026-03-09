import type { ProjectRuntime } from "./project-registry.js";
import type { SessionRecord } from "./session-repository.js";
import { ConversationService } from "./conversation-service.js";
import { LoopScheduler } from "../scheduler/loop.js";
import cron from "node-cron";
import { resolve } from "node:path";

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

function buildLoopCommandPrompt(project: string, sessionKey: string, request: string, configPath?: string): string {
  const quotedProject = JSON.stringify(project);
  const quotedSessionKey = JSON.stringify(sessionKey);
  const normalizedConfigPath =
    typeof configPath === "string" && configPath.trim().length > 0 ? resolve(configPath.trim()) : undefined;
  const configPathToken = normalizedConfigPath ? JSON.stringify(normalizedConfigPath) : "<configPath>";
  const addCommand = normalizedConfigPath
    ? `d-connect loop add -p ${quotedProject} -s ${quotedSessionKey} -e "<scheduleExpr>" -c ${configPathToken} "<prompt>"`
    : `d-connect loop add -p ${quotedProject} -s ${quotedSessionKey} -e "<scheduleExpr>" "<prompt>"`;
  const listCommand = normalizedConfigPath
    ? `d-connect loop list -p ${quotedProject} -c ${configPathToken}`
    : `d-connect loop list -p ${quotedProject}`;
  const exampleAddCommand = normalizedConfigPath
    ? `d-connect loop add -p ${quotedProject} -s ${quotedSessionKey} -e "22 20 * * *" -c ${configPathToken} "介绍一下自己"`
    : `d-connect loop add -p ${quotedProject} -s ${quotedSessionKey} -e "22 20 * * *" "介绍一下自己"`;

  const lines = [
    "用户想通过自然语言管理 d-connect loop 任务（新增/查看/删除）。",
    "d-connect 支持通过命令行管理 loop 任务。",
    `当前 project: ${project}`,
    `当前 sessionKey: ${sessionKey}`,
  ];

  if (normalizedConfigPath) {
    lines.push(`当前 configPath: ${normalizedConfigPath}`);
    lines.push(`重要：执行 d-connect loop 命令时必须带 -c，且固定为 ${configPathToken}。`);
  }

  lines.push(
    "请根据下面的请求判断应执行 add/list/del 哪个命令，并优先直接执行命令。",
    `可用命令(add)：${addCommand}`,
    `可用命令(list)：${listCommand}`,
    `可用命令(del)：d-connect loop del -i "<jobId>" -c ${configPathToken}`,
    "当用户要求删除但未提供 jobId 时，先执行 list，再基于用户确认的 jobId 执行 del。",
    "重要：`<prompt>` 只能写任务动作本身，不能包含任何时间/频率/cron 信息（例如“每天、每周、8点22分、22 20 * * *”）。",
    "调度信息只放在 `-e`，`<prompt>` 只保留可执行动作。",
    `示例：用户请求“每天晚上8点22介绍一下自己” -> ${exampleAddCommand}`,
    "如果无法准确区分调度和任务动作，再向用户确认。",
    `用户请求：${request}`,
  );

  return lines.join("\n");
}

export class CommandService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly loopScheduler?: LoopScheduler,
    private readonly configPath?: string,
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
          "/stop",
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

      case "stop": {
        const runningSession = runtime.sessions.get(session.id);
        if (!runningSession || !runningSession.isAlive()) {
          runtime.sessions.delete(session.id);
          this.conversations.clearAgentSession(session);
          await this.conversations.save();
          return handled(`session already stopped: ${session.id}`);
        }

        await runningSession.close();
        runtime.sessions.delete(session.id);
        this.conversations.clearAgentSession(session);
        await this.conversations.save();
        return handled(`stopped session ${session.id}`);
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
          prompt: buildLoopCommandPrompt(project, sessionKey, raw.trim().slice("/loop".length).trim(), this.configPath),
        };
      }

      default:
        return handled(`unknown command: ${command}. use /help`);
    }
  }
}
