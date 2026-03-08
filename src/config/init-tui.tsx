import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { InitAnswers } from "./init.js";

type AgentType = InitAnswers["agentType"];
type PlatformType = InitAnswers["platformType"];
type LogLevel = InitAnswers["logLevel"];

interface RunInitTuiOptions {
  defaults: InitAnswers;
  configPath: string;
  overwritten: boolean;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  deriveProjectName: (workDir: string, fallback?: string) => string;
}

interface SelectOption {
  label: string;
  value: string;
}

interface WizardStep {
  id: string;
  kind: "text" | "select";
  title: string;
  label: string;
  hint?: string;
  required: boolean;
  defaultValue: string;
  options?: SelectOption[];
}

type WizardDraft = Record<string, string>;

interface InitWizardAppProps extends RunInitTuiOptions {
  onSubmit: (answers: InitAnswers) => void;
  onCancel: (error: Error) => void;
}

const WIZARD_BANNER_LINES = [
  "ᐡ ᐧ ﻌ ᐧ ᐡ",
];

const UI_DIVIDER = "────────────────────────────────────────";

function asAgentType(value: string): AgentType {
  if (value === "qoder" || value === "iflow") {
    return value;
  }
  return "claudecode";
}

function asPlatformType(value: string): PlatformType {
  if (value === "feishu") {
    return value;
  }
  return "dingtalk";
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

export function bannerLines(): string[] {
  return [...WIZARD_BANNER_LINES];
}

export function formatWizardProgress(currentStep: number, totalSteps: number, width = 20): string {
  const safeTotal = totalSteps > 0 ? totalSteps : 1;
  const safeCurrent = Math.min(Math.max(currentStep, 0), safeTotal);
  const safeWidth = Math.max(width, 4);
  const filled = Math.round((safeCurrent / safeTotal) * safeWidth);
  const percent = Math.round((safeCurrent / safeTotal) * 100);
  return `[${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}] ${percent}%`;
}

export function stepMood(stepId: string): string {
  if (stepId === "confirm") {
    return "[SYS] FINAL CHECK";
  }

  if (stepId.startsWith("agent")) {
    return "[SYS] AGENT PROFILE";
  }

  if (stepId.startsWith("dingtalk") || stepId.startsWith("feishu") || stepId === "platformType" || stepId === "allowFrom") {
    return "[SYS] PLATFORM PROFILE";
  }

  return "[SYS] BASE RUNTIME";
}

function draftToAnswers(draft: WizardDraft, options: RunInitTuiOptions): InitAnswers {
  const agentType = asAgentType(draft.agentType ?? options.defaults.agentType);
  const platformType = asPlatformType(draft.platformType ?? options.defaults.platformType);
  const agentWorkDir = (draft.agentWorkDir ?? options.defaults.agentWorkDir).trim();
  const projectName = options.deriveProjectName(agentWorkDir, options.defaults.projectName);

  return {
    projectName,
    dataDir: (draft.dataDir ?? options.defaults.dataDir).trim(),
    logLevel: asLogLevel(draft.logLevel ?? options.defaults.logLevel),
    cronSilent: parseBoolean(draft.cronSilent, options.defaults.cronSilent),
    agentType,
    agentCmd: (draft.agentCmd ?? defaultAgentCommand(agentType)).trim(),
    agentWorkDir,
    agentMode: (draft.agentMode ?? options.defaults.agentMode).trim(),
    agentModel: draft.agentModel ?? defaultAgentModel(agentType),
    platformType,
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

function buildSteps(draft: WizardDraft, options: RunInitTuiOptions): WizardStep[] {
  const agentType = asAgentType(draft.agentType ?? options.defaults.agentType);
  const platformType = asPlatformType(draft.platformType ?? options.defaults.platformType);
  const projectedName = options.deriveProjectName(draft.agentWorkDir ?? options.defaults.agentWorkDir, options.defaults.projectName);

  const steps: WizardStep[] = [
    {
      id: "dataDir",
      kind: "text",
      title: "数据目录",
      label: "dataDir",
      hint: "用于保存 ipc.sock、sessions、crons 和日志。",
      required: true,
      defaultValue: options.defaults.dataDir,
    },
    {
      id: "agentType",
      kind: "select",
      title: "选择 Agent",
      label: "请选择 Agent CLI",
      required: true,
      defaultValue: options.defaults.agentType,
      options: [
        { label: "Claude Code", value: "claudecode" },
        { label: "Qoder CLI", value: "qoder" },
        { label: "iFlow CLI", value: "iflow" },
      ],
    },
    {
      id: "agentCmd",
      kind: "text",
      title: "Agent 命令",
      label: "agent.options.cmd",
      hint: "可执行命令名或绝对路径。",
      required: true,
      defaultValue: defaultAgentCommand(agentType),
    },
    {
      id: "agentWorkDir",
      kind: "text",
      title: "Agent 工作目录",
      label: "agent.options.workDir",
      hint: "项目名将按该目录名自动推断。",
      required: true,
      defaultValue: options.defaults.agentWorkDir,
    },
    {
      id: "agentMode",
      kind: "text",
      title: "Agent 模式",
      label: "agent.options.mode",
      hint: "示例: default / plan / auto-edit（取决于 Agent）。",
      required: true,
      defaultValue: options.defaults.agentMode,
    },
    {
      id: "agentModel",
      kind: "text",
      title: "Agent 模型",
      label: "agent.options.model",
      hint: "可选；留空则使用 Agent 默认模型。",
      required: false,
      defaultValue: defaultAgentModel(agentType),
    },
    {
      id: "platformType",
      kind: "select",
      title: "选择平台",
      label: "请选择 IM 平台",
      required: true,
      defaultValue: options.defaults.platformType,
      options: [
        { label: "DingTalk", value: "dingtalk" },
        { label: "Feishu", value: "feishu" },
      ],
    },
    {
      id: "allowFrom",
      kind: "text",
      title: "平台允许列表",
      label: "platform.options.allowFrom",
      hint: "使用 * 表示允许所有用户，或填写逗号分隔的用户 ID。",
      required: true,
      defaultValue: options.defaults.allowFrom,
    },
    {
      id: "logLevel",
      kind: "select",
      title: "日志级别",
      label: "请选择日志级别",
      required: true,
      defaultValue: options.defaults.logLevel,
      options: [
        { label: "debug", value: "debug" },
        { label: "info", value: "info" },
        { label: "warn", value: "warn" },
        { label: "error", value: "error" },
      ],
    },
    {
      id: "cronSilent",
      kind: "select",
      title: "Cron 静默设置",
      label: "默认启用 cron.silent=true 吗？",
      hint: "为 true 时，cron 默认执行但不回推到平台。",
      required: true,
      defaultValue: String(options.defaults.cronSilent),
      options: [
        { label: "是", value: "true" },
        { label: "否", value: "false" },
      ],
    },
  ];

  if (platformType === "dingtalk") {
    steps.push(
      {
        id: "dingtalkClientId",
        kind: "text",
        title: "钉钉凭证",
        label: "platform.options.clientId",
        required: true,
        defaultValue: options.defaults.dingtalkClientId,
      },
      {
        id: "dingtalkClientSecret",
        kind: "text",
        title: "钉钉凭证",
        label: "platform.options.clientSecret",
        required: true,
        defaultValue: options.defaults.dingtalkClientSecret,
      },
      {
        id: "dingtalkProcessingNotice",
        kind: "text",
        title: "钉钉处理中提示",
        label: "platform.options.processingNotice",
        hint: "处理超过短延迟时发送；填写 \"none\" 可关闭。",
        required: true,
        defaultValue: options.defaults.dingtalkProcessingNotice,
      },
    );
  } else {
    steps.push(
      {
        id: "feishuAppId",
        kind: "text",
        title: "飞书凭证",
        label: "platform.options.appId",
        required: true,
        defaultValue: options.defaults.feishuAppId,
      },
      {
        id: "feishuAppSecret",
        kind: "text",
        title: "飞书凭证",
        label: "platform.options.appSecret",
        required: true,
        defaultValue: options.defaults.feishuAppSecret,
      },
      {
        id: "feishuGroupReplyAll",
        kind: "select",
        title: "飞书群聊行为",
        label: "设置 groupReplyAll=true 吗？",
        hint: "为 false 时，群聊通常只响应 @ 机器人消息。",
        required: true,
        defaultValue: String(options.defaults.feishuGroupReplyAll),
        options: [
          { label: "是", value: "true" },
          { label: "否", value: "false" },
        ],
      },
      {
        id: "feishuReactionEmoji",
        kind: "text",
        title: "飞书处理表情",
        label: "platform.options.reactionEmoji",
        hint: "设置为 \"none\" 可关闭处理中 reaction。",
        required: true,
        defaultValue: options.defaults.feishuReactionEmoji,
      },
    );
  }

  steps.push({
    id: "confirm",
    kind: "select",
    title: "确认写入",
    label: "是否写入配置文件？",
    hint: options.overwritten
      ? `将覆盖已有配置（项目名: ${projectedName}）。`
      : `将创建新配置文件（项目名: ${projectedName}）。`,
    required: true,
    defaultValue: "yes",
    options: [
      { label: "是", value: "yes" },
      { label: "否", value: "no" },
    ],
  });

  return steps;
}

function InitWizardApp(props: InitWizardAppProps): React.ReactElement {
  const { exit } = useApp();
  const [draft, setDraft] = useState<WizardDraft>({});
  const steps = useMemo(() => buildSteps(draft, props), [draft, props]);
  const [stepIndex, setStepIndex] = useState(0);
  const safeStepIndex = Math.min(stepIndex, steps.length - 1);
  const step = steps[safeStepIndex]!;
  const [textValue, setTextValue] = useState(step.defaultValue);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState("");

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
  }, [step.id, step.kind, step.defaultValue, step.options, safeStepIndex]);

  const cancel = (message = "初始化已取消"): void => {
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

    if (step.id === "agentWorkDir") {
      nextDraft.projectName = props.deriveProjectName(value, props.defaults.projectName);
    }

    setDraft(nextDraft);
    const nextSteps = buildSteps(nextDraft, props);
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

  const progress = formatWizardProgress(safeStepIndex + 1, steps.length);
  const mood = stepMood(step.id);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      alignSelf="flex-start"
      width={76}
    >
      {bannerLines().map((line) => (
        <Text key={line} color="green">
          {line}
        </Text>
      ))}
      <Text color="green">[SYS] D-CONNECT CONFIG INIT</Text>
      <Text color="gray">[CFG] {props.configPath}</Text>
      <Text color={props.overwritten ? "yellow" : "gray"}>
        {props.overwritten ? "[WRN] TARGET EXISTS; OVERWRITE ON SAVE" : "[INF] TARGET NOT FOUND; NEW FILE WILL BE CREATED"}
      </Text>

      <Text />
      <Text color="green">{UI_DIVIDER}</Text>
      <Text color="green">
        [STP] {safeStepIndex + 1}/{steps.length} · {step.title}
      </Text>
      <Text color="green">{progress}</Text>
      <Text color="gray">{mood}</Text>
      <Text color="green">{UI_DIVIDER}</Text>

      <Text />
      <Text color="green">[INP] {step.label}</Text>
      {step.hint ? <Text color="gray">[INF] {step.hint}</Text> : null}

      {step.kind === "text" ? (
        <Box flexDirection="column">
          <Text color="green">&gt; {textValue}</Text>
          {step.defaultValue ? <Text color="gray">[DEF] {step.defaultValue}</Text> : null}
        </Box>
      ) : (
        <Box flexDirection="column">
          {(step.options ?? []).map((option, index) => {
            const selected = index === selectedIndex;
            return (
              <Text key={`${step.id}-${option.value}`} color={selected ? "green" : "gray"}>
                {selected ? ">" : " "} [{index + 1}] {option.label}
              </Text>
            );
          })}
        </Box>
      )}

      {error ? (
        <>
          <Text />
          <Text color="red">[ERR] {error}</Text>
        </>
      ) : null}

      <Text />
      <Text color="gray">
        {step.kind === "select"
          ? "[KEY] UP/DOWN OR J/K · ENTER/→ CONFIRM · ← BACK · ESC/CTRL+C EXIT"
          : "[KEY] TYPE · ENTER CONFIRM · BACKSPACE DELETE · ← BACK · ESC/CTRL+C EXIT"}
      </Text>
    </Box>
  );
}

export async function runInitTui(options: RunInitTuiOptions): Promise<InitAnswers> {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    throw new Error("交互式 init 需要 TTY；可使用 --yes 直接按默认值生成配置");
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
