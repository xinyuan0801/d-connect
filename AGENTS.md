# AGENTS.md

## 项目定位

`d-connect` 是一个本地守护进程，用于把本机 Agent CLI（`claudecode`、`codex`、`qoder`、`iflow`）桥接到 IM 平台（当前支持 `DingTalk`、`Discord`），并通过本地 IPC 和 loop 能力管理会话与定时任务。

## 技术栈与运行约束

- 语言：TypeScript
- 运行时：Node.js `>=22`
- 模块系统：ESM（`tsconfig.json` 使用 `NodeNext`）
- 测试：Vitest
- 包管理：仓库当前使用 `pnpm`（存在 `pnpm-lock.yaml`）

重要约束：

- 源码只改 `src/**` 和 `tests/**`，不要手改 `dist/**`。
- 本项目导入路径遵循 ESM 约定，TypeScript 源文件内部也使用 `./foo.js` 这样的后缀。
- 配置文件格式是严格 `JSON`，不是 JSONC。
- 运行数据目录固定为 `.d-connect/`，不再支持 `dataDir` 配置项；规则是“普通配置文件 -> 配置文件同级 `.d-connect`，若配置文件本身位于 `.d-connect/config.json` -> 直接复用该目录”。

## 常用命令

```bash
pnpm install
pnpm run build
pnpm test
pnpm run dev init -c ./config.json
pnpm run dev add -c ./config.json
pnpm run dev start -c ./config.json
node dist/index.js init -c ./config.json
node dist/index.js add -c ./config.json
node dist/index.js start -c ./config.json
```

常见本地联调：

```bash
pnpm run dev send -p <project> -s local:debug "hello"
pnpm run dev loop add -p <project> -s local:debug -e "*/30 * * * * *" "status"
pnpm run dev loop list -p <project>
```

## 发布流程

- npm 正式发布使用 `pnpm run publish`；该脚本会先执行 `pnpm test` 和 `pnpm run build`，再发布到 npm registry。
- GitHub Release 与 GitHub Packages 通过推送 `v*` 标签自动触发；对应 workflow 位于 `.github/workflows/release.yml`。
- 发布新版本时，顺序应为：先更新 `package.json` 版本并推送 `main`，再创建并推送同版本标签，例如 `git tag v0.1.2 && git push origin v0.1.2`。
- 标签版本必须与 `package.json` 中的 `version` 完全一致，否则 release workflow 会失败。
- GitHub Actions 的 release workflow 会自动执行测试、构建、创建 GitHub Release，并将同版本包发布到 GitHub Packages。
- 若只是调整发布流程或仓库运维逻辑，优先更新 `AGENTS.md`；只有用户实际使用方式发生变化时才同步更新 `README.md`。

## 目录结构

- `src/bootstrap/**`：CLI 入口装配、daemon 启动编排、信号处理。
- `src/core/**`：运行时契约与共享类型，如 `InboundMessage`、`DeliveryTarget`、`JobExecutor`。
- `src/services/**`：项目注册、会话编排、命令处理、消息 relay。
- `src/config/**`：配置路径解析、模板生成、Zod schema 校验与 normalize。
- `src/adapters/agent/**`：各类 Agent CLI 适配器、共享 `BaseCliSession`、输出解析。
- `src/adapters/platform/**`：IM 平台适配器，以及平台共享的 allow-list / delivery-target 能力。
- `src/ipc/**`：对外 IPC server/client；路由表位于 `src/infra/ipc/router.ts`。
- `src/scheduler/loop.ts`：定时任务调度与持久化编排，依赖 `JobExecutor` 接口。
- `src/infra/**`：logging、JSON 文件原子写入、IPC router 等基础设施。
- `tests/**`：Vitest 测试，整体以模块级单测为主。
- `dist/**`：构建产物，不作为人工修改入口。

关键调用链：

1. `src/index.ts` -> `src/bootstrap/cli.ts`
2. `start` -> `src/bootstrap/daemon.ts`
3. `daemon` 装配 `RuntimeEngine`、`LoopScheduler`、`IpcServer`
4. `RuntimeEngine` 内部委托 `DaemonRuntime`
5. `DaemonRuntime` -> `ProjectRegistry` / `ConversationService` / `CommandService` / `MessageRelay`
6. 平台入站消息统一转换成 `InboundMessage`
7. 异步回投使用持久化 `DeliveryTarget`，不再依赖进程内存中的 reply context

## 代码约定

- 保持现有风格：双引号、分号、显式类型、`type` import 与值 import 分离。
- 优先做小而集中的修改，不要顺手重构无关模块。
- 新逻辑若会影响 CLI 输出、事件拼装、配置解析或平台消息格式，必须补测试。
- 错误处理保持当前模式：抛出清晰错误，由 CLI 入口或上层统一打印。
- 日志统一走 `Logger`，不要直接在业务代码里散落 `console.log`。

## 修改建议

### 新增 Agent CLI 支持

通常需要同时修改：

1. `src/config/schema.ts`
2. `src/adapters/agent/index.ts`
3. `src/adapters/agent/<name>.ts`
4. `src/adapters/agent/parsers.ts`（如果输出格式有差异）
5. 相关测试

优先复用 `src/adapters/agent/shared/base-cli-session.ts` 的 one-shot CLI 执行骨架，除非新的 Agent 明确需要不同生命周期。

当前已落地的 `codex` 适配补充：

- 基于本机验证过的 `codex-cli 0.114.0`
- 非交互执行命令形态是 `codex exec --json`
- 续聊使用 `codex exec resume <thread_id> <prompt>`
- `reasoning_effort` 通过 `-c model_reasoning_effort="..."` 传递，不是独立 flag
- `mode` 目前只映射 `suggest` / `full-auto` / `yolo`

### 新增 IM 平台支持

通常需要同时修改：

1. `src/config/schema.ts`
2. `src/adapters/platform/index.ts`
3. `src/adapters/platform/<name>.ts`
4. `src/core/types.ts`（新增平台若需要新的通用契约时）
5. 相关测试

新增平台时，优先复用：

- `src/adapters/platform/shared/allow-list.ts`
- `src/adapters/platform/shared/delivery-target.ts`
- `PlatformAdapter.send()` 的异步回投语义
- Discord 当前走标准 Bot Token 鉴权，入站用 Gateway，出站/异步回投用 REST `channels/{channel.id}/messages`

### 修改配置结构

- 先改 `src/config/schema.ts`
- 再改 `src/config/loader.ts` / `src/config/validator.ts` / 配置模板
- 最后补充配置加载测试

## 测试期望

提交前至少运行与改动相关的测试；如果改动了公共运行路径，优先跑全量：

```bash
pnpm test
pnpm run build
```

涉及以下改动时，测试不要省：

- `src/runtime/**`
- `src/config/**`
- `src/adapters/agent/parsers.ts`
- `src/adapters/platform/**`
- `src/ipc/**`
- `src/scheduler/**`

## 调试提示

- 建议先执行 `init` 生成配置；若配置文件不存在，`start` 仍会自动生成模板并退出。
- 本地调试优先使用 `local:<name>` 这样的 `sessionKey`，先验证 runtime/IPC/loop，再接入真实 IM。
- 守护进程依赖 `.d-connect/ipc.sock`；排查 IPC 问题时先确认 `start` 是否已成功启动。
- 若看到 `session is busy`，说明同一会话仍在处理上一条请求，不要把它误判为进程卡死。
- `loop` 回投依赖某个 `sessionKey` 最近一次成功建立的 `DeliveryTarget`；该信息持久化在 `.d-connect/sessions/sessions.json`。
- `loop` 默认按 `job.id` 使用隔离的执行会话，不继承聊天 `sessionKey` 的历史上下文；只有回投目标仍然复用原始 `sessionKey` 对应的 `DeliveryTarget`。
- 若守护进程重启后 `loop` 不回投，先确认该 `sessionKey` 是否收到过真实平台消息，以及平台是否支持 `send()` 异步发送。

### DingTalk 排障经验

- DingTalk 机器人消息走的是 `CALLBACK`，不是普通 `EVENT`。接入时应使用 `registerCallbackListener(TOPIC_ROBOT, ...)`，否则 websocket 已连接也收不到机器人消息。
- DingTalk `CALLBACK` 需要显式回执。若收到消息后没有调用 `client.socketCallBackResponse(downstream.headers.messageId, "")`，平台通常会在约 60 秒后重投同一条消息，表现为“用户只发了一次，但被消费两次”。
- DingTalk 去重窗口要明显长于平台重投窗口。当前实现按 `msgId` 去重，TTL 设为 10 分钟；若只配 60 秒，容易与 callback 重投时间撞上，导致同一消息再次穿透。
- 排查“重复消费”时，优先同时看两个 ID：业务消息 ID `raw.msgId` 和 stream 层消息 ID `downstream.headers.messageId`。日志里最好同时打印 `conversationId`、`userId` 和内容预览，便于区分“平台重投同一消息”与“用户真的又发了一次”。
- 排查“看起来串 session”时，不要只看钉钉聊天窗口。钉钉没有 thread 视图，多个逻辑 session 的回复会落在同一时间线里；应以 `.d-connect/sessions/sessions.json` 中的 `activeSession`、各 session 独立 history、`agentSessionId` 为准，先判断是 UI 交错还是后端真的混写。
- DingTalk 的 `sessionWebhook` 是临时回复目标，必须结合 `sessionWebhookExpiredTime` 使用。当前异步回投/loop 不再尝试 `sessionWebhook`，而是按 `conversationType` 直接走机器人主动发送：群聊 `/v1.0/robot/groupMessages/send`，单聊 `/v1.0/robot/oToMessages/batchSend`。
- DingTalk 的 loop 依赖持久化 `DeliveryTarget` 里的 `conversationType`、`robotCode`，以及群聊所需的 `openConversationId` 或单聊所需的 `userId`；历史旧版 target 缺这些字段时会被直接忽略。
- 若日志显示 `dingtalk stream connected` 但没有任何入站处理，先核对三件事：是否订阅了 `TOPIC_ROBOT` callback、allow-list 是否放行当前用户、消息类型是否为当前支持的 `text`。

### Discord 排障经验

- Discord 机器人接入使用标准 `Bot Token`；当前实现会先调 `/gateway/bot` 建连，再通过 Gateway 接收入站消息。
- 群聊文本触发依赖 `MESSAGE CONTENT INTENT`。若 bot 能收到事件但正文总是空，优先检查 Developer Portal 里的这个开关。
- 当前默认 `requireMention = true`：群聊里只有显式 `@bot` 或回复 bot 的消息才会进 Agent；若看起来“机器人没反应”，先确认是不是没 mention。
- Discord 即时回复会在开始处理该条用户消息时立刻补一个 `👀` reaction；本轮成功结束后会移除 `👀` 并补一个 `💯`，流式多段回复期间不会重复添加。
- Discord 的异步回投/loop 只依赖持久化 `DeliveryTarget` 里的 `channelId`；历史 target 缺这个字段时会被直接忽略。
- 出站消息默认关闭 `allowed_mentions.parse`，避免 Agent 输出意外触发 `@everyone` 或角色 mention；若业务上确实需要 mention，当前实现需要改代码，不是配置项。

## 对后续 Agent 的要求

- 先阅读相关模块再改，不要凭文件名猜行为。
- 不要编辑 `dist/**` 来“修复”运行结果；应修改 `src/**` 后重新构建。
- 不要引入新的框架级依赖，除非确有必要且与当前架构一致。
- 若用户要求只是补文档或配置说明，避免顺带修改业务逻辑。
- 若改动影响用户可见命令、配置字段或平台行为，同时更新 `README.md`。
- 在开发过程中，若发现有意义的重要链路（如关键调用链、排障路径、联调步骤），允许并建议同步更新 `AGENTS.md` 进行沉淀，且内容需与当前实现保持一致。
