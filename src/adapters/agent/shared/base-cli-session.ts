import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, AgentSession, PermissionResult } from "../../../core/types.js";
import { Logger } from "../../../infra/logging/logger.js";

export interface Invocation {
  cmd: string;
  args: string[];
  stdinPrompt: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

interface LineBufferState {
  value: string;
}

function extractLines(state: LineBufferState, chunk: string): string[] {
  state.value += chunk;
  const parts = state.value.split(/\r?\n/);
  state.value = parts.pop() ?? "";
  return parts.filter((line) => line.trim().length > 0);
}

function flushLines(state: LineBufferState): string[] {
  const line = state.value.trim();
  state.value = "";
  return line.length > 0 ? [line] : [];
}

export abstract class BaseCliSession extends EventEmitter implements AgentSession {
  protected currentId: string;
  protected child?: ChildProcessWithoutNullStreams;
  protected alive = true;
  protected sending = false;
  protected interrupted = false;

  constructor(protected readonly logger: Logger, sessionId?: string) {
    super();
    this.currentId = typeof sessionId === "string" ? sessionId.trim() : "";
  }

  currentSessionId(): string {
    return this.currentId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async respondPermission(_requestId: string, _result: PermissionResult): Promise<void> {
    // v1 integrations do not support interactive permission responses yet.
  }

  protected emitEvents(events: AgentEvent[], transcript: { value: string }, sawResult: { value: boolean }): void {
    for (const event of events) {
      if (event.sessionId) {
        this.currentId = event.sessionId;
      }
      if (event.content && event.content.trim().length > 0) {
        transcript.value += `${event.content}\n`;
      }
      if (event.type === "result") {
        sawResult.value = true;
      }
      this.emit("event", event);
    }
  }

  protected abstract providerName(): string;
  protected abstract buildInvocation(prompt: string, sessionId: string): Invocation;
  protected abstract parseOutputLine(source: "stdout" | "stderr", line: string): AgentEvent[];

  protected async runOnce(prompt: string, sessionId: string): Promise<void> {
    const invocation = this.buildInvocation(prompt, sessionId);
    const childCwd = invocation.cwd ?? process.cwd();
    const childEnv = {
      ...process.env,
      ...(invocation.env ?? {}),
      PWD: childCwd,
    };
    this.logger.debug(`spawn ${this.providerName()}`, {
      cmd: invocation.cmd,
      args: invocation.args,
    });

    const child = spawn(invocation.cmd, invocation.args, {
      cwd: childCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    if (invocation.stdinPrompt) {
      child.stdin.write(`${prompt}\n`);
    }
    child.stdin.end();

    const transcript = { value: "" };
    const sawResult = { value: false };
    const stdoutLineBuffer = { value: "" };
    const stderrLineBuffer = { value: "" };
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const onChunk = (source: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      const lines = source === "stdout" ? extractLines(stdoutLineBuffer, text) : extractLines(stderrLineBuffer, text);
      for (const line of lines) {
        const events = this.parseOutputLine(source, line);
        this.emitEvents(events, transcript, sawResult);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      onChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      onChunk("stderr", chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        for (const line of flushLines(stdoutLineBuffer)) {
          const events = this.parseOutputLine("stdout", line);
          this.emitEvents(events, transcript, sawResult);
        }
        for (const line of flushLines(stderrLineBuffer)) {
          const events = this.parseOutputLine("stderr", line);
          this.emitEvents(events, transcript, sawResult);
        }

        const fullTranscript = `${stdoutBuffer}\n${stderrBuffer}`.trim();
        if (!sawResult.value && transcript.value.trim().length > 0) {
          this.emitEvents([{ type: "result", content: transcript.value.trim(), done: true }], transcript, sawResult);
        }
        if (fullTranscript.length > 0) {
          this.logger.debug(`${this.providerName()} process output`, {
            sessionId,
            outputPreview: fullTranscript.slice(0, 2000),
          });
        }
        resolve(code ?? 0);
      });
    });

    if (this.interrupted) {
      return;
    }

    if (exitCode && exitCode !== 0) {
      const fullTranscript = `${stdoutBuffer}\n${stderrBuffer}`.trim();
      const details = fullTranscript.length > 0 ? fullTranscript.slice(0, 4000) : "no output";
      throw new Error(`${this.providerName()} process exited with code ${exitCode}: ${details}`);
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
    this.interrupted = false;
    try {
      await this.runOnce(prompt, this.currentId);
    } finally {
      this.child = undefined;
      this.sending = false;
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.child && !this.child.killed) {
      this.interrupted = true;
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.emit("close");
  }
}
