import { beforeEach, describe, expect, test, vi } from "vitest";
import { defaultInitAnswers } from "../src/config/init.js";
import {
  buildWizardOverview,
  buildWizardSteps,
  buildStepContext,
  runConfigWizard,
  runInitTui,
} from "../src/config/init-tui.js";

type RenderMode = "submit" | "cancel" | "none";

let mode: RenderMode = "none";
let submitDraft: Record<string, string> = {};

vi.mock("ink", async () => {
  const actual = await vi.importActual<any>("ink");
  return {
    ...actual,
    render: vi.fn((element: { props: { onSubmit: (answers: unknown) => void; onCancel: (error: Error) => void } }) => {
      if (mode === "submit") {
        queueMicrotask(() => {
          element.props.onSubmit({
            ...submitDraft,
            projectName: "demo-project",
          });
        });
      }

      if (mode === "cancel") {
        queueMicrotask(() => {
          element.props.onCancel(new Error("用户取消"));
        });
      }

      return {
        unmount: vi.fn(),
      };
    }),
    useApp: vi.fn(() => ({
      exit: vi.fn(),
    })),
    useInput: vi.fn(),
  };
});

function buildOptions(overrides: Partial<{
  promptDingTalkCredentials: boolean;
  promptDiscordCredentials: boolean;
  mode: "init" | "add";
  overwritten: boolean;
}> = {}) {
  const defaults = defaultInitAnswers({
    cwd: "/repo/workdir",
  });

  return {
    defaults,
    configPath: "/repo/config.json",
    overwritten: false,
    stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    stdout: { isTTY: true, columns: 100 } as unknown as NodeJS.WriteStream,
    deriveProjectName: (workDir: string, fallback?: string) => {
      const segments = workDir.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? fallback ?? "project";
    },
    ...overrides,
  };
}

describe("init-config tui runtime", () => {
  beforeEach(() => {
    mode = "none";
    submitDraft = {};
  });

  test("runConfigWizard requires tty stdin and stdout", async () => {
    await expect(
      runConfigWizard({
        ...buildOptions(),
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stdout: { isTTY: true } as unknown as NodeJS.WriteStream,
      }),
    ).rejects.toThrow("交互式配置向导需要 TTY");
  });

  test("runConfigWizard resolves on onSubmit and runInitTui delegates", async () => {
    mode = "submit";
    submitDraft = {
      platformType: "discord",
      discordBotToken: "bot-token",
      dingtalkClientId: "",
      dingtalkClientSecret: "",
      dingtalkProcessingNotice: "处理中...",
      agentType: "codex",
      agentWorkDirMode: "current",
      allowFromMode: "custom",
    };

    const options = buildOptions();
    const answers = await runConfigWizard(options);
    const initAnswers = await runInitTui(options);

    expect(answers.platformType).toBe("discord");
    expect(initAnswers.platformType).toBe("discord");
    expect(answers.agentType).toBe("codex");
  });

  test("runConfigWizard rejects on cancel callback", async () => {
    mode = "cancel";
    await expect(runConfigWizard(buildOptions())).rejects.toThrow("用户取消");
  });

  test("buildWizardSteps covers both select and text hint branches", () => {
    const defaultSteps = buildWizardSteps(
      {
        agentWorkDirMode: "custom",
        agentWorkDir: "/tmp/custom-agent-workdir",
      } as any,
      buildOptions({ mode: "add" }),
    );

    const confirmStep = defaultSteps.find((step) => step.id === "confirm");
    const workdirStep = defaultSteps.find((step) => step.id === "agentWorkDir");

    expect(confirmStep?.kind).toBe("select");
    expect(confirmStep?.hint).toContain("向已有配置追加新的项目配置");
    expect(workdirStep?.kind).toBe("text");
    expect(workdirStep?.hint).toContain("绝对路径");
  });

  test("buildWizardOverview adds alternative credentials branch when prompt credentials disabled", () => {
    const options = buildOptions({
      promptDingTalkCredentials: false,
      mode: "add",
      overwritten: true,
    });

    const overview = buildWizardOverview({ platformType: "dingtalk" }, options);

    expect(
      overview.find((item) => item.label === "platform.options.credentials")?.value,
    ).toBe("复用已有 DingTalk 凭证");
    expect(overview.some((item) => item.label === "platform.options.botToken")).toBe(false);
    expect(overview.find((item) => item.label === "write mode")?.value).toBe("向已有配置追加 project");
  });

  test("buildWizardSteps and buildStepContext branch for Discord without token prompt", () => {
    const options = buildOptions({ promptDiscordCredentials: false });

    const steps = buildWizardSteps({ platformType: "discord" }, options);
    expect(steps.map((step) => step.id)).not.toContain("discordBotToken");
    expect(steps.some((step) => step.id === "discordRequireMention")).toBe(true);

    const context = buildStepContext("discordRequireMention", { discordRequireMention: "false" }, options);
    expect(context.at(0)).toEqual(
      expect.objectContaining({
        label: "platform.options.requireMention",
        value: "false",
      }),
    );
  });
});
