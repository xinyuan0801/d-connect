import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ResolvedAppConfig } from "../src/config/normalize.js";
import { Logger } from "../src/logging.js";
import type { DeliveryTarget, InboundMessage, PlatformAdapter } from "../src/runtime/types.js";
import { RuntimeEngine } from "../src/runtime/engine.js";
import type { ProjectRegistryOptions } from "../src/services/project-registry.js";

const REAL_AGENT_E2E_ENABLED = process.env.D_CONNECT_REAL_AGENT_E2E === "1";
const PROJECT_NAME = "demo";
const PLATFORM_NAME = "test-platform";
const CHAT_ID = "chat-1";
const USER_ID = "user-1";
const SESSION_KEY = `${PLATFORM_NAME}:${CHAT_ID}:${USER_ID}`;
const DELIVERY_TARGET: DeliveryTarget = {
  platform: PLATFORM_NAME,
  payload: {
    chatId: CHAT_ID,
  },
};

interface PersistedSessionSnapshot {
  sessions: Record<
    string,
    {
      agentSessionId: string;
      history: Array<{ role: "user" | "assistant"; content: string }>;
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

interface ResolvedRealAgentSpec extends RealAgentSpec {
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

function parseRequestedAgentTypes(): Set<RealAgentSpec["type"]> {
  const raw = process.env.D_CONNECT_REAL_AGENT_TYPES ?? REAL_AGENT_SPECS.map((spec) => spec.type).join(",");
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is RealAgentSpec["type"] =>
      REAL_AGENT_SPECS.some((spec) => spec.type === value),
    );
  return new Set(values);
}

function commandAvailable(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (typeof result.status === "number") {
    return result.status === 0;
  }
  return false;
}

const REQUESTED_AGENT_TYPES = parseRequestedAgentTypes();
const RESOLVED_REAL_AGENT_SPECS: ResolvedRealAgentSpec[] = REAL_AGENT_SPECS.map((spec) => {
  const override = process.env[spec.cmdEnvVar]?.trim();
  const cmd = override && override.length > 0 ? override : spec.defaultCmd;
  return {
    ...spec,
    cmd,
    available: commandAvailable(cmd),
  };
}).filter((spec) => REQUESTED_AGENT_TYPES.has(spec.type));

class FakePlatform implements PlatformAdapter {
  readonly name = PLATFORM_NAME;
  public handler?: (message: InboundMessage) => Promise<void> | void;
  public replies: Array<{ replyContext: unknown; content: string }> = [];

  async start(handler: (message: InboundMessage) => Promise<void> | void): Promise<void> {
    this.handler = handler;
  }

  async reply(replyContext: unknown, content: string): Promise<void> {
    this.replies.push({ replyContext, content });
  }

  async send(_target: DeliveryTarget, _content: string): Promise<void> {
    // noop
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
}

interface RuntimeFixtureState {
  platforms: FakePlatform[];
}

function createRuntimeFixtureState(): RuntimeFixtureState {
  return {
    platforms: [],
  };
}

function createInboundMessage(content: string, messageId: string): InboundMessage {
  return {
    platform: PLATFORM_NAME,
    sessionKey: SESSION_KEY,
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

function createProjectRegistryOptions(state: RuntimeFixtureState): ProjectRegistryOptions {
  return {
    createPlatformAdapters: () => {
      const platform = new FakePlatform();
      state.platforms.push(platform);
      return [platform];
    },
  };
}

function createResolvedConfig(dataDir: string, spec: ResolvedRealAgentSpec): ResolvedAppConfig {
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
): RuntimeEngine {
  return new RuntimeEngine(config, new Logger("error"), undefined, {
    projectRegistry: createProjectRegistryOptions(state),
  });
}

async function loadPersistedSnapshot(dataDir: string): Promise<PersistedSessionSnapshot> {
  const path = join(dataDir, "sessions", "sessions.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PersistedSessionSnapshot;
}

function combinePlatformReplies(platform: FakePlatform | undefined): string {
  return platform?.replies.map((item) => item.content).join("\n") ?? "";
}

describe.skipIf(!REAL_AGENT_E2E_ENABLED)("runtime real agent integration", () => {
  for (const spec of RESOLVED_REAL_AGENT_SPECS) {
    const run = spec.available ? test : test.skip;

    run(
      `${spec.type} keeps conversation context across runtime restart`,
      async () => {
        const dataDir = await mkdtemp(join(tmpdir(), `d-connect-real-agent-${spec.type}-`));
        const state = createRuntimeFixtureState();
        const config = createResolvedConfig(dataDir, spec);
        const runtime = createRuntimeEngine(config, state);
        const token = `D_CONNECT_E2E_${spec.type.toUpperCase()}_${Date.now()}`;
        const userKey = `${PROJECT_NAME}:${SESSION_KEY}`;

        await runtime.start();

        const firstPlatform = state.platforms[0];
        await firstPlatform?.deliver(
          createInboundMessage(
            [
              "Do not use tools.",
              `Reply with the exact token ${token}.`,
              "You may add no other words.",
            ].join(" "),
            "msg-1",
          ),
        );

        const firstReply = combinePlatformReplies(firstPlatform);
        expect(firstReply).toContain(token);

        await runtime.stop();

        const firstSnapshot = await loadPersistedSnapshot(dataDir);
        const activeSessionId = firstSnapshot.activeSession[userKey];
        expect(activeSessionId).toBeTruthy();
        expect(firstSnapshot.deliveryTargets[userKey]).toEqual(DELIVERY_TARGET);
        expect(firstSnapshot.sessions[activeSessionId ?? ""]?.agentSessionId).toBeTruthy();
        expect(firstSnapshot.sessions[activeSessionId ?? ""]?.history.at(-1)?.content ?? "").toContain(token);

        const restarted = createRuntimeEngine(config, state);
        await restarted.start();

        const secondPlatform = state.platforms[1];
        await secondPlatform?.deliver(
          createInboundMessage(
            [
              "What exact token did you reply with in your previous answer?",
              "Reply with only that token.",
            ].join(" "),
            "msg-2",
          ),
        );

        const secondReply = combinePlatformReplies(secondPlatform);
        expect(secondReply).toContain(token);

        await restarted.stop();

        const secondSnapshot = await loadPersistedSnapshot(dataDir);
        expect(secondSnapshot.activeSession[userKey]).toBe(activeSessionId);
        expect(secondSnapshot.sessions[activeSessionId ?? ""]?.history.length).toBeGreaterThanOrEqual(4);
      },
      240000,
    );
  }
});
