import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { InitAnswers } from "./init.js";

type AgentType = InitAnswers["agentType"];
type LogLevel = InitAnswers["logLevel"];
type WizardMode = "init" | "add";
type HighlightedPart = { text: string; highlight: boolean };
type OverviewTone = "normal" | "accent" | "muted" | "warning";
type WorkDirMode = "current" | "custom";

export interface RunConfigWizardOptions {
  defaults: InitAnswers;
  configPath: string;
  overwritten: boolean;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  deriveProjectName: (workDir: string, fallback?: string) => string;
  mode?: WizardMode;
  promptDingTalkCredentials?: boolean;
}

interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

interface WizardStep {
  id: string;
  kind: "text" | "select";
  title: string;
  label: string;
  hint?: string;
  details?: string[];
  placeholder?: string;
  required: boolean;
  defaultValue: string;
  options?: SelectOption[];
}

interface WizardOverviewItem {
  label: string;
  value: string;
  tone?: OverviewTone;
}

type WizardDraft = Record<string, string>;

interface InitWizardAppProps extends RunConfigWizardOptions {
  onSubmit: (answers: InitAnswers) => void;
  onCancel: (error: Error) => void;
}

const WIZARD_BANNER_LINES = [
  "      _                                       _   ",
  "   __| |       ___ ___  _ __  _ __   ___  ___| |_ ",
  "  / _` |_____ / __/ _ \\| '_ \\| '_ \\ / _ \\/ __| __|",
  " | (_| |_____| (_| (_) | | | | | | |  __/ (__| |_ ",
  "  \\__,_|      \\___\\___/|_| |_|_| |_|\\___|\\___|\\__|",
];

const WIZARD_COLORS = {
  accent: "#7ee787",
  text: "#f0f6fc",
  muted: "#8b949e",
  border: "#30363d",
  warning: "#d29922",
  danger: "#f85149",
} as const;

function asAgentType(value: string): AgentType {
  if (value === "qoder" || value === "iflow") {
    return value;
  }
  return "claudecode";
}

function asLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function asWorkDirMode(value: string | undefined): WorkDirMode {
  if (value === "custom") {
    return "custom";
  }
  return "current";
}

function defaultAgentCommand(agentType: AgentType): string {
  if (agentType === "qoder") {
    return "qodercli";
  }
  if (agentType === "iflow") {
    return "iflow";
  }
  return "claude";
}

function defaultAgentModel(agentType: AgentType): string {
  if (agentType === "claudecode") {
    return "claude-sonnet-4-20250514";
  }
  return "";
}

function isSensitiveStep(stepId: string): boolean {
  return stepId.toLowerCase().includes("secret");
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "待填写";
  }

  if (trimmed.length <= 4) {
    return "•".repeat(trimmed.length);
  }

  return `${trimmed.slice(0, 2)}${"•".repeat(Math.min(trimmed.length - 4, 8))}${trimmed.slice(-2)}`;
}

function displayStepValue(stepId: string, value: string): string {
  if (!isSensitiveStep(stepId)) {
    return value;
  }
  return value.length > 0 ? "•".repeat(Math.min(value.length, 24)) : "";
}

function divider(width: number): string {
  return "─".repeat(Math.max(width, 12));
}

function toneColor(tone: OverviewTone | undefined): string {
  if (tone === "accent") {
    return WIZARD_COLORS.accent;
  }
  if (tone === "warning") {
    return WIZARD_COLORS.warning;
  }
  if (tone === "muted") {
    return WIZARD_COLORS.muted;
  }
  return WIZARD_COLORS.text;
}

export function bannerLines(): string[] {
  return [...WIZARD_BANNER_LINES];
}

export function formatWizardProgress(currentStep: number, totalSteps: number, width = 18): string {
  const safeTotal = totalSteps > 0 ? totalSteps : 1;
  const safeCurrent = Math.min(Math.max(currentStep, 0), safeTotal);
  const safeWidth = Math.max(width, 4);
  const filled = Math.round((safeCurrent / safeTotal) * safeWidth);
  const percent = Math.round((safeCurrent / safeTotal) * 100);
  return `[${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}] ${percent}%`;
}

export function stepMood(stepId: string): string {
  if (stepId === "confirm") {
    return "最终确认";
  }

  if (stepId.startsWith("agent")) {
    return "Agent 配置";
  }

  if (stepId.startsWith("dingtalk") || stepId.startsWith("feishu") || stepId === "platformType" || stepId === "allowFrom") {
    return "平台接入";
  }

  return "运行时默认值";
}

export function resolveWizardLayout(columns?: number): WizardLayout {
  const safeColumns = typeof columns === "number" && columns > 0 ? columns : 100;
  return safeColumns >= 96 ? "split" : "stacked";
}

export function parseHighlightedText(input: string): HighlightedPart[] {
  const parts: HighlightedPart[] = [];
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g;
  let lastIndex = 0;

  for (const match of input.matchAll(regex)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        text: input.slice(lastIndex, start),
        highlight: false,
      });
    }

    parts.push({
      text: match[1] ?? "",
      highlight: true,
    });

    lastIndex = start + match[0].length;
  }

  if (lastIndex < input.length) {
    parts.push({
      text: input.slice(lastIndex),
      highlight: false,
    });
  }

  return parts;
}

function draftToAnswers(draft: WizardDraft, options: RunConfigWizardOptions): InitAnswers {
  const agentType = asAgentType(draft.agentType ?? options.defaults.agentType);
  const workDirMode = asWorkDirMode(draft.agentWorkDirMode);
  const agentWorkDir =
    workDirMode === "custom"
      ? (draft.agentWorkDir ?? options.defaults.agentWorkDir).trim()
      : options.defaults.agentWorkDir.trim();
  const projectName = options.deriveProjectName(agentWorkDir, options.defaults.projectName);

  return {
    projectName,
    logLevel: asLogLevel(draft.logLevel ?? options.defaults.logLevel),
    loopSilent: parseBoolean(draft.loopSilent, options.defaults.loopSilent),
    agentType,
    agentCmd: (draft.agentCmd ?? defaultAgentCommand(agentType)).trim(),
    agentWorkDir,
    agentMode: (draft.agentMode ?? options.defaults.agentMode).trim(),
    agentModel: draft.agentModel ?? defaultAgentModel(agentType),
    platformType: "dingtalk",
    allowFrom: (draft.allowFrom ?? options.defaults.allowFrom).trim(),
    dingtalkClientId: (draft.dingtalkClientId ?? options.defaults.dingtalkClientId).trim(),
    dingtalkClientSecret: (draft.dingtalkClientSecret ?? options.defaults.dingtalkClientSecret).trim(),
    dingtalkProcessingNotice: (draft.dingtalkProcessingNotice ?? options.defaults.dingtalkProcessingNotice).trim(),
    feishuAppId: (draft.feishuAppId ?? options.defaults.feishuAppId).trim(),
    feishuAppSecret: (draft.feishuAppSecret ?? options.defaults.feishuAppSecret).trim(),
    feishuGroupReplyAll: parseBoolean(draft.feishuGroupReplyAll, options.defaults.feishuGroupReplyAll),
    feishuReactionEmoji: (draft.feishuReactionEmoji ?? options.defaults.feishuReactionEmoji).trim(),
  };
}

function modeVerb(mode: WizardMode): string {
  return mode === "add" ? "追加" : "写入";
}

function cancelMessage(mode: WizardMode): string {
  return mode === "add" ? "追加项目已取消" : "初始化已取消";
}

function modeSummary(mode: WizardMode, overwritten: boolean): { label: string; tone: OverviewTone } {
  if (mode === "add") {
    return {
      label: "向已有配置追加 project",
      tone: "warning",
    };
  }

  if (overwritten) {
    return {
      label: "覆盖已有 config.json",
      tone: "warning",
    };
  }

  return {
    label: "创建新的 config.json",
    tone: "muted",
  };
}

function buildWizardTip(step: WizardStep, mode: WizardMode): string {
  if (step.id === "confirm") {
    return mode === "add"
      ? "确认后会立即 {highlight}追加新的项目配置{/highlight} 并退出向导。"
      : "确认后会立即 {highlight}写入 config.json{/highlight} 并退出向导。";
  }

  if (step.kind === "select") {
    if (step.id === "agentWorkDirMode") {
      return "选择 {highlight}当前目录{/highlight} 可直接继续；选择 {highlight}手动输入{/highlight} 会进入下一步。";
    }
    return "使用 {highlight}↑/↓{/highlight} 或 {highlight}j/k{/highlight} 切换选项，按 {highlight}Enter{/highlight} 确认。";
  }

  if (step.id === "agentWorkDir") {
    return "支持输入 {highlight}绝对路径{/highlight} 或 {highlight}相对路径{/highlight}，按 {highlight}Enter{/highlight} 保存。";
  }

  return "留空后直接按 {highlight}Enter{/highlight} 会回退到 {highlight}默认值{/highlight}。";
}

function keyHint(step: WizardStep): string {
  if (step.kind === "select") {
    return "↑/↓ 或 j/k 切换 · Enter/→ 确认 · ← 返回 · Esc / Ctrl+C 退出";
  }

  return "输入内容 · Enter 确认 · Backspace 删除 · ← 返回 · Esc / Ctrl+C 退出";
}

export function buildWizardOverview(draft: WizardDraft, options: RunConfigWizardOptions): WizardOverviewItem[] {
  const answers = draftToAnswers(draft, options);
  const mode = options.mode ?? "init";
  const promptDingTalkCredentials = options.promptDingTalkCredentials ?? true;
  const modeLine = modeSummary(mode, options.overwritten);

  const items: WizardOverviewItem[] = [
    {
      label: "项目名称",
      value: answers.projectName,
      tone: "accent",
    },
    {
      label: "agent.type",
      value: answers.agentType,
    },
    {
      label: "agent.options.cmd",
      value: answers.agentCmd,
    },
    {
      label: "agent.options.workDir",
      value: answers.agentWorkDir,
    },
    {
      label: "platform.type",
      value: answers.platformType,
    },
  ];

  if (promptDingTalkCredentials) {
    items.push(
      {
        label: "platform.options.clientId",
        value: answers.dingtalkClientId.length > 0 ? answers.dingtalkClientId : "待填写",
        tone: answers.dingtalkClientId.length > 0 ? "normal" : "warning",
      },
      {
        label: "platform.options.clientSecret",
        value: maskSecret(answers.dingtalkClientSecret),
        tone: answers.dingtalkClientSecret.length > 0 ? "accent" : "warning",
      },
    );
  } else {
    items.push({
      label: "platform.options.credentials",
      value: "复用已有 DingTalk 凭证",
      tone: "accent",
    });
  }

  items.push(
    {
      label: "config target",
      value: options.configPath,
      tone: "muted",
    },
    {
      label: "write mode",
      value: modeLine.label,
      tone: modeLine.tone,
    },
  );

  return items;
}

export function buildStepContext(stepId: string, draft: WizardDraft, options: RunConfigWizardOptions): WizardOverviewItem[] {
  const answers = draftToAnswers(draft, options);
  const promptDingTalkCredentials = options.promptDingTalkCredentials ?? true;

  if (stepId === "agentType") {
    return [
      {
        label: "agent.options.cmd",
        value: answers.agentCmd,
      },
      {
        label: "agent.options.model",
        value: answers.agentModel.length > 0 ? answers.agentModel : "(empty)",
        tone: answers.agentModel.length > 0 ? "normal" : "muted",
      },
      {
        label: "platform.type",
        value: answers.platformType,
        tone: "muted",
      },
    ];
  }

  if (stepId === "agentWorkDir") {
    return [
      {
        label: "项目名称",
        value: answers.projectName,
        tone: "accent",
      },
      {
        label: "agent.options.workDir",
        value: answers.agentWorkDir,
      },
      {
        label: "config target",
        value: options.configPath,
        tone: "muted",
      },
    ];
  }

  if (stepId === "dingtalkClientId") {
    return [
      {
        label: "platform.options.clientId",
        value: answers.dingtalkClientId.length > 0 ? answers.dingtalkClientId : "待填写",
        tone: answers.dingtalkClientId.length > 0 ? "normal" : "warning",
      },
      {
        label: "platform.options.allowFrom",
        value: answers.allowFrom,
        tone: "muted",
      },
      {
        label: "platform.options.processingNotice",
        value: answers.dingtalkProcessingNotice,
        tone: "muted",
      },
    ];
  }

  if (stepId === "dingtalkClientSecret") {
    return [
      {
        label: "platform.options.clientSecret",
        value: promptDingTalkCredentials ? maskSecret(answers.dingtalkClientSecret) : "复用已有配置",
        tone: answers.dingtalkClientSecret.length > 0 ? "accent" : "warning",
      },
      {
        label: "platform.options.clientId",
        value: answers.dingtalkClientId.length > 0 ? answers.dingtalkClientId : "待填写",
      },
      {
        label: "platform.options.processingNotice",
        value: answers.dingtalkProcessingNotice,
        tone: "muted",
      },
    ];
  }

  return buildWizardOverview(draft, options);
}

export function buildWizardSteps(draft: WizardDraft, options: RunConfigWizardOptions): WizardStep[] {
  const mode = options.mode ?? "init";
  const promptDingTalkCredentials = options.promptDingTalkCredentials ?? true;
  const workDirMode = asWorkDirMode(draft.agentWorkDirMode);

  const steps: WizardStep[] = [
    {
      id: "agentType",
      kind: "select",
      title: "选择 Agent",
      label: "请选择 Agent CLI",
      hint: "这里只改变 agent.type；命令与 model 会按该类型自动回填默认值。",
      required: true,
      defaultValue: options.defaults.agentType,
      options: [
        { label: "Claude Code", value: "claudecode", description: "默认体验，保留 model 默认值。" },
        { label: "Qoder CLI", value: "qoder", description: "命令默认值为 qodercli。" },
        { label: "iFlow CLI", value: "iflow", description: "命令默认值为 iflow。" },
      ],
    },
    {
      id: "agentWorkDirMode",
      kind: "select",
      title: "工作目录",
      label: "Agent 应该在哪个目录里运行？",
      hint: "大多数情况下直接使用当前目录即可；如果代码仓库在别处，再选择手动输入。",
      details: [
        "这个目录会决定 Agent 后续读取文件、执行命令时的默认位置。",
        "通常填写你希望接入的仓库根目录。",
      ],
      required: true,
      defaultValue: "current",
      options: [
        {
          label: "当前目录作为 Agent 工作目录",
          value: "current",
          description: options.defaults.agentWorkDir,
        },
        {
          label: "手动输入其他目录",
          value: "custom",
          description: "适合在当前目录之外的代码仓库上运行 Agent。",
        },
      ],
    },
  ];

  if (workDirMode === "custom") {
    steps.push({
      id: "agentWorkDir",
      kind: "text",
      title: "工作目录",
      label: "请输入要作为 Agent 工作目录的路径",
      hint: "支持绝对路径或相对路径；相对路径会基于你当前执行命令所在的目录解析。",
      details: [
        "这个目录会决定 Agent 后续读取文件、执行命令时的默认位置。",
        "通常填写你希望接入的仓库根目录。",
      ],
      placeholder: "例如 ./backend 或 /path/to/repo",
      required: true,
      defaultValue: "",
    });
  }

  if (promptDingTalkCredentials) {
    steps.push(
      {
        id: "dingtalkClientId",
        kind: "text",
        title: "钉钉凭证",
        label: "platform.options.clientId",
        hint: "当前 init/add 默认生成 DingTalk 平台配置。",
        placeholder: "例如 dingxxxx",
        required: true,
        defaultValue: "",
      },
      {
        id: "dingtalkClientSecret",
        kind: "text",
        title: "钉钉凭证",
        label: "platform.options.clientSecret",
        hint: "输入时会隐藏展示，写入前会在左侧概览里以掩码显示。",
        placeholder: "请输入 client secret",
        required: true,
        defaultValue: "",
      },
    );
  }

  steps.push({
    id: "confirm",
    kind: "select",
    title: `确认${modeVerb(mode)}`,
    label: mode === "add" ? "是否追加到配置文件？" : "是否写入配置文件？",
    hint:
      mode === "add"
        ? "将向已有配置追加新的项目配置。"
        : options.overwritten
          ? "将覆盖已有配置文件。"
          : "将创建新的配置文件。",
    required: true,
    defaultValue: "yes",
    options: [
      { label: "是", value: "yes", description: mode === "add" ? "立即追加 project 并退出。" : "立即写入配置文件并退出。" },
      { label: "否", value: "no", description: "取消本次向导，不写入任何内容。" },
    ],
  });

  return steps;
}

function InitWizardApp(props: InitWizardAppProps): React.ReactElement {
  const { exit } = useApp();
  const [draft, setDraft] = useState<WizardDraft>({});
  const steps = useMemo(() => buildWizardSteps(draft, props), [draft, props]);
  const [stepIndex, setStepIndex] = useState(0);
  const safeStepIndex = Math.min(stepIndex, steps.length - 1);
  const step = steps[safeStepIndex]!;
  const [textValue, setTextValue] = useState(step.defaultValue);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState("");
  const mode = props.mode ?? "init";
  const frameWidth = Math.max(props.stdout.columns ?? 100, 1);
  const tipParts = useMemo(() => parseHighlightedText(buildWizardTip(step, mode)), [mode, step]);

  useEffect(() => {
    if (safeStepIndex !== stepIndex) {
      setStepIndex(safeStepIndex);
    }
  }, [safeStepIndex, stepIndex]);

  useEffect(() => {
    const draftValue = draft[step.id];
    const effective = typeof draftValue === "string" ? draftValue : step.defaultValue;
    if (step.kind === "text") {
      setTextValue(effective);
    } else {
      const options = step.options ?? [];
      const foundIndex = options.findIndex((option) => option.value === effective);
      setSelectedIndex(foundIndex >= 0 ? foundIndex : 0);
    }
    setError("");
  }, [draft, step.defaultValue, step.id, step.kind, step.options]);

  const cancel = (message = cancelMessage(mode)): void => {
    props.onCancel(new Error(message));
    exit();
  };

  const goPrevious = (): void => {
    if (safeStepIndex > 0) {
      setStepIndex(safeStepIndex - 1);
    }
  };

  const commitCurrentValue = (value: string): void => {
    if (step.id === "confirm") {
      if (value !== "yes") {
        cancel();
        return;
      }
      props.onSubmit(draftToAnswers(draft, props));
      exit();
      return;
    }

    const nextDraft: WizardDraft = {
      ...draft,
      [step.id]: value,
    };

    setDraft(nextDraft);
    const nextSteps = buildWizardSteps(nextDraft, props);
    setStepIndex(Math.min(safeStepIndex + 1, nextSteps.length - 1));
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      cancel();
      return;
    }
    if (key.escape) {
      cancel();
      return;
    }
    if (key.leftArrow) {
      goPrevious();
      return;
    }

    if (step.kind === "select") {
      const options = step.options ?? [];
      if (options.length === 0) {
        return;
      }

      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((prev) => (prev + 1) % options.length);
        return;
      }
      if (key.return || key.rightArrow) {
        commitCurrentValue(options[selectedIndex]!.value);
        return;
      }

      const digit = Number.parseInt(input, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) {
        setSelectedIndex(digit - 1);
      }
      return;
    }

    if (key.return) {
      const typed = textValue.trim();
      const fallback = step.defaultValue.trim();
      const nextValue = typed.length > 0 ? typed : fallback;
      if (step.required && nextValue.length === 0) {
        setError(`"${step.label}" 不能为空`);
        return;
      }
      commitCurrentValue(nextValue);
      return;
    }

    if (key.backspace || key.delete) {
      setTextValue((prev) => prev.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0) {
      setTextValue((prev) => `${prev}${input}`);
    }
  });

  const renderCurrentStep = (): React.ReactElement => {
    const hasSupportingCopy = Boolean(step.hint) || (step.details?.length ?? 0) > 0;

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text color={WIZARD_COLORS.accent} bold>
            {step.title}
          </Text>
          <Text color={WIZARD_COLORS.muted}>{stepMood(step.id)}</Text>
        </Box>

        <Box flexDirection="column" marginBottom={hasSupportingCopy ? 1 : 0}>
          <Text color={WIZARD_COLORS.text}>{step.label}</Text>
          {step.hint ? <Text color={WIZARD_COLORS.muted}>{step.hint}</Text> : null}
          {step.details?.map((detail) => (
            <Text key={`${step.id}-${detail}`} color={WIZARD_COLORS.muted}>
              - {detail}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {step.kind === "text" ? (
            <Box flexDirection="column">
              <Text color={WIZARD_COLORS.muted}>Input</Text>
              <Text color={textValue.length > 0 ? WIZARD_COLORS.text : WIZARD_COLORS.muted}>
                &gt; {textValue.length > 0 ? displayStepValue(step.id, textValue) : step.placeholder ?? ""}
              </Text>
              {step.defaultValue ? (
                <Text color={WIZARD_COLORS.muted}>default · {displayStepValue(step.id, step.defaultValue)}</Text>
              ) : null}
            </Box>
          ) : (
            <Box flexDirection="column">
              {(step.options ?? []).map((option, index) => {
                const selected = index === selectedIndex;
                return (
                  <Box key={`${step.id}-${option.value}`} flexDirection="column" marginBottom={1}>
                    <Text color={selected ? WIZARD_COLORS.accent : WIZARD_COLORS.text}>
                      {selected ? "◉" : "○"} {option.label}
                    </Text>
                    {option.description ? <Text color={WIZARD_COLORS.muted}>{option.description}</Text> : null}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>

        {error ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={WIZARD_COLORS.danger}>{error}</Text>
          </Box>
        ) : null}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingY={1} width={frameWidth}>
      <Box flexDirection="column" alignItems="flex-start">
        {bannerLines().map((line) => (
          <Text key={line} color={WIZARD_COLORS.accent} bold>
            {line}
          </Text>
        ))}
      </Box>

      <Text color={WIZARD_COLORS.border}>{divider(frameWidth)}</Text>
      {renderCurrentStep()}

      <Text color={WIZARD_COLORS.border}>{divider(frameWidth)}</Text>
      <Text color={WIZARD_COLORS.muted}>{keyHint(step)}</Text>
      <Box flexDirection="row">
        <Text color={WIZARD_COLORS.warning}>● </Text>
        <Text>
          {tipParts.map((part, index) => (
            <Text key={`${part.text}-${index}`} color={part.highlight ? WIZARD_COLORS.text : WIZARD_COLORS.muted}>
              {part.text}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}

export async function runConfigWizard(options: RunConfigWizardOptions): Promise<InitAnswers> {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    throw new Error("交互式配置向导需要 TTY；可使用 --yes 直接按默认值生成或追加配置");
  }

  return await new Promise<InitAnswers>((resolve, reject) => {
    let settled = false;
    let app: ReturnType<typeof render>;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      handler();
      app.unmount();
    };

    app = render(
      <InitWizardApp
        {...options}
        onSubmit={(answers) => {
          finish(() => resolve(answers));
        }}
        onCancel={(error) => {
          finish(() => reject(error));
        }}
      />,
      {
        stdin: options.stdin,
        stdout: options.stdout,
        exitOnCtrlC: false,
      },
    );
  });
}

export async function runInitTui(options: RunConfigWizardOptions): Promise<InitAnswers> {
  return runConfigWizard(options);
}
