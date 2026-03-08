import type { AgentAdapter, AgentSession, InboundMessage, PlatformAdapter } from "../core/types.js";
import type { ResolvedProjectConfig, ResolvedAppConfig } from "../config/normalize.js";
import { Logger } from "../infra/logging/logger.js";
import { createAgentAdapter } from "../adapters/agent/index.js";
import { createPlatformAdapters } from "../adapters/platform/index.js";

export interface ProjectRuntime {
  config: ResolvedProjectConfig;
  agent: AgentAdapter;
  platforms: PlatformAdapter[];
  platformMap: Map<string, PlatformAdapter>;
  sessions: Map<string, AgentSession>;
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectRuntime>();

  constructor(private readonly config: ResolvedAppConfig, private readonly logger: Logger) {}

  async start(onMessage: (project: string, platform: PlatformAdapter, message: InboundMessage) => Promise<void>): Promise<void> {
    for (const project of this.config.projects) {
      const projectLogger = this.logger.child(`project:${project.name}`);
      const agent = createAgentAdapter(project, projectLogger.child("agent"));
      const platforms = createPlatformAdapters(project, projectLogger);
      const runtime: ProjectRuntime = {
        config: project,
        agent,
        platforms,
        platformMap: new Map(platforms.map((platform) => [platform.name, platform])),
        sessions: new Map<string, AgentSession>(),
      };

      this.projects.set(project.name, runtime);

      for (const platform of platforms) {
        await platform.start((message) => onMessage(project.name, platform, message));
      }

      projectLogger.info("project started", {
        agent: project.agent.type,
        platforms: project.platforms.map((platform) => platform.type).join(","),
      });
    }
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
  }

  get(project: string): ProjectRuntime {
    const runtime = this.projects.get(project);
    if (!runtime) {
      throw new Error(`project not found: ${project}`);
    }
    return runtime;
  }
}
