# Changelog

本文件记录 `d-connect` 的对外可见变更。

## [Unreleased]

### Added

- 新增基于 `v*` Git tag 的 GitHub Actions 发布流程，可自动创建 GitHub Release 并发布到 GitHub Packages。

### Changed

- README 补充 GitHub Releases 与 GitHub Packages 的触发方式说明。

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
