import { describe, expect, test } from "vitest";
import {
  bannerLines,
  buildStepContext,
  buildWizardOverview,
  buildWizardSteps,
  formatWizardProgress,
  parseHighlightedText,
  resolveWizardLayout,
  stepMood,
} from "../src/config/init-tui.js";
import { defaultInitAnswers } from "../src/config/init.js";

describe("init tui helpers", () => {
  test("bannerLines returns stable title copy", () => {
    const first = bannerLines();
    expect(first).toEqual([
      "      _                                       _   ",
      "   __| |       ___ ___  _ __  _ __   ___  ___| |_ ",
      "  / _` |_____ / __/ _ \\| '_ \\| '_ \\ / _ \\/ __| __|",
      " | (_| |_____| (_| (_) | | | | | | |  __/ (__| |_ ",
      "  \\__,_|      \\___\\___/|_| |_|_| |_|\\___|\\___|\\__|",
    ]);

    first[0] = "mutated";
    expect(bannerLines()[0]).toBe("      _                                       _   ");
  });

  test("formatWizardProgress renders bounded progress bar", () => {
    expect(formatWizardProgress(3, 6, 10)).toBe("[█████░░░░░] 50%");
    expect(formatWizardProgress(-1, 4, 8)).toBe("[░░░░░░░░] 0%");
    expect(formatWizardProgress(10, 4, 8)).toBe("[████████] 100%");
    expect(formatWizardProgress(1, 0, 2)).toBe("[████] 100%");
  });

  test("stepMood maps wizard sections", () => {
    expect(stepMood("agentType")).toContain("Agent");
    expect(stepMood("agentWorkDir")).toContain("Agent");
    expect(stepMood("dingtalkClientId")).toContain("平台");
    expect(stepMood("confirm")).toContain("最终");
    expect(stepMood("logLevel")).toContain("运行时");
  });

  test("resolveWizardLayout switches between split and stacked", () => {
    expect(resolveWizardLayout(120)).toBe("split");
    expect(resolveWizardLayout(80)).toBe("stacked");
    expect(resolveWizardLayout(undefined)).toBe("split");
  });

  test("parseHighlightedText preserves highlighted fragments", () => {
    expect(parseHighlightedText("按 {highlight}Enter{/highlight} 确认")).toEqual([
      { text: "按 ", highlight: false },
      { text: "Enter", highlight: true },
      { text: " 确认", highlight: false },
    ]);
  });

  test("buildWizardOverview derives preview values and masks secret preview", () => {
    const defaults = defaultInitAnswers({ cwd: "/repo/workdir" });
    const options = {
      defaults,
      configPath: "/repo/config.json",
      overwritten: false,
      stdin: process.stdin,
      stdout: process.stdout,
      deriveProjectName: (workDir: string, fallback?: string) => {
        const segments = workDir.split("/").filter(Boolean);
        return segments[segments.length - 1] ?? fallback ?? "project";
      },
    };

    const overview = buildWizardOverview(
      {
        agentWorkDirMode: "custom",
        agentWorkDir: "/repo/services/api",
        dingtalkClientSecret: "supersecret",
      },
      options,
    );

    expect(overview[0]).toEqual({
      label: "项目名称",
      value: "api",
      tone: "accent",
    });

    const secretItem = overview.find((item) => item.label === "platform.options.clientSecret");
    expect(secretItem?.value).toMatch(/^su•+et$/);
    expect(secretItem?.value).not.toContain("persec");
  });

  test("buildStepContext focuses current step impact", () => {
    const defaults = defaultInitAnswers({ cwd: "/repo/workdir" });
    const options = {
      defaults,
      configPath: "/repo/config.json",
      overwritten: true,
      stdin: process.stdin,
      stdout: process.stdout,
      deriveProjectName: (workDir: string, fallback?: string) => {
        const segments = workDir.split("/").filter(Boolean);
        return segments[segments.length - 1] ?? fallback ?? "project";
      },
    };

    expect(buildStepContext("agentWorkDir", { agentWorkDir: "/repo/mobile/app" }, options)).toEqual([
      {
        label: "项目名称",
        value: "workdir",
        tone: "accent",
      },
      {
        label: "agent.options.workDir",
        value: "/repo/workdir",
      },
      {
        label: "config target",
        value: "/repo/config.json",
        tone: "muted",
      },
    ]);

    expect(buildStepContext("agentWorkDir", { agentWorkDirMode: "custom", agentWorkDir: "/repo/mobile/app" }, options)).toEqual([
      {
        label: "项目名称",
        value: "app",
        tone: "accent",
      },
      {
        label: "agent.options.workDir",
        value: "/repo/mobile/app",
      },
      {
        label: "config target",
        value: "/repo/config.json",
        tone: "muted",
      },
    ]);
  });

  test("buildWizardSteps prompts for agent choice, workdir, and DingTalk credentials", () => {
    const defaults = defaultInitAnswers({ cwd: "/repo/workdir" });
    const options = {
      defaults,
      configPath: "/repo/config.json",
      overwritten: false,
      stdin: process.stdin,
      stdout: process.stdout,
      deriveProjectName: (workDir: string, fallback?: string) => fallback ?? workDir,
    };

    expect(buildWizardSteps({}, options).map((step) => step.id)).toEqual([
      "agentType",
      "agentWorkDirMode",
      "dingtalkClientId",
      "dingtalkClientSecret",
      "confirm",
    ]);

    const workDirModeStep = buildWizardSteps({}, options).find((step) => step.id === "agentWorkDirMode");
    expect(workDirModeStep?.title).toBe("工作目录");
    expect(workDirModeStep?.label).toBe("Agent 应该在哪个目录里运行？");
    expect(workDirModeStep?.hint).toContain("当前目录");
    expect(workDirModeStep?.details).toEqual([
      "这个目录会决定 Agent 后续读取文件、执行命令时的默认位置。",
      "通常填写你希望接入的仓库根目录。",
    ]);
    expect(workDirModeStep?.options?.map((option) => option.label)).toEqual([
      "当前目录作为 Agent 工作目录",
      "手动输入其他目录",
    ]);

    const clientIdStep = buildWizardSteps({}, options).find((step) => step.id === "dingtalkClientId");
    expect(clientIdStep?.defaultValue).toBe("");
    expect(clientIdStep?.placeholder).toBe("例如 dingxxxx");

    const clientSecretStep = buildWizardSteps({}, options).find((step) => step.id === "dingtalkClientSecret");
    expect(clientSecretStep?.defaultValue).toBe("");
    expect(clientSecretStep?.placeholder).toBe("请输入 client secret");
  });

  test("buildWizardSteps adds path input only when custom workdir is selected", () => {
    const defaults = defaultInitAnswers({ cwd: "/repo/workdir" });
    const options = {
      defaults,
      configPath: "/repo/config.json",
      overwritten: false,
      stdin: process.stdin,
      stdout: process.stdout,
      deriveProjectName: (workDir: string, fallback?: string) => fallback ?? workDir,
    };

    const steps = buildWizardSteps({ agentWorkDirMode: "custom" }, options);
    expect(steps.map((step) => step.id)).toEqual([
      "agentType",
      "agentWorkDirMode",
      "agentWorkDir",
      "dingtalkClientId",
      "dingtalkClientSecret",
      "confirm",
    ]);

    const workDirInputStep = steps.find((step) => step.id === "agentWorkDir");
    expect(workDirInputStep?.label).toBe("请输入要作为 Agent 工作目录的路径");
    expect(workDirInputStep?.hint).toContain("绝对路径");
    expect(workDirInputStep?.placeholder).toBe("例如 ./backend 或 /path/to/repo");
    expect(workDirInputStep?.defaultValue).toBe("");
  });

  test("buildWizardSteps omits DingTalk credential prompts when defaults are reused", () => {
    const defaults = defaultInitAnswers({ cwd: "/repo/workdir" });
    const options = {
      defaults,
      configPath: "/repo/config.json",
      overwritten: true,
      stdin: process.stdin,
      stdout: process.stdout,
      deriveProjectName: (workDir: string, fallback?: string) => fallback ?? workDir,
      mode: "add" as const,
      promptDingTalkCredentials: false,
    };

    expect(buildWizardSteps({}, options).map((step) => step.id)).toEqual([
      "agentType",
      "agentWorkDirMode",
      "confirm",
    ]);

    expect(buildWizardOverview({}, options).some((item) => item.label === "platform.options.credentials")).toBe(true);
  });
});
