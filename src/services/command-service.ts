import type { TeamMemberState, TeamState, TeamTaskState } from "../core/types.js";
import type { ProjectRuntime } from "./project-registry.js";
import type { SessionRecord } from "./session-repository.js";
import { ConversationService } from "./conversation-service.js";
import { LoopScheduler } from "../scheduler/loop.js";
import cron from "node-cron";
import { resolve } from "node:path";
import { findClaudeTeamStateByLeadSessionId, readClaudeTeamState } from "../adapters/agent/claudecode-team.js";
import { mergeTeamStates } from "./team-state.js";

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

function pickClaudeHomeDir(runtime: ProjectRuntime): string | undefined {
  const homeDir = runtime.config.agent.options.env?.HOME;
  return typeof homeDir === "string" && homeDir.trim().length > 0 ? homeDir : undefined;
}

function supportsTeamCommands(runtime: ProjectRuntime): boolean {
  return runtime.config.agent.type === "claudecode";
}

function translateMemberStatus(status: TeamMemberState["status"]): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "working":
      return "执行中";
    case "available":
      return "可接单";
    case "idle":
      return "待命";
    case "stopped":
      return "已停止";
    default:
      return "未知";
  }
}

function translateTaskStatus(status: TeamTaskState["status"]): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "in_progress":
      return "进行中";
    case "completed":
      return "已完成";
    default:
      return "未知";
  }
}

function sortMembers(teamState: TeamState): TeamMemberState[] {
  return Object.values(teamState.members).sort((left, right) => left.memberName.localeCompare(right.memberName));
}

function sortTasks(teamState: TeamState): TeamTaskState[] {
  return Object.values(teamState.tasks).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function buildNoActiveTeamResponse(teamState?: TeamState): string {
  if (teamState?.teamName) {
    return `当前没有活跃的 Claude agent team。最近一次 team：${teamState.teamName}（已结束）。`;
  }
  return "当前没有活跃的 Claude agent team。";
}

function buildTeamStatusResponse(teamState: TeamState): string {
  const tasks = sortTasks(teamState);
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const completed = tasks.filter((task) => task.status === "completed").length;

  return [
    `Team ${teamState.teamName}`,
    `状态：${teamState.active ? "active" : "inactive"}`,
    `Lead：${teamState.leadAgentId ?? "-"}`,
    `成员：${Object.keys(teamState.members).length}`,
    `任务：${tasks.length}（进行中 ${inProgress}，已完成 ${completed}）`,
    `最近更新：${teamState.updatedAt}`,
  ].join("\n");
}

function buildTeamMembersResponse(teamState: TeamState): string {
  const members = sortMembers(teamState);
  if (members.length === 0) {
    return `Team ${teamState.teamName} 当前还没有记录到成员。`;
  }

  return [
    `Team ${teamState.teamName} 成员：`,
    ...members.map((member) => {
      const runtime = [member.agentType, member.model].filter(Boolean).join("/");
      const suffix = [
        translateMemberStatus(member.status),
        runtime || "-",
        member.planModeRequired === true ? "plan-mode" : "",
      ]
        .filter(Boolean)
        .join("\t");
      return `${member.memberName}\t${suffix}`;
    }),
  ].join("\n");
}

function buildTeamTasksResponse(teamState: TeamState): string {
  const tasks = sortTasks(teamState);
  if (tasks.length === 0) {
    return `Team ${teamState.teamName} 当前没有任务记录。`;
  }

  return [
    `Team ${teamState.teamName} 任务：`,
    ...tasks.map((task) => {
      const subject = task.subject || task.description || "-";
      return `${task.taskId}\t${translateTaskStatus(task.status)}\t${task.memberName ?? "-"}\t${subject}`;
    }),
  ].join("\n");
}

function buildTeamAskPrompt(teamState: TeamState, memberName: string, message: string): string {
  return [
    "你当前正在使用 Claude Code agent team。",
    `当前 team: ${teamState.teamName}`,
    `请把下面的任务交给 teammate ${memberName}。`,
    "如果找不到这个 teammate，先列出当前成员并明确说明无法转达。",
    "请直接在 team 内部协作，不要要求 d-connect 代写 mailbox 文件。",
    `任务内容：${message}`,
  ].join("\n");
}

function buildTeamStopPrompt(teamState: TeamState, memberName: string): string {
  return [
    "你当前正在使用 Claude Code agent team。",
    `当前 team: ${teamState.teamName}`,
    `请通知 teammate ${memberName} 停止当前任务，并汇总它已经完成的部分。`,
    "如果该 teammate 不存在，请先列出当前成员并说明。",
  ].join("\n");
}

function buildTeamCleanupPrompt(teamState: TeamState): string {
  return [
    "你当前正在使用 Claude Code agent team。",
    `当前 team: ${teamState.teamName}`,
    "请清理当前 agent team：停止仍在运行的 teammate，收集剩余总结，并在完成后删除这个 team。",
    "如果某个成员仍有未完成任务，请先给出清理前的阻塞说明。",
  ].join("\n");
}

export class CommandService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly loopScheduler?: LoopScheduler,
    private readonly configPath?: string,
  ) {}

  private async resolveClaudeTeamState(runtime: ProjectRuntime, session: SessionRecord): Promise<TeamState | undefined> {
    if (!supportsTeamCommands(runtime)) {
      return undefined;
    }

    const options = { homeDir: pickClaudeHomeDir(runtime) };
    const persisted = session.teamState;

    let fresh: TeamState | undefined;
    if (persisted?.teamName) {
      fresh = await readClaudeTeamState(persisted.teamName, options);
    }
    if (!fresh && session.agentSessionId.trim().length > 0) {
      fresh = await findClaudeTeamStateByLeadSessionId(session.agentSessionId, options);
    }

    if (!fresh) {
      if (persisted?.active) {
        const inactive: TeamState = {
          ...persisted,
          active: false,
          updatedAt: new Date().toISOString(),
        };
        this.conversations.setTeamState(session, inactive);
        await this.conversations.save();
        return inactive;
      }
      return persisted;
    }

    const merged = mergeTeamStates(persisted, fresh) ?? fresh;
    this.conversations.setTeamState(session, merged);
    await this.conversations.save();
    return merged;
  }

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
          "/team  查看当前 Claude agent team 的状态",
          "/team members  查看当前 team 成员",
          "/team tasks  查看当前 team 任务",
          "/team ask <member> <message>  让 lead 把任务转给指定 teammate",
          "/team stop <member>  让 lead 停掉指定 teammate 的当前任务",
          "/team cleanup  让 lead 清理并收尾当前 team",
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

      case "team": {
        if (!supportsTeamCommands(runtime)) {
          return handled("当前 agent 不支持 /team。v1 只给 Claude Code agent team 开门。");
        }

        const sub = (parts[1] ?? "").toLowerCase();
        if (!sub || sub === "status") {
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          return handled(teamState?.active ? buildTeamStatusResponse(teamState) : buildNoActiveTeamResponse(teamState));
        }

        if (sub === "help") {
          return handled(
            "用法：/team | /team help | /team members | /team tasks | /team ask <member> <message> | /team stop <member> | /team cleanup",
          );
        }

        if (sub === "members") {
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          return handled(teamState?.active ? buildTeamMembersResponse(teamState) : buildNoActiveTeamResponse(teamState));
        }

        if (sub === "tasks") {
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          return handled(teamState?.active ? buildTeamTasksResponse(teamState) : buildNoActiveTeamResponse(teamState));
        }

        if (sub === "ask") {
          const memberName = parts[2]?.trim();
          const message = parts.slice(3).join(" ").trim();
          if (!memberName || !message) {
            return handled("用法：/team ask <member> <message>。不给人名和任务，lead 也没法代你分工。");
          }
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          if (!teamState?.active) {
            return handled(buildNoActiveTeamResponse(teamState));
          }
          return {
            kind: "forward_to_agent",
            prompt: buildTeamAskPrompt(teamState, memberName, message),
          };
        }

        if (sub === "stop") {
          const memberName = parts[2]?.trim();
          if (!memberName) {
            return handled("用法：/team stop <member>。不给成员名，我也不敢随便喊停。");
          }
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          if (!teamState?.active) {
            return handled(buildNoActiveTeamResponse(teamState));
          }
          return {
            kind: "forward_to_agent",
            prompt: buildTeamStopPrompt(teamState, memberName),
          };
        }

        if (sub === "cleanup") {
          const teamState = await this.resolveClaudeTeamState(runtime, session);
          if (!teamState?.active) {
            return handled(buildNoActiveTeamResponse(teamState));
          }
          return {
            kind: "forward_to_agent",
            prompt: buildTeamCleanupPrompt(teamState),
          };
        }

        return handled("用法：/team | /team help | /team members | /team tasks | /team ask <member> <message> | /team stop <member> | /team cleanup");
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
