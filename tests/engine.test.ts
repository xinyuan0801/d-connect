import { describe, expect, test } from "vitest";
import { formatResponseFromEvents, splitResponseMessages, summarizeToolMessages } from "../src/runtime/engine.js";
import type { AgentEvent } from "../src/runtime/types.js";

describe("runtime response formatting", () => {
  test("returns the body when no visible events were emitted", () => {
    expect(formatResponseFromEvents("hello", [])).toBe("hello");
    expect(splitResponseMessages("hello", [])).toEqual(["hello"]);
  });

  test("renders tool_use inline in event order", () => {
    const events: AgentEvent[] = [
      {
        type: "text",
        content: "我来帮你搜索今天（2026年3月7日）的新闻。",
      },
      {
        type: "tool_use",
        requestId: "web_search:0",
        toolName: "web_search",
        toolInput: "2026年3月7日 新闻",
      },
      {
        type: "tool_result",
        requestId: "web_search:0",
        content: "Search results returned.",
      },
      {
        type: "text",
        content: "让我再搜索一些更多信息：",
      },
      {
        type: "tool_use",
        requestId: "web_search:1",
        toolName: "web_search",
        toolInput: "2026年3月7日 国际新闻 热点",
      },
      {
        type: "tool_result",
        requestId: "web_search:1",
        content: "Search results returned.",
      },
      {
        type: "text",
        content: "以下是今天（2026年3月7日）的主要新闻总结：",
      },
    ];

    expect(summarizeToolMessages(events)).toEqual([
      "🛠️ web_search\n`2026年3月7日 新闻`",
      "🛠️ web_search\n`2026年3月7日 国际新闻 热点`",
    ]);

    expect(
      formatResponseFromEvents(
        "我来帮你搜索今天（2026年3月7日）的新闻。\n\n让我再搜索一些更多信息：\n\n以下是今天（2026年3月7日）的主要新闻总结：",
        events,
      ),
    ).toBe(
      [
        "我来帮你搜索今天（2026年3月7日）的新闻。",
        "🛠️ web_search\n`2026年3月7日 新闻`",
        "让我再搜索一些更多信息：",
        "🛠️ web_search\n`2026年3月7日 国际新闻 热点`",
        "以下是今天（2026年3月7日）的主要新闻总结：",
      ].join("\n\n"),
    );

    expect(
      splitResponseMessages(
        "我来帮你搜索今天（2026年3月7日）的新闻。\n\n让我再搜索一些更多信息：\n\n以下是今天（2026年3月7日）的主要新闻总结：",
        events,
      ),
    ).toEqual([
      "我来帮你搜索今天（2026年3月7日）的新闻。",
      "🛠️ web_search\n`2026年3月7日 新闻`",
      "让我再搜索一些更多信息：",
      "🛠️ web_search\n`2026年3月7日 国际新闻 热点`",
      "以下是今天（2026年3月7日）的主要新闻总结：",
    ]);
  });

  test("keeps the post-tool warning after ordered event rendering", () => {
    const events: AgentEvent[] = [
      {
        type: "text",
        content: "我来帮你搜索今天的新闻。",
      },
      {
        type: "tool_use",
        requestId: "web_search:0",
        toolName: "web_search",
        toolInput: "2026年3月7日 新闻",
      },
      {
        type: "tool_result",
        requestId: "web_search:0",
        content: "Search results returned.",
      },
    ];

    expect(
      formatResponseFromEvents(
        "我来帮你搜索今天的新闻。\n\niflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。",
        events,
      ),
    ).toBe(
      [
        "我来帮你搜索今天的新闻。",
        "🛠️ web_search\n`2026年3月7日 新闻`",
        "iflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。",
      ].join("\n\n"),
    );

    expect(
      splitResponseMessages(
        "我来帮你搜索今天的新闻。\n\niflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。",
        events,
      ),
    ).toEqual([
      "我来帮你搜索今天的新闻。",
      "🛠️ web_search\n`2026年3月7日 新闻`",
      "iflow 在工具执行后结束了当前轮次，但没有产出最终回复；已保留底层续聊状态。",
    ]);
  });

  test("shows running then done when a tool call spans across text events", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        requestId: "shell:0",
        toolName: "run_shell_command",
        toolInput: "echo hello",
      },
      {
        type: "text",
        content: "正在处理命令执行结果。",
      },
      {
        type: "tool_result",
        requestId: "shell:0",
        content: "ok",
      },
    ];

    expect(splitResponseMessages("正在处理命令执行结果。", events)).toEqual([
      "🛠️ run_shell_command\n`echo hello`",
      "正在处理命令执行结果。",
    ]);
  });

  test("renders Agent tool calls using structured summary instead of truncated json", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        toolName: "Agent",
        toolInput: "{\"description\":\"Explore codebase structure\",\"prompt\":\"Explore this codebase to understand its architecture and key components\"}",
        toolInputRaw: {
          subagent_type: "Explore",
          description: "Explore codebase structure",
          prompt: "Explore this codebase to understand its architecture and key components",
        },
      },
    ];

    expect(splitResponseMessages("done", events)).toEqual([
      "🛠️ Agent\n`Explore | Explore codebase structure`",
    ]);
  });

  test("wraps tool input safely when the argument contains backticks", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_use",
        toolName: "run_shell_command",
        toolInput: "printf '`hello`'",
      },
    ];

    expect(splitResponseMessages("done", events)).toEqual([
      "🛠️ run_shell_command\n``printf '`hello`'``",
    ]);
  });
});
