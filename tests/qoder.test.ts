import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/runtime/types.js";
import { Logger } from "../src/logging.js";
import { QoderAdapter } from "../src/adapters/agent/qoder.js";

function buildAskUserQuestionScript(): string {
  const askInput = JSON.stringify({
    questions: [
      {
        question: "请选择 dev 还是 prod？",
        header: "环境选择",
        options: [
          { label: "dev", description: "开发环境" },
          { label: "prod", description: "生产环境" },
        ],
        multiSelect: false,
      },
    ],
  });

  const line = JSON.stringify({
    type: "assistant",
    subtype: "message",
    message: {
      id: "msg-1",
      role: "assistant",
      session_id: "session-1",
      content: [
        {
          id: "tool-1",
          type: "function",
          name: "AskUserQuestion",
          input: askInput,
          finished: true,
        },
        {
          type: "finish",
          reason: "tool_use",
        },
      ],
    },
    session_id: "session-1",
    done: false,
  });

  return `console.log(${JSON.stringify(line)}); setInterval(() => {}, 1000);`;
}

describe("qoder adapter", () => {
  test("stops current run when AskUserQuestion is emitted", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", buildAskUserQuestionScript(), "--", "--output-format", "stream-json"],
      },
      new Logger("error"),
    );

    const session = await adapter.startSession();
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => {
      events.push(event);
    });

    await expect(
      Promise.race([
        session.send("hello").then(() => "done"),
        new Promise<string>((_, reject) => {
          setTimeout(() => {
            reject(new Error("qoder send timed out"));
          }, 3000);
        }),
      ]),
    ).resolves.toBe("done");

    const askEvent = events.find(
      (event) => event.type === "tool_use" && event.toolName === "AskUserQuestion",
    );
    expect(askEvent).toBeTruthy();
    expect(askEvent?.toolInput).toContain("环境选择: 请选择 dev 还是 prod？");
    expect(askEvent?.toolInput).toContain("dev / prod");

    await adapter.stop();
  });

  test("parseOutputLine deduplicates text updates by message id", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-1")) as any;

    const first = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          id: "m-1",
          content: [{ type: "text", text: "hello" }],
        },
      }),
    );

    const second = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          id: "m-1",
          content: [{ type: "text", text: "hello world" }],
        },
      }),
    );

    const repeated = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          id: "m-1",
          content: [{ type: "text", text: "hello world" }],
        },
      }),
    );

    expect(first).toEqual([
      {
        type: "text",
        sessionId: "session-1",
        content: "hello",
      },
    ]);
    expect(second).toEqual([
      {
        type: "text",
        sessionId: "session-1",
        content: " world",
      },
    ]);
    expect(repeated).toEqual([]);
  });

  test("parseOutputLine handles qoder tool results and user message tool_result", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-2")) as any;
    const events = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "user",
        session_id: "session-2",
        message: {
          id: "u-1",
          content: [{ type: "tool_result", tool_use_id: "tool-a", content: "ok" }],
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "tool_result",
        sessionId: "session-2",
        content: "ok",
      },
    ]);
  });

  test("parseOutputLine emits error event on qoder error output", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-3")) as any;
    const events = session.parseOutputLine("stderr", "not-json");

    expect(events.at(0)?.type).toBe("text");
    expect(session).toBeTruthy();
  });

  test("parseOutputLine stops current run for AskUserQuestion and kills child", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-4")) as any;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      return signal === "SIGKILL";
    });
    session.child = { killed: false, kill };

    const events = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-4",
        message: {
          id: "ask-1",
          content: [
            {
              type: "function",
              id: "tool-ask",
              name: "AskUserQuestion",
              input: JSON.stringify({
                questions: [
                  {
                    question: "继续吗？",
                    options: [{ label: "yes" }, { label: "no" }],
                  },
                ],
              }),
            },
          ],
        },
      }),
    );

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_use",
          toolName: "AskUserQuestion",
        }),
      ]),
    );
  });

  test("parseOutputLine dedupes transient messages without ids", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );
    const session = (await adapter.startSession("session-5")) as any;

    const first = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-5",
        message: {
          content: [{ type: "text", text: "stream" }],
        },
      }),
    );

    const duplicated = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-5",
        message: {
          content: [{ type: "text", text: "stream" }],
        },
      }),
    );

    expect(first).toEqual([
      {
        type: "text",
        sessionId: "session-5",
        content: "stream",
      },
    ]);
    expect(duplicated).toEqual([]);
  });

  test("parseOutputLine handles system events and result outputs", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-6")) as any;

    const withSession = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "system",
        session_id: "session-6",
      }),
    );
    const withoutSession = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "system",
      }),
    );
    const resultEvent = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "result",
        session_id: "session-6",
        message: {
          content: [{ type: "text", text: "finished" }],
        },
      }),
    );

    expect(withSession).toEqual([
      {
        type: "text",
        sessionId: "session-6",
        content: "",
      },
    ]);
    expect(withoutSession).toEqual([]);
    expect(resultEvent).toEqual([
      {
        type: "result",
        sessionId: "session-6",
        content: "finished",
        done: true,
      },
    ]);
  });

  test("parseOutputLine handles error payload from message field", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-7")) as any;
    const output = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "error",
        message: {
          error: "qoder service failed",
        },
      }),
    );

    expect(output).toEqual([
      {
        type: "error",
        sessionId: undefined,
        content: "qoder service failed",
        done: true,
      },
    ]);
  });

  test("parseOutputLine dedupes repeated tool_result by message id", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-8")) as any;
    const payload = JSON.stringify({
      type: "user",
      session_id: "session-8",
      message: {
        id: "msg-tools",
        content: [{ type: "tool_result", tool_use_id: "tool-a", content: "ok" }],
      },
    });

    const first = session.parseOutputLine("stdout", payload);
    const second = session.parseOutputLine("stdout", payload);

    expect(first).toEqual([
      {
        type: "tool_result",
        sessionId: "session-8",
        content: "ok",
      },
    ]);
    expect(second).toEqual([]);
  });

  test("parseOutputLine handles reasoning entries and unknown text event fallback", async () => {
    const adapter = new QoderAdapter(
      {
        cmd: process.execPath,
        args: ["-e", "0", "--"],
      },
      new Logger("error"),
    );

    const session = (await adapter.startSession("session-9")) as any;

    const thinking = session.parseOutputLine(
      "stdout",
      JSON.stringify({
        type: "assistant",
        session_id: "session-9",
        message: {
          id: "msg-thinking",
          content: [{ type: "reasoning", thinking: "step1" }],
        },
      }),
    );
    const fallback = session.parseOutputLine("stderr", "temporary warning");

    expect(thinking).toEqual([
      {
        type: "thinking",
        sessionId: "session-9",
        content: "step1",
      },
    ]);
    expect(fallback).toEqual([
      {
        type: "text",
        content: "temporary warning",
      },
    ]);
  });
});
