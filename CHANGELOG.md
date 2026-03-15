# Changelog

本文件记录 `d-connect` 的对外可见变更。

## [Unreleased]

## [0.5.0] - 2026-03-15

### Added

- 新增 `codex` Agent CLI 适配，支持非交互执行、续聊与模型/推理强度透传。
- 新增 `opencode` Agent CLI 适配，支持 JSON 事件流解析、工具调用渲染与会话续聊。
- 为 `claudecode` 增加 agent team 支持，可通过 `/team`、`/team members`、`/team tasks`、`/team ask`、`/team stop`、`/team cleanup` 管理 teammate 协作。

### Changed

- Discord 群聊回复生命周期现在会自动补 `👀` 处理中 reaction，并在成功结束后替换为 `💯`。
- daemon/runtime 的真实 IPC、工具事件与多轮输出链路补齐了端到端覆盖，降低新 agent 接入后的回归风险。

### Fixed

- 修复 `/loop add` 会把非法单字段 schedule 误判为合法输入，导致命令静默失败的问题。
- 修复自然语言 `/loop` 指令在未显式提供配置路径时仍错误提示 `-c <configPath>` 的问题。

## [0.4.0] - 2026-03-11

### Added

- 新增基于 `v*` Git tag 的 GitHub Actions 发布流程，可自动创建 GitHub Release 并发布到 GitHub Packages。

### Changed

- 将发布自动化和仓库运维说明沉淀到 `AGENTS.md`，不再放在 `README.md`。
- 移除 `Feishu` 平台支持，当前仅保留 `DingTalk`。

## [0.1.1] - 2026-03-08

### Added

- 新增 `pnpm run publish` 发布脚本，发布前会先执行测试与构建。

### Changed

- 包版本升级到 `0.1.1`。

## [0.1.0] - 2026-03-08

### Added

- 首次发布 `d-connect` npm 包。
- 支持将本地 Agent CLI 桥接到 `DingTalk` 与 `Feishu`。
- 支持多项目、多会话与 loop 定时任务。
- 提供 `init`、`add`、`start`、`send` 与 `loop` 等 CLI 能力。
