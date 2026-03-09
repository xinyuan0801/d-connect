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
          "可用命令如下，背下来不一定升职，但至少少问一次 /help：",
          "/help  看这份说明书，它暂时还没学会敷衍你",
          "/new [name]  新建并切换到一个会话，给上下文换个抽屉",
          "/list  列出当前聊天对象下的会话清单",
          "/switch <id|name>  切到指定会话，别让上下文继续串门",
          "/stop  停掉当前会话对应的 Agent 进程，让 CPU 先喘口气",
          "/loop <request>  用自然语言描述一个定时任务",
          "/loop list  查看当前聊天对象下的 loop 任务",
          "/loop add <expr> <prompt>  直接创建 loop，和闹钟一样准时烦人",
          "/loop del <id>  删除 loop，给世界减少一个准点打扰",
        ].join("\n"));

      case "new": {
        const name = parts.slice(1).join(" ").trim() || `session-${Date.now()}`;
        const created = this.conversations.createSession(project, sessionKey, name);
        await this.conversations.save();
        return handled(`已新建并切换到会话 ${created.id}（${created.name}）。旧上下文先去角落冷静一下。`);
      }

      case "list": {
        const active = this.conversations.getOrCreateActiveSession(project, sessionKey);
        const list = this.conversations.listSessions(project, sessionKey);
        if (list.length === 0) {
          return handled("当前还没有会话。场面一度十分安静。");
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
          return handled("用法：/switch <id|name>。机器不会读心，这次先提醒你。");
        }
        const found = this.conversations.switchSession(project, sessionKey, target);
        if (!found) {
          return handled(`没找到会话：${target}。它可能改名了，也可能从没存在过。`);
        }
        await this.conversations.save();
        return handled(`已切换到会话 ${found.id}（${found.name}）。上下文重新排好队了。`);
      }

      case "stop": {
        const runningSession = runtime.sessions.get(session.id);
        if (!runningSession || !runningSession.isAlive()) {
          runtime.sessions.delete(session.id);
          this.conversations.clearAgentSession(session);
          await this.conversations.save();
          return handled(`会话 ${session.id} 早就停了。鞭尸对进程管理帮助不大。`);
        }

        await runningSession.close();
        runtime.sessions.delete(session.id);
        this.conversations.clearAgentSession(session);
        await this.conversations.save();
        return handled(`已停止会话 ${session.id}。风扇声应该会礼貌一点。`);
      }

      case "loop": {
        if (!this.loopScheduler) {
          return handled("当前没启用 loop 调度器。这台机器暂时还不会自己惦记事情。");
        }

        const sub = (parts[1] ?? "").toLowerCase();
        if (!sub || sub === "help") {
          return handled("用法：/loop <request> | /loop list | /loop add <expr> <prompt> | /loop del <id>。时间要写清，宇宙不会帮你补全。");
        }

        if (sub === "list") {
          const jobs = this.loopScheduler
            .list(project)
            .filter((job) => job.sessionKey === sessionKey)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          if (jobs.length === 0) {
            return handled("当前没有 loop 任务。说明定时打扰功能还算克制。");
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
            return handled("用法：/loop add <expr> <prompt>。cron 不写对，时间也只会装作路过。");
          }
          const job = await this.loopScheduler.addJob({
            project,
            sessionKey,
            scheduleExpr: parsed.scheduleExpr,
            prompt: parsed.prompt,
            description: `chat:${session.id}`,
            silent: false,
          });
          return handled(`已创建 loop：${job.id}。从现在起，它会比你更记得这件事。`);
        }

        if (sub === "del") {
          const id = parts[2];
          if (!id) {
            return handled("用法：/loop del <id>。不给 ID，我也不敢乱删，毕竟还想活。");
          }
          const removed = await this.loopScheduler.removeJob(id);
          return handled(
            removed
              ? `已删除 loop：${id}。又一个准时添堵的家伙退场了。`
              : `没找到 loop：${id}。它可能已被删掉，或者从一开始就在摸鱼。`,
          );
        }

        return {
          kind: "forward_to_agent",
          prompt: buildLoopCommandPrompt(project, sessionKey, raw.trim().slice("/loop".length).trim(), this.configPath),
        };
      }

      default:
        return handled(`不认识命令：${command}。先试试 /help，别让斜杠白挨一下。`);
    }
  }
}
