import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type {
  AgentEvent,
  TeamEventPayload,
  TeamMemberState,
  TeamMemberStatus,
  TeamMessageState,
  TeamState,
  TeamTaskState,
  TeamTaskStatus,
} from "../../core/types.js";
import { Logger } from "../../logging.js";

type RawRecord = Record<string, unknown>;

interface ClaudeTeamPathsOptions {
  homeDir?: string;
}

interface ClaudeTeamWatcherOptions extends ClaudeTeamPathsOptions {
  pollIntervalMs?: number;
}

interface RawTeamMember {
  agentId?: string;
  name?: string;
  agentType?: string;
  model?: string;
  color?: string;
  planModeRequired?: boolean;
}

interface RawTeamConfig {
  name?: string;
  description?: string;
  leadAgentId?: string;
  leadSessionId?: string;
  members?: RawTeamMember[];
}

interface RawTaskFile {
  id?: string;
  subject?: string;
  description?: string;
  status?: string;
}

interface RawInboxEntry {
  from?: string;
  text?: string;
  summary?: string;
  timestamp?: string;
  color?: string;
}

interface ParsedInboxEntry {
  message?: TeamMessageState;
  idle?: {
    memberName: string;
    timestamp: string;
    idleReason?: string;
  };
}

const DEFAULT_POLL_INTERVAL_MS = 400;
const MAX_PERSISTED_MESSAGES = 20;

function asRecord(value: unknown): RawRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawRecord;
}

function pickString(payload: RawRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveClaudeHome(options: ClaudeTeamPathsOptions = {}): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  return join(homeDir, ".claude");
}

function normalizeTaskStatus(value: string | undefined): TeamTaskStatus {
  switch ((value ?? "").trim().toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return "unknown";
  }
}

function normalizeIdleStatus(value: string | undefined): TeamMemberStatus {
  switch ((value ?? "").trim().toLowerCase()) {
    case "available":
      return "available";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

function buildMessageId(entry: RawInboxEntry): string {
  return [
    entry.timestamp?.trim() ?? "",
    entry.from?.trim() ?? "",
    entry.summary?.trim() ?? "",
    entry.text?.trim() ?? "",
  ].join("|");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function ensureMember(
  members: Record<string, TeamMemberState>,
  memberId: string,
  memberName: string,
): TeamMemberState {
  const existing = members[memberId];
  if (existing) {
    return existing;
  }

  const created: TeamMemberState = {
    memberId,
    memberName,
    status: "unknown",
  };
  members[memberId] = created;
  return created;
}

function applyMemberMetadata(target: TeamMemberState, member: RawTeamMember, updatedAt?: string): void {
  target.memberName = member.name?.trim() || target.memberName;
  target.agentType = member.agentType?.trim() || target.agentType;
  target.model = member.model?.trim() || target.model;
  target.color = member.color?.trim() || target.color;
  target.planModeRequired = typeof member.planModeRequired === "boolean" ? member.planModeRequired : target.planModeRequired;
  if (updatedAt) {
    target.updatedAt = updatedAt;
  }
}

function findMemberIdByName(
  members: Record<string, TeamMemberState>,
  memberName: string | undefined,
): string | undefined {
  const normalizedName = memberName?.trim();
  if (!normalizedName) {
    return undefined;
  }

  for (const member of Object.values(members)) {
    if (member.memberName === normalizedName) {
      return member.memberId;
    }
  }

  return undefined;
}

function parseInboxEntry(entry: RawInboxEntry, members: Record<string, TeamMemberState>): ParsedInboxEntry | null {
  const memberName = entry.from?.trim();
  const timestamp = entry.timestamp?.trim();
  const text = entry.text?.trim();
  if (!memberName || !timestamp || !text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const payload = asRecord(parsed);
    if (payload && pickString(payload, ["type"]) === "idle_notification") {
      const idleReason = pickString(payload, ["idleReason"]);
      const memberId = findMemberIdByName(members, memberName) ?? memberName;
      const member = ensureMember(members, memberId, memberName);
      const status = normalizeIdleStatus(idleReason);
      if (status !== "unknown") {
        member.status = status;
      }
      member.updatedAt = timestamp;
      return {
        idle: {
          memberName,
          timestamp,
          idleReason,
        },
      };
    }
  } catch {
    // Plain text teammate message.
  }

  const memberId = findMemberIdByName(members, memberName) ?? memberName;
  return {
    message: {
      id: buildMessageId(entry),
      memberId,
      memberName,
      content: text,
      summary: entry.summary?.trim(),
      color: entry.color?.trim(),
      timestamp,
    },
  };
}

function compareTimestamps(a: string, b: string): number {
  return a.localeCompare(b);
}

function applyMemberStatusesFromTasks(
  members: Record<string, TeamMemberState>,
  tasks: Record<string, TeamTaskState>,
): void {
  for (const member of Object.values(members)) {
    const memberTasks = Object.values(tasks).filter((task) => task.memberId === member.memberId);
    if (memberTasks.some((task) => task.status === "in_progress")) {
      member.status = "working";
      continue;
    }

    if (member.status === "unknown") {
      member.status = "available";
    }
  }
}

function trimMessages(messages: TeamMessageState[]): TeamMessageState[] {
  return messages
    .sort((left, right) => compareTimestamps(left.timestamp, right.timestamp))
    .slice(-MAX_PERSISTED_MESSAGES);
}

export function isTeamToolName(toolName: string | undefined): boolean {
  const normalized = toolName?.trim();
  if (!normalized) {
    return false;
  }
  return normalized === "TeamCreate" || normalized === "TaskOutput" || normalized === "SendMessage";
}

export function isTeamAgentToolInput(toolInputRaw: Record<string, unknown> | undefined): boolean {
  if (!toolInputRaw) {
    return false;
  }
  return typeof toolInputRaw.team_name === "string" && toolInputRaw.team_name.trim().length > 0;
}

export async function readClaudeTeamState(teamName: string, options: ClaudeTeamPathsOptions = {}): Promise<TeamState | undefined> {
  if (!teamName.trim()) {
    return undefined;
  }

  const claudeHome = resolveClaudeHome(options);
  const teamDir = join(claudeHome, "teams", teamName);
  const configPath = join(teamDir, "config.json");
  const config = await readJsonFile<RawTeamConfig>(configPath);
  if (!config) {
    return undefined;
  }

  const members: Record<string, TeamMemberState> = {};
  for (const rawMember of config.members ?? []) {
    const memberId = rawMember.agentId?.trim() || rawMember.name?.trim();
    const memberName = rawMember.name?.trim() || rawMember.agentId?.trim();
    if (!memberId || !memberName) {
      continue;
    }
    const member = ensureMember(members, memberId, memberName);
    applyMemberMetadata(member, rawMember);
  }

  const inboxEntries = (await readJsonFile<RawInboxEntry[]>(join(teamDir, "inboxes", "team-lead.json"))) ?? [];
  const messages: TeamMessageState[] = [];
  for (const rawEntry of inboxEntries) {
    const parsed = parseInboxEntry(rawEntry, members);
    if (!parsed?.message) {
      continue;
    }
    messages.push(parsed.message);
  }

  const tasks: Record<string, TeamTaskState> = {};
  try {
    const taskDir = join(claudeHome, "tasks", teamName);
    const filenames = (await readdir(taskDir)).filter((name) => name.endsWith(".json")).sort();
    for (const filename of filenames) {
      const rawTask = await readJsonFile<RawTaskFile>(join(taskDir, filename));
      if (!rawTask?.id) {
        continue;
      }

      const memberName = rawTask.subject?.trim();
      const memberId = findMemberIdByName(members, memberName);
      tasks[rawTask.id] = {
        taskId: rawTask.id,
        subject: memberName,
        description: rawTask.description?.trim(),
        status: normalizeTaskStatus(rawTask.status),
        memberId,
        memberName,
      };
    }
  } catch {
    // Missing task directory is fine when no tasks have been created.
  }

  applyMemberStatusesFromTasks(members, tasks);

  return {
    active: true,
    teamName: config.name?.trim() || teamName,
    teamFilePath: configPath,
    leadAgentId: config.leadAgentId?.trim(),
    members,
    tasks,
    messages: trimMessages(messages),
    updatedAt: new Date().toISOString(),
  };
}

export async function findClaudeTeamStateByLeadSessionId(
  leadSessionId: string,
  options: ClaudeTeamPathsOptions = {},
): Promise<TeamState | undefined> {
  const normalizedSessionId = leadSessionId.trim();
  if (!normalizedSessionId) {
    return undefined;
  }

  const teamRoot = join(resolveClaudeHome(options), "teams");
  let teamNames: string[];
  try {
    teamNames = await readdir(teamRoot);
  } catch {
    return undefined;
  }

  for (const teamName of teamNames.sort()) {
    const config = await readJsonFile<RawTeamConfig>(join(teamRoot, teamName, "config.json"));
    if (!config?.leadSessionId || config.leadSessionId.trim() !== normalizedSessionId) {
      continue;
    }
    return readClaudeTeamState(teamName, options);
  }

  return undefined;
}

function buildTaskCompletedEvent(task: TeamTaskState, teamState: TeamState): AgentEvent {
  const team: TeamEventPayload = {
    kind: "task_completed",
    teamName: teamState.teamName,
    teamFilePath: teamState.teamFilePath,
    leadAgentId: teamState.leadAgentId,
    memberName: task.memberName,
    memberId: task.memberId,
    taskId: task.taskId,
    taskStatus: task.status,
    taskSubject: task.subject,
    taskDescription: task.description,
    timestamp: teamState.updatedAt,
  };

  const subject = task.subject || task.taskId;
  return {
    type: "team_event",
    content: subject,
    team,
  };
}

function buildMessageEvent(message: TeamMessageState, teamState: TeamState): AgentEvent {
  return {
    type: "team_message",
    content: message.content,
    team: {
      kind: "message",
      teamName: teamState.teamName,
      teamFilePath: teamState.teamFilePath,
      leadAgentId: teamState.leadAgentId,
      memberName: message.memberName,
      memberId: message.memberId,
      summary: message.summary,
      color: message.color,
      timestamp: message.timestamp,
    },
  };
}

export class ClaudeTeamWatcher {
  private currentSessionId = "";
  private currentTeamName = "";
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastSnapshot?: TeamState;
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly options: ClaudeTeamWatcherOptions = {},
  ) {}

  observe(events: AgentEvent[]): void {
    for (const event of events) {
      if (event.sessionId?.trim()) {
        this.currentSessionId = event.sessionId.trim();
      }

      if (event.type === "team_event" && event.team?.teamName?.trim()) {
        this.currentTeamName = event.team.teamName.trim();
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.poll();
  }

  private async resolveCurrentTeamState(): Promise<TeamState | undefined> {
    if (this.currentTeamName) {
      return readClaudeTeamState(this.currentTeamName, this.options);
    }

    if (!this.currentSessionId) {
      return undefined;
    }

    const teamState = await findClaudeTeamStateByLeadSessionId(this.currentSessionId, this.options);
    if (teamState?.teamName) {
      this.currentTeamName = teamState.teamName;
    }
    return teamState;
  }

  private seedInitialSnapshot(teamState: TeamState): void {
    this.lastSnapshot = teamState;
    for (const message of teamState.messages) {
      this.seenMessageIds.add(message.id);
    }
  }

  private emitTaskTransitions(nextState: TeamState): void {
    if (!this.lastSnapshot) {
      return;
    }

    for (const task of Object.values(nextState.tasks)) {
      const previous = this.lastSnapshot.tasks[task.taskId];
      if (!previous) {
        continue;
      }
      if (previous.status === "completed" || task.status !== "completed") {
        continue;
      }
      this.onEvent(buildTaskCompletedEvent(task, nextState));
    }
  }

  private emitInboxMessages(nextState: TeamState): void {
    for (const message of nextState.messages) {
      if (this.seenMessageIds.has(message.id)) {
        continue;
      }
      this.seenMessageIds.add(message.id);
      this.onEvent(buildMessageEvent(message, nextState));
    }
  }

  private async poll(): Promise<void> {
    try {
      const nextState = await this.resolveCurrentTeamState();
      if (!nextState) {
        if (this.lastSnapshot?.active && this.currentTeamName) {
          this.onEvent({
            type: "team_event",
            team: {
              kind: "team_deleted",
              teamName: this.currentTeamName,
              teamFilePath: this.lastSnapshot.teamFilePath,
              leadAgentId: this.lastSnapshot.leadAgentId,
              timestamp: new Date().toISOString(),
            },
          });
          this.lastSnapshot = {
            ...this.lastSnapshot,
            active: false,
            updatedAt: new Date().toISOString(),
          };
        }
        return;
      }

      if (!this.lastSnapshot) {
        this.seedInitialSnapshot(nextState);
        return;
      }

      this.emitTaskTransitions(nextState);
      this.emitInboxMessages(nextState);
      this.lastSnapshot = nextState;
    } catch (error) {
      this.logger.debug("claude team watcher poll failed", {
        sessionId: this.currentSessionId,
        teamName: this.currentTeamName,
        error: (error as Error).message,
      });
    }
  }
}
