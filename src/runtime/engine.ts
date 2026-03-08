import type { LoopJob } from "../core/types.js";
import type { AppConfig } from "../config/schema.js";
import type { ResolvedAppConfig } from "../config/normalize.js";
import { normalizeConfig } from "../config/normalize.js";
import { Logger } from "../infra/logging/logger.js";
import { LoopScheduler } from "../scheduler/loop.js";
import { DaemonRuntime, type RuntimeSendInput, type RuntimeSendResult } from "../services/daemon-runtime.js";
export { formatResponseFromEvents, splitResponseMessages, summarizeToolMessages } from "../services/message-relay.js";

function isResolvedConfig(config: AppConfig | ResolvedAppConfig): config is ResolvedAppConfig {
  return typeof (config as Partial<ResolvedAppConfig>).dataDir === "string";
}

export interface RuntimeEngineOptions {
  configPath?: string;
}

export class RuntimeEngine {
  private runtime?: DaemonRuntime;
  private readonly resolvedConfig: ResolvedAppConfig;
  private readonly options: RuntimeEngineOptions;

  constructor(
    config: AppConfig | ResolvedAppConfig,
    private readonly logger: Logger,
    private readonly loopScheduler?: LoopScheduler,
    options: RuntimeEngineOptions = {},
  ) {
    this.resolvedConfig = isResolvedConfig(config) ? config : normalizeConfig(config);
    this.options = options;
  }

  private async ensureRuntime(): Promise<DaemonRuntime> {
    if (!this.runtime) {
      this.runtime = await DaemonRuntime.create(
        this.resolvedConfig,
        this.logger,
        this.loopScheduler,
        this.options.configPath,
      );
    }
    return this.runtime;
  }

  async start(): Promise<void> {
    const runtime = await this.ensureRuntime();
    await runtime.start();
  }

  async stop(): Promise<void> {
    if (!this.runtime) {
      return;
    }
    await this.runtime.stop();
    this.runtime = undefined;
  }

  async send(input: RuntimeSendInput): Promise<RuntimeSendResult> {
    const runtime = await this.ensureRuntime();
    return runtime.send(input);
  }

  async executeJob(job: LoopJob): Promise<void> {
    const runtime = await this.ensureRuntime();
    await runtime.executeJob(job);
  }

  async executeLoopJob(job: LoopJob): Promise<void> {
    const runtime = await this.ensureRuntime();
    await runtime.executeLoopJob(job);
  }
}

export type { RuntimeSendInput, RuntimeSendResult } from "../services/daemon-runtime.js";
