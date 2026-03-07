import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Logger } from "../../logging.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelSwitchable,
  ModeSwitchable,
  PermissionResult,
} from "../../runtime/types.js";
import { parseAgentLine } from "./parsers.js";

export type AgentType = "claudecode" | "codex" | "qoder" | "opencode" | "iflow";

export interface BaseAgentOptions {
  cmd?: string;
  args?: string[];
  workDir?: string;
  mode?: string;
  model?: string;
  env?: Record<string, string>;
  promptArg?: string;
  stdinPrompt?: boolean;
}

interface Invocation {
  cmd: string;
  args: string[];
  stdinPrompt: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

function splitLines(buffer: string): string[] {
  return buffer.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

class CliAgentSession extends EventEmitter implements AgentSession {
  private currentId: string;
  private child?: ChildProcessWithoutNullStreams;
  private alive = true;
  private sending = false;

  constructor(
    private readonly agentType: AgentType,
    private readonly logger: Logger,
    private readonly buildInvocation: (prompt: string, sessionId: string) => Invocation,
    sessionId?: string,
  ) {
    super();
    this.currentId = sessionId && sessionId.length > 0 ? sessionId : randomUUID();
  }

  currentSessionId(): string {
    return this.currentId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // One-shot CLI process mode: permission prompts are best-effort and not interactive in v1.
  }

  private emitEvents(events: AgentEvent[], structuredSeenRef: { value: boolean }, transcript: { value: string }, sawResult: { value: boolean }): void {
    for (const event of events) {
      if (event.sessionId) {
        this.currentId = event.sessionId;
      }
      if (event.type === "result") {
        sawResult.value = true;
      }
      if (event.content && event.content.trim().length > 0) {
        transcript.value += `${event.content}\n`;
      }
      this.emit("event", event);
    }
  }

  async send(prompt: string): Promise<void> {
    if (!this.alive) {
      throw new Error("agent session is closed");
    }
    if (this.sending) {
      throw new Error("agent session is busy");
    }

    this.sending = true;

    try {
      const invocation = this.buildInvocation(prompt, this.currentId);
      this.logger.debug("spawn agent", {
        cmd: invocation.cmd,
        args: invocation.args,
      });

      const child = spawn(invocation.cmd, invocation.args, {
        cwd: invocation.cwd ?? process.cwd(),
        env: { ...process.env, ...(invocation.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      if (invocation.stdinPrompt) {
        child.stdin.write(`${prompt}\n`);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      let stdoutBuffer = "";
      let stderrBuffer = "";
      const structuredSeenRef = { value: false };
      const transcript = { value: "" };
      const sawResult = { value: false };

      const onChunk = (chunk: Buffer): void => {
        const lines = splitLines(chunk.toString("utf8"));
        for (const line of lines) {
          const outcome = parseAgentLine(this.agentType, line);
          if (outcome.structured) {
            structuredSeenRef.value = true;
          }
          this.emitEvents(outcome.events, structuredSeenRef, transcript, sawResult);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        onChunk(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
        onChunk(chunk);
      });

      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          const fullTranscript = `${stdoutBuffer}\n${stderrBuffer}`.trim();
          if (!sawResult.value) {
            if (this.agentType === "iflow" && !structuredSeenRef.value && fullTranscript.length > 0) {
              this.emit("event", {
                type: "result",
                content: fullTranscript,
                done: true,
              } satisfies AgentEvent);
              sawResult.value = true;
            } else if (transcript.value.trim().length > 0) {
              this.emit("event", {
                type: "result",
                content: transcript.value.trim(),
                done: true,
              } satisfies AgentEvent);
              sawResult.value = true;
            }
          }

          if (code && code !== 0) {
            const details = fullTranscript.length > 0 ? fullTranscript.slice(0, 4000) : "no output";
            const errMsg = `agent process exited with code ${code}: ${details}`;
            this.logger.error("agent process failed", {
              code,
              details,
            });
            this.emit("event", {
              type: "error",
              content: `${errMsg}: ${fullTranscript || "no output"}`,
              done: true,
            } satisfies AgentEvent);
            reject(new Error(errMsg));
            return;
          }
          resolve();
        });
      });
    } finally {
      this.child = undefined;
      this.sending = false;
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.emit("close");
  }
}

export class BaseCliAgentAdapter implements AgentAdapter, ModeSwitchable, ModelSwitchable {
  readonly name: string;

  private readonly sessions = new Set<CliAgentSession>();
  private modeValue: string;
  private modelValue: string;

  constructor(
    private readonly agentType: AgentType,
    private readonly options: BaseAgentOptions,
    private readonly logger: Logger,
  ) {
    this.name = agentType;
    this.modeValue = options.mode ?? "default";
    this.modelValue = options.model ?? "";
  }

  supportedModes(): string[] {
    return ["default", "plan", this.modeValue].filter((v, idx, arr) => arr.indexOf(v) === idx);
  }

  setMode(mode: string): void {
    this.modeValue = mode;
  }

  getMode(): string {
    return this.modeValue;
  }

  setModel(model: string): void {
    this.modelValue = model;
  }

  getModel(): string {
    return this.modelValue;
  }

  private defaultCommand(): string {
    if (this.options.cmd && this.options.cmd.length > 0) {
      return this.options.cmd;
    }

    const byType: Record<AgentType, string> = {
      claudecode: "claude",
      codex: "codex",
      qoder: "qoder",
      opencode: "opencode",
      iflow: "iflow",
    };
    return byType[this.agentType];
  }

  private buildPromptArgs(prompt: string): { args: string[]; stdinPrompt: boolean } {
    const extraArgs = Array.isArray(this.options.args) ? [...this.options.args] : [];

    const promptArg = typeof this.options.promptArg === "string" ? this.options.promptArg : undefined;
    if (promptArg) {
      return {
        args: [...extraArgs, promptArg, prompt],
        stdinPrompt: false,
      };
    }

    if (this.options.stdinPrompt) {
      return {
        args: extraArgs,
        stdinPrompt: true,
      };
    }

    switch (this.agentType) {
      case "codex":
        return { args: [...extraArgs, "exec", prompt], stdinPrompt: false };
      case "opencode":
        return { args: [...extraArgs, "run", prompt], stdinPrompt: false };
      case "claudecode":
      case "qoder":
        return { args: [...extraArgs, "-p", prompt], stdinPrompt: false };
      case "iflow":
      default:
        return { args: [...extraArgs, "--prompt", prompt], stdinPrompt: false };
    }
  }

  async startSession(sessionId?: string): Promise<AgentSession> {
    const cmd = this.defaultCommand();

    const session = new CliAgentSession(
      this.agentType,
      this.logger.child(`session:${sessionId ?? "new"}`),
      (prompt: string) => {
        const promptPlan = this.buildPromptArgs(prompt);

        return {
          cmd,
          args: promptPlan.args,
          stdinPrompt: promptPlan.stdinPrompt,
          cwd: this.options.workDir,
          env: this.options.env,
        };
      },
      sessionId,
    );

    this.sessions.add(session);
    session.once("close", () => {
      this.sessions.delete(session);
    });
    return session;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) {
      await session.close();
    }
    this.sessions.clear();
  }
}
