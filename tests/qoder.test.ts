import { describe, expect, test } from "vitest";
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
      } as any,
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
});
