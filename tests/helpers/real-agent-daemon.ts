import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedAppConfig } from "../../src/config/normalize.js";
import { Logger } from "../../src/logging.js";
import { resolveIpcEndpoint } from "../../src/ipc/endpoint.js";
import { IpcServer } from "../../src/ipc/server.js";
import { createLoopStore, LoopScheduler } from "../../src/scheduler/loop.js";
import type { DeliveryTarget, InboundMessage, PlatformAdapter } from "../../src/runtime/types.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import type { ProjectRegistryOptions } from "../../src/services/project-registry.js";

export const REAL_AGENT_E2E_ENABLED = process.env.D_CONNECT_REAL_AGENT_E2E === "1";
export const PROJECT_NAME = "demo";
export const PLATFORM_NAME = "test-platform";
export const CHAT_ID = "chat-1";
export const USER_ID = "user-1";
export const PLATFORM_SESSION_KEY = `${PLATFORM_NAME}:${CHAT_ID}:${USER_ID}`;
export const DELIVERY_TARGET: DeliveryTarget = {
  platform: PLATFORM_NAME,
  payload: {
    chatId: CHAT_ID,
  },
};

export interface PersistedSessionSnapshot {
  sessions: Record<
    string,
    {
      agentSessionId: string;
      history: Array<{ role: "user" | "assistant"; content: string }>;
      updatedAt: string;
    }
  >;
  activeSession: Record<string, string>;
  deliveryTargets: Record<string, DeliveryTarget>;
}

interface RealAgentSpec {
  type: "claudecode" | "codex" | "opencode" | "qoder" | "iflow";
  defaultCmd: string;
  cmdEnvVar: string;
}

export interface ResolvedRealAgentSpec extends RealAgentSpec {
  cmd: string;
  available: boolean;
}

const REAL_AGENT_SPECS: RealAgentSpec[] = [
  { type: "claudecode", defaultCmd: "claude", cmdEnvVar: "D_CONNECT_E2E_CLAUDE_CMD" },
  { type: "codex", defaultCmd: "codex", cmdEnvVar: "D_CONNECT_E2E_CODEX_CMD" },
  { type: "opencode", defaultCmd: "opencode", cmdEnvVar: "D_CONNECT_E2E_OPENCODE_CMD" },
  { type: "qoder", defaultCmd: "qodercli", cmdEnvVar: "D_CONNECT_E2E_QODER_CMD" },
  { type: "iflow", defaultCmd: "iflow", cmdEnvVar: "D_CONNECT_E2E_IFLOW_CMD" },
];

function commandAvailable(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0;
}

export function resolveRealAgentSpecs(envVarName = "D_CONNECT_REAL_AGENT_TYPES"): ResolvedRealAgentSpec[] {
  const raw = process.env[envVarName] ?? REAL_AGENT_SPECS.map((spec) => spec.type).join(",");
  const requested = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is RealAgentSpec["type"] => REAL_AGENT_SPECS.some((spec) => spec.type === value)),
  );

  return REAL_AGENT_SPECS.map((spec) => {
    const override = process.env[spec.cmdEnvVar]?.trim();
    const cmd = override && override.length > 0 ? override : spec.defaultCmd;
    return {
      ...spec,
      cmd,
      available: commandAvailable(cmd),
    };
  }).filter((spec) => requested.has(spec.type));
}

export class FakePlatform implements PlatformAdapter {
  readonly name = PLATFORM_NAME;
  public handler?: (message: InboundMessage) => Promise<void> | void;
  public replies: Array<{ replyContext: unknown; content: string }> = [];
  public sends: Array<{ target: DeliveryTarget; content: string }> = [];

  async start(handler: (message: InboundMessage) => Promise<void> | void): Promise<void> {
    this.handler = handler;
  }

  async reply(replyContext: unknown, content: string): Promise<void> {
    this.replies.push({ replyContext, content });
  }

  async send(target: DeliveryTarget, content: string): Promise<void> {
    this.sends.push({ target, content });
  }

  async stop(): Promise<void> {
    // noop
  }

  async deliver(message: InboundMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("handler missing");
    }
    await this.handler(message);
  }

  clear(): void {
    this.replies.length = 0;
    this.sends.length = 0;
  }
}

interface RuntimeFixtureState {
  platforms: FakePlatform[];
}

function createRuntimeFixtureState(): RuntimeFixtureState {
  return {
    platforms: [],
  };
}

function createProjectRegistryOptions(state: RuntimeFixtureState): ProjectRegistryOptions {
  return {
    createPlatformAdapters: () => {
      const platform = new FakePlatform();
      state.platforms.push(platform);
      return [platform];
    },
  };
}

function createResolvedConfig(
  dataDir: string,
  spec: ResolvedRealAgentSpec,
  agentOptions: Record<string, unknown> = {},
): ResolvedAppConfig {
  return {
    configVersion: 1,
    dataDir,
    log: { level: "error" as const },
    loop: { silent: false },
    projects: [
      {
        name: PROJECT_NAME,
        agent: {
          type: spec.type,
          options: {
            cmd: spec.cmd,
            workDir: process.cwd(),
            ...agentOptions,
          },
        },
        guard: {
          enabled: false,
        },
        platforms: [],
      },
    ],
  };
}

function createRuntimeEngine(
  config: ResolvedAppConfig,
  state: RuntimeFixtureState,
  loopScheduler?: LoopScheduler,
): RuntimeEngine {
  return new RuntimeEngine(config, new Logger("error"), loopScheduler, {
    projectRegistry: createProjectRegistryOptions(state),
  });
}

export function createInboundMessage(
  content: string,
  messageId: string,
  sessionKey = PLATFORM_SESSION_KEY,
): InboundMessage {
  return {
    platform: PLATFORM_NAME,
    sessionKey,
    userId: USER_ID,
    userName: "Real Agent E2E",
    content,
    replyContext: {
      messageId,
      chatId: CHAT_ID,
    },
    deliveryTarget: DELIVERY_TARGET,
  };
}

export async function loadPersistedSnapshot(dataDir: string): Promise<PersistedSessionSnapshot> {
  const path = join(dataDir, "sessions", "sessions.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PersistedSessionSnapshot;
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const intervalMs = options.intervalMs ?? 200;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(options.description ?? "condition not met before timeout");
}

export class RealAgentDaemonHarness {
  readonly spec: ResolvedRealAgentSpec;
  readonly agentOptions: Record<string, unknown>;
  readonly state = createRuntimeFixtureState();
  dataDir = "";
  socketPath = "";
  runtime?: RuntimeEngine;
  loopScheduler?: LoopScheduler;
  ipcServer?: IpcServer;

  constructor(spec: ResolvedRealAgentSpec, agentOptions: Record<string, unknown> = {}) {
    this.spec = spec;
    this.agentOptions = agentOptions;
  }

  get platform(): FakePlatform | undefined {
    return this.state.platforms.at(-1);
  }

  async start(): Promise<void> {
    this.dataDir = await mkdtemp(join(tmpdir(), `d-connect-daemon-real-${this.spec.type}-`));
    const config = createResolvedConfig(this.dataDir, this.spec, this.agentOptions);
    const loopStore = await createLoopStore(this.dataDir);
    this.loopScheduler = new LoopScheduler(loopStore, new Logger("error"));
    this.runtime = createRuntimeEngine(config, this.state, this.loopScheduler);
    this.socketPath = resolveIpcEndpoint(this.dataDir);
    this.ipcServer = new IpcServer({
      socketPath: this.socketPath,
      runtime: this.runtime,
      loop: this.loopScheduler,
      logger: new Logger("error"),
    });

    await this.runtime.start();
    await this.loopScheduler.start();
    await this.ipcServer.start();
  }

  async stop(): Promise<void> {
    this.loopScheduler?.stop();
    if (this.ipcServer) {
      await this.ipcServer.stop();
    }
    if (this.runtime) {
      await this.runtime.stop();
    }
  }

  async deliverPlatformMessage(content: string, messageId: string, sessionKey = PLATFORM_SESSION_KEY): Promise<void> {
    const platform = this.platform;
    if (!platform) {
      throw new Error("platform missing");
    }
    await platform.deliver(createInboundMessage(content, messageId, sessionKey));
  }
}
