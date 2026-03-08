# d-connect

> Tribute: 本项目在整体思路和使用形态上受 [cc-connect](https://github.com/chenhg5/cc-connect) 启发，感谢原项目提供的方向参考。

`d-connect` 是一个本地守护进程，用于把本机 Agent CLI 桥接到 IM 平台，并通过本地 IPC 与 cron 管理会话、消息回投和定时任务。

当前代码实现支持：

- IM 平台：DingTalk、Feishu
- Agent CLI：`claudecode`、`qoder`、`iflow`
- 配置格式：严格 `JSON`，不支持 JSONC 注释
- 运行时：Node.js `>=22`

## 功能概览

- 一个 daemon 管多个 project，每个 project 绑定一组 agent/platform 配置
- 支持本地 IPC：`send`、`cron add/list/del`
- 支持按 `sessionKey` 维护多会话，并持久化历史与 active session
- 支持异步回投：平台入站消息携带的 `DeliveryTarget` 会落盘，供 cron/重启后继续使用
- DingTalk 支持文本、富文本、图片、音频、视频、文件等入站处理
- Feishu 支持 `text` / `post` 入站处理，并支持 reaction 占位反馈

## 环境要求

- Node.js `>=22`
- macOS 或 Linux
- `pnpm`
- 已安装对应 Agent CLI，或在配置里显式指定 `agent.options.cmd`

## 安装与构建

已发布的 npm 包名：

```bash
@xinyuan0801/d-connect
```

全局安装：

```bash
npm install -g @xinyuan0801/d-connect
d-connect help
```

如果你需要从源码安装：

```bash
pnpm install
pnpm run build
pnpm link --global
d-connect help
```

常见运行方式：

- 开发模式：`pnpm run dev <args>`
- 构建产物：`node dist/index.js <args>`
- 全局命令：`d-connect <args>`

如果 `pnpm link --global` 首次不可用，先执行一次 `pnpm setup`。

## 快速开始

### 1. 初始化配置

配置文件查找优先级：

1. `-c / --config` 指定路径
2. 当前目录下的 `./config.json`
3. `~/.d-connect/config.json`

推荐先运行：

```bash
d-connect init -c ./config.json
```

`init` 会打开一个终端向导：

- 支持 `↑/↓` 或 `j/k` 切换
- `Enter` 确认
- `project.name` 会按 `agent.options.workDir` 的目录名自动推断
- `--yes` 可直接按默认值生成
- `--force` 可覆盖已有文件

开发模式下：

```bash
pnpm run dev init -c ./config.json
```

如果你直接执行 `start` 且配置不存在，程序会先生成模板配置并退出。

### 2. 编辑配置

示例一：DingTalk + Claude Code

```json
{
  "configVersion": 1,
  "dataDir": "/Users/you/.d-connect",
  "log": {
    "level": "info"
  },
  "cron": {
    "silent": false
  },
  "projects": [
    {
      "name": "my-backend",
      "agent": {
        "type": "claudecode",
        "options": {
          "workDir": "/path/to/repo",
          "cmd": "claude",
          "mode": "default",
          "model": "claude-sonnet-4-20250514"
        }
      },
      "platforms": [
        {
          "type": "dingtalk",
          "options": {
            "clientId": "dingxxxx",
            "clientSecret": "xxxx",
            "allowFrom": "*",
            "processingNotice": "处理中..."
          }
        }
      ]
    }
  ]
}
```

示例二：Feishu + Qoder CLI

```json
{
  "configVersion": 1,
  "dataDir": "/Users/you/.d-connect",
  "log": {
    "level": "info"
  },
  "cron": {
    "silent": false
  },
  "projects": [
    {
      "name": "my-feishu-project",
      "agent": {
        "type": "qoder",
        "options": {
          "workDir": "/path/to/repo",
          "cmd": "qodercli"
        }
      },
      "platforms": [
        {
          "type": "feishu",
          "options": {
            "appId": "cli_xxx",
            "appSecret": "xxx",
            "allowFrom": "*",
            "groupReplyAll": false,
            "reactionEmoji": "OnIt"
          }
        }
      ]
    }
  ]
}
```

关键字段：

- `dataDir`：运行数据目录，保存 `ipc.sock`、sessions、cron、日志
- `allowFrom`：`*` 表示允许全部用户，也可填写逗号分隔的用户 ID
- `cron.silent`：默认 cron 是否只执行不回推到平台
- `processingNotice`：DingTalk 处理中的轻量提示，设为 `"none"` 可关闭
- `groupReplyAll`：Feishu 群聊里是否无需 @ 机器人也处理消息
- `reactionEmoji`：Feishu 处理中表情，设为 `"none"` 可关闭

### 3. 启动守护进程

```bash
pnpm run dev start -c ./config.json
```

或：

```bash
node dist/index.js start -c ./config.json
```

启动后会创建：

- `dataDir/ipc.sock`
- `dataDir/sessions/sessions.json`
- `dataDir/crons/jobs.json`
- `dataDir/logs/d-connect.log`

### 4. 发送本地调试消息

```bash
pnpm run dev send -p my-backend -s local:debug "hello"
```

`local:<name>` 适合先验证 runtime、IPC、session 和 cron，不依赖真实 IM 平台。

## CLI 命令

```bash
d-connect init -c ./config.json
d-connect start -c ./config.json
d-connect send -p <project> -s <sessionKey> "hello"
d-connect cron add -p <project> -s <sessionKey> -e "*/30 * * * * *" "status"
d-connect cron list -p <project>
d-connect cron del -i <job-id>
```

说明：

- `send` 会把消息送到指定 `project + sessionKey`
- `cron add` 支持 `-d/--description`
- `cron add --silent` 可让该任务执行但不回推到平台
- `cron list` 会输出 `id / project / sessionKey / expr / prompt`

## 会话内命令

当 IM 消息内容以 `/` 开头时，会走内置命令处理：

```text
/help
/new [name]
/list
/switch <id|name>
/mode [name]
/cron list
/cron add <expr> <prompt>
/cron del <id>
```

典型用途：

- `/new`：在同一个 `sessionKey` 下创建新的逻辑 session
- `/list`：查看该 `sessionKey` 下所有 session，带 `*` 的是当前 active session
- `/switch`：切换 active session
- `/mode`：查看或切换 agent mode
- `/cron ...`：直接在聊天窗口里增删查定时任务

## 本地联调

### 纯本地链路

先启动 daemon：

```bash
pnpm run dev start -c ./config.json
```

另一个终端发送消息：

```bash
pnpm run dev send -p my-backend -s local:alice "请给我当前项目结构"
pnpm run dev send -p my-backend -s local:bob "你好"
```

验证 cron：

```bash
pnpm run dev cron add -p my-backend -s local:alice -e "*/20 * * * * *" "输出一次状态"
```

注意：

- `local:<name>` 不会自动生成真实 IM 平台的发送目标
- 纯本地链路更适合验证 runtime、IPC、会话切换和 cron 执行

### DingTalk 联调

1. 在钉钉开放平台创建应用并开通机器人能力
2. 使用 Stream 模式
3. 把 `clientId/clientSecret` 写入配置
4. 启动 daemon
5. 在钉钉里给机器人发送文本消息

当前行为：

- 使用 `registerCallbackListener(TOPIC_ROBOT, ...)` 接 DingTalk 机器人回调
- 收到 callback 后会显式回执，避免平台约 60 秒后重投同一消息
- 默认按 `msgId` 做 10 分钟去重
- 支持 `text`、`richText`、`picture`、`audio`、`video`、`file`
- 图片/视频/文件通常会下载到 `agent.options.workDir/.d-connect/dingtalk-media`
- 长处理会先发送 `processingNotice`，普通结构化回复会自动切到 markdown 消息

回投限制：

- DingTalk 异步发送依赖入站消息携带的 `sessionWebhook`
- `sessionWebhook` 有有效期，过期后 cron 或重启后的异步回投会失败
- 只有新的真实钉钉消息到来后，持久化的发送目标才会刷新

### Feishu 联调

1. 在飞书开放平台创建企业自建应用并开通机器人能力
2. 订阅事件 `im.message.receive_v1`
3. 把 `appId/appSecret` 写入配置
4. 启动 daemon
5. 在私聊或群聊中给机器人发消息

当前行为：

- 支持入站 `text` 与 `post`
- 群聊默认需要 @机器人；`groupReplyAll=true` 时可关闭这个限制
- 处理中默认会给原消息加 `reactionEmoji`，完成后移除
- 回复会按内容复杂度自动选择 `text`、`post` 或 `interactive`

## 目录与架构

主要目录：

- `src/bootstrap/**`：CLI 入口、daemon 启动、信号处理
- `src/core/**`：共享类型与运行时契约
- `src/services/**`：会话编排、命令处理、消息 relay
- `src/adapters/agent/**`：Agent CLI 适配层
- `src/adapters/platform/**`：DingTalk / Feishu 适配层
- `src/config/**`：配置 schema、loader、normalize、init 向导
- `src/ipc/**`：本地 IPC server/client
- `src/scheduler/**`：cron 调度与持久化
- `src/infra/**`：日志、原子写文件、router 等基础设施

关键调用链：

1. `src/index.ts`
2. `src/bootstrap/cli.ts`
3. `start` -> `src/bootstrap/daemon.ts`
4. `daemon` 装配 `RuntimeEngine`、`CronScheduler`、`IpcServer`
5. `RuntimeEngine` 委托 `DaemonRuntime`
6. `DaemonRuntime` 调用 `ProjectRegistry`、`ConversationService`、`CommandService`、`MessageRelay`

## 数据目录

`dataDir` 下常见文件：

- `ipc.sock`：本地 IPC socket
- `sessions/sessions.json`：会话状态、历史、active session、最近一次可用的 `DeliveryTarget`
- `crons/jobs.json`：cron 任务持久化
- `logs/d-connect.log`：文件日志

## 测试与构建

```bash
pnpm test
pnpm run build
```

如果你改了以下路径，建议不要跳过测试：

- `src/config/**`
- `src/adapters/platform/**`
- `src/adapters/agent/parsers.ts`
- `src/ipc/**`
- `src/scheduler/**`
- `src/runtime/**`

## 常见问题

### `agent cli not found`

- 确认对应 CLI 已安装并可在 `PATH` 中执行
- 或在 `agent.options.cmd` 里写绝对路径

### `session is busy`

- 同一个逻辑 session 正在处理上一条请求
- 等当前请求结束后再发，或先 `/new` 创建新 session

### IPC 无法连接

- 确认 daemon 已启动
- 确认 `dataDir/ipc.sock` 已创建
- 检查是否有旧的异常 socket 残留

### cron 没有回投到 IM

- 先确认该 `sessionKey` 最近是否收到过至少一条真实平台消息
- 异步回投依赖持久化的 `DeliveryTarget`
- DingTalk 场景还要额外检查 `sessionWebhook` 是否已经过期
