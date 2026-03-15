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

export interface ProjectRegistryOptions {
  createAgentAdapter?: (project: ResolvedProjectConfig, logger: Logger) => AgentAdapter;
  createPlatformAdapters?: (project: ResolvedProjectConfig, logger: Logger) => PlatformAdapter[];
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectRuntime>();
  private readonly createAgentAdapterImpl: (project: ResolvedProjectConfig, logger: Logger) => AgentAdapter;
  private readonly createPlatformAdaptersImpl: (project: ResolvedProjectConfig, logger: Logger) => PlatformAdapter[];

  constructor(
    private readonly config: ResolvedAppConfig,
    private readonly logger: Logger,
    options: ProjectRegistryOptions = {},
  ) {
    this.createAgentAdapterImpl = options.createAgentAdapter ?? createAgentAdapter;
    this.createPlatformAdaptersImpl = options.createPlatformAdapters ?? createPlatformAdapters;
  }

  async start(onMessage: (project: string, platform: PlatformAdapter, message: InboundMessage) => Promise<void>): Promise<void> {
    for (const project of this.config.projects) {
      const projectLogger = this.logger.child(`project:${project.name}`);
      const agent = this.createAgentAdapterImpl(project, projectLogger.child("agent"));
      const platforms = this.createPlatformAdaptersImpl(project, projectLogger);
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
        platforms: platforms.map((platform) => platform.name).join(","),
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
