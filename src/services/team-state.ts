import type {
  AgentEvent,
  TeamMemberState,
  TeamMemberStatus,
  TeamMessageState,
  TeamState,
  TeamTaskState,
  TeamTaskStatus,
} from "../core/types.js";

const MAX_PERSISTED_MESSAGES = 20;

function cloneMember(member: TeamMemberState): TeamMemberState {
  return { ...member };
}

function cloneTask(task: TeamTaskState): TeamTaskState {
  return { ...task };
}

function cloneMessage(message: TeamMessageState): TeamMessageState {
  return { ...message };
}

function cloneTeamState(teamState: TeamState): TeamState {
  return {
    ...teamState,
    members: Object.fromEntries(Object.entries(teamState.members).map(([key, value]) => [key, cloneMember(value)])),
    tasks: Object.fromEntries(Object.entries(teamState.tasks).map(([key, value]) => [key, cloneTask(value)])),
    messages: teamState.messages.map((message) => cloneMessage(message)),
  };
}

function pickTimestamp(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return new Date().toISOString();
}

function trimMessages(messages: TeamMessageState[]): TeamMessageState[] {
  return [...messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-MAX_PERSISTED_MESSAGES);
}

function findMemberIdByName(teamState: TeamState, memberName: string | undefined): string | undefined {
  const normalizedName = memberName?.trim();
  if (!normalizedName) {
    return undefined;
  }
  for (const member of Object.values(teamState.members)) {
    if (member.memberName === normalizedName) {
      return member.memberId;
    }
  }
  return undefined;
}

function ensureTeamState(current: TeamState | undefined, event: AgentEvent): TeamState | undefined {
  const teamName = event.team?.teamName?.trim() || current?.teamName?.trim();
  if (!teamName) {
    return current ? cloneTeamState(current) : undefined;
  }

  if (current) {
    const next = cloneTeamState(current);
    next.teamName = teamName;
    return next;
  }

  return {
    active: true,
    teamName,
    members: {},
    tasks: {},
    messages: [],
    updatedAt: pickTimestamp(event.team?.timestamp),
  };
}

function ensureMember(teamState: TeamState, memberId: string, memberName: string): TeamMemberState {
  const existing = teamState.members[memberId];
  if (existing) {
    if (memberName.trim()) {
      existing.memberName = memberName.trim();
    }
    return existing;
  }

  const created: TeamMemberState = {
    memberId,
    memberName: memberName.trim() || memberId,
    status: "unknown",
  };
  teamState.members[memberId] = created;
  return created;
}

function resolveMember(teamState: TeamState, event: AgentEvent): TeamMemberState | undefined {
  const memberId = event.team?.memberId?.trim() || findMemberIdByName(teamState, event.team?.memberName);
  const memberName = event.team?.memberName?.trim();
  if (!memberId && !memberName) {
    return undefined;
  }
  return ensureMember(teamState, memberId || memberName || "unknown", memberName || memberId || "unknown");
}

function applyMemberMetadata(member: TeamMemberState, event: AgentEvent, status?: TeamMemberStatus): void {
  member.memberName = event.team?.memberName?.trim() || member.memberName;
  member.agentType = event.team?.agentType?.trim() || member.agentType;
  member.model = event.team?.model?.trim() || member.model;
  member.color = event.team?.color?.trim() || member.color;
  member.planModeRequired =
    typeof event.team?.planModeRequired === "boolean" ? event.team.planModeRequired : member.planModeRequired;
  if (status) {
    member.status = status;
  }
  member.updatedAt = pickTimestamp(event.team?.timestamp, member.updatedAt);
}

function ensureTask(teamState: TeamState, taskId: string): TeamTaskState {
  const existing = teamState.tasks[taskId];
  if (existing) {
    return existing;
  }

  const created: TeamTaskState = {
    taskId,
    status: "unknown",
  };
  teamState.tasks[taskId] = created;
  return created;
}

function normalizeIdleReason(idleReason: string | undefined): TeamMemberStatus {
  switch ((idleReason ?? "").trim().toLowerCase()) {
    case "available":
      return "available";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

function mergeMessages(
  left: TeamMessageState[],
  right: TeamMessageState[],
): TeamMessageState[] {
  const merged = new Map<string, TeamMessageState>();
  for (const message of [...left, ...right]) {
    merged.set(message.id, cloneMessage(message));
  }
  return trimMessages([...merged.values()]);
}

function mergeMemberState(persisted: TeamMemberState | undefined, fresh: TeamMemberState | undefined): TeamMemberState | undefined {
  if (!persisted && !fresh) {
    return undefined;
  }
  if (!persisted) {
    return fresh ? cloneMember(fresh) : undefined;
  }
  if (!fresh) {
    return cloneMember(persisted);
  }

  return {
    ...persisted,
    ...fresh,
    status: fresh.status !== "unknown" ? fresh.status : persisted.status,
    updatedAt: pickTimestamp(fresh.updatedAt, persisted.updatedAt),
  };
}

function mergeTaskState(persisted: TeamTaskState | undefined, fresh: TeamTaskState | undefined): TeamTaskState | undefined {
  if (!persisted && !fresh) {
    return undefined;
  }
  if (!persisted) {
    return fresh ? cloneTask(fresh) : undefined;
  }
  if (!fresh) {
    return cloneTask(persisted);
  }

  return {
    ...persisted,
    ...fresh,
    status: fresh.status !== "unknown" ? fresh.status : persisted.status,
    updatedAt: pickTimestamp(fresh.updatedAt, persisted.updatedAt),
  };
}

function applyTaskState(
  teamState: TeamState,
  event: AgentEvent,
  status: TeamTaskStatus,
  defaultMemberStatus: TeamMemberStatus,
): void {
  const taskId = event.team?.taskId?.trim();
  if (!taskId) {
    return;
  }

  const task = ensureTask(teamState, taskId);
  const member = resolveMember(teamState, event);
  task.subject = event.team?.taskSubject?.trim() || task.subject || member?.memberName;
  task.description = event.team?.taskDescription?.trim() || task.description;
  task.memberId = member?.memberId || task.memberId;
  task.memberName = member?.memberName || task.memberName;
  task.status = status;
  task.updatedAt = pickTimestamp(event.team?.timestamp, task.updatedAt);

  if (member) {
    applyMemberMetadata(member, event, defaultMemberStatus);
  }
}

export function applyTeamEventToState(current: TeamState | undefined, event: AgentEvent): TeamState | undefined {
  if ((event.type !== "team_event" && event.type !== "team_message") || !event.team) {
    return current;
  }

  const next = ensureTeamState(current, event);
  if (!next) {
    return current;
  }

  next.teamName = event.team.teamName?.trim() || next.teamName;
  next.teamFilePath = event.team.teamFilePath?.trim() || next.teamFilePath;
  next.leadAgentId = event.team.leadAgentId?.trim() || next.leadAgentId;
  next.updatedAt = pickTimestamp(event.team.timestamp, next.updatedAt);

  if (event.type === "team_message" || event.team.kind === "message") {
    const member = resolveMember(next, event);
    if (member) {
      applyMemberMetadata(member, event);
    }
    const content = event.content?.trim();
    if (content) {
      const timestamp = pickTimestamp(event.team.timestamp);
      const memberName = member?.memberName || event.team.memberName?.trim() || "unknown";
      const id = [timestamp, member?.memberId || memberName, event.team.summary?.trim() || "", content].join("|");
      next.messages = mergeMessages(next.messages, [
        {
          id,
          memberId: member?.memberId,
          memberName,
          content,
          summary: event.team.summary?.trim(),
          color: event.team.color?.trim(),
          timestamp,
        },
      ]);
    }
    return next;
  }

  switch (event.team.kind) {
    case "team_created":
      next.active = true;
      return next;

    case "team_deleted":
      next.active = false;
      return next;

    case "member_spawned": {
      const member = resolveMember(next, event);
      if (member) {
        applyMemberMetadata(member, event, "starting");
      }
      next.active = true;
      return next;
    }

    case "task_started":
      applyTaskState(next, event, "in_progress", "working");
      next.active = true;
      return next;

    case "task_completed":
      applyTaskState(next, event, "completed", "available");
      return next;

    case "member_idle": {
      const member = resolveMember(next, event);
      if (member) {
        applyMemberMetadata(member, event, normalizeIdleReason(event.team.idleReason));
      }
      return next;
    }

    default:
      return next;
  }
}

export function mergeTeamStates(persisted: TeamState | undefined, fresh: TeamState | undefined): TeamState | undefined {
  if (!persisted && !fresh) {
    return undefined;
  }
  if (!persisted) {
    return fresh ? cloneTeamState(fresh) : undefined;
  }
  if (!fresh) {
    return cloneTeamState(persisted);
  }

  const memberIds = new Set<string>([...Object.keys(persisted.members), ...Object.keys(fresh.members)]);
  const mergedMembers: TeamState["members"] = {};
  for (const memberId of memberIds) {
    const merged = mergeMemberState(persisted.members[memberId], fresh.members[memberId]);
    if (merged) {
      mergedMembers[memberId] = merged;
    }
  }

  const taskIds = new Set<string>([...Object.keys(persisted.tasks), ...Object.keys(fresh.tasks)]);
  const mergedTasks: TeamState["tasks"] = {};
  for (const taskId of taskIds) {
    const merged = mergeTaskState(persisted.tasks[taskId], fresh.tasks[taskId]);
    if (merged) {
      mergedTasks[taskId] = merged;
    }
  }

  return {
    active: fresh.active,
    teamName: fresh.teamName || persisted.teamName,
    teamFilePath: fresh.teamFilePath || persisted.teamFilePath,
    leadAgentId: fresh.leadAgentId || persisted.leadAgentId,
    members: mergedMembers,
    tasks: mergedTasks,
    messages: mergeMessages(persisted.messages, fresh.messages),
    updatedAt: pickTimestamp(fresh.updatedAt, persisted.updatedAt),
  };
}
