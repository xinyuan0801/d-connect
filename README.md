# d-connect

本项目用于将本地 Agent CLI（Claude Code / Qoder CLI / iFlow CLI）桥接到 IM 平台。

当前版本支持：
- 平台：DingTalk、Feishu（飞书）
- Agent：`claudecode`、`qoder`（`qodercli`）、`iflow`
- 配置格式：`JSON`（不支持 JSONC 注释）

## 1. 环境要求

- Node.js >= 22
- macOS 或 Linux
- 对应 Agent CLI 已安装并可在终端执行（或在配置中指定 `cmd`）

## 2. 安装

当前仓库版本尚未发布到 npm registry，首次使用请从源码安装命令：

```bash
pnpm install
pnpm run build
npm link
d-connect help
```

可选：
- 开发模式运行（不先 build）：`pnpm run dev <args>`
- 构建后运行：`node dist/index.js <args>`
- 全局链接后可直接运行：`d-connect <args>`
- 若你使用 `pnpm link --global`，首次可能需要先执行 `pnpm setup`

## 3. 配置文件

配置文件优先级：
1. `-c / --config` 指定路径
2. `./config.json`
3. `~/.d-connect/config.json`

推荐先使用初始化向导生成配置（交互式）：

```bash
d-connect init -c ./config.json
```

`init` 会进入终端 TUI 向导，支持 `↑/↓`（或 `j/k`）选择、`Enter` 确认，并在侧边实时展示当前配置摘要。
项目名不再单独输入，会按 `agent.options.workDir` 的目录名自动推断（空格会转为 `-`）。

开发模式：

```bash
pnpm run dev init -c ./config.json
```

可选参数：
- `--force`：覆盖已存在的配置文件
- `--yes`：跳过交互，直接按默认值生成

兼容行为：若直接执行 `start` 且配置不存在，仍会自动生成模板并退出。

### 3.1 示例（DingTalk）

```json
{
  "configVersion": 1,
  "dataDir": "/Users/you/.d-connect",
  "log": { "level": "info" },
  "cron": { "silent": false },
  "projects": [
    {
      "name": "my-backend",
      "agent": {
        "type": "claudecode",
        "options": {
          "workDir": "/path/to/repo",
          "mode": "default",
          "model": "claude-sonnet-4-20250514",
          "cmd": "claude"
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

### 3.2 示例（Feishu）

```json
{
  "configVersion": 1,
  "dataDir": "/Users/you/.d-connect",
  "log": { "level": "info" },
  "cron": { "silent": false },
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

## 4. 运行

启动守护进程：

```bash
node dist/index.js start -c ./config.json
```

或开发模式：

```bash
pnpm run dev start -c ./config.json
```

## 4.1 当前架构分层

当前代码按“组合入口 + 核心契约 + 应用服务 + 适配器 + 基础设施”组织：

- `src/bootstrap/**`：CLI 注册、daemon 启动、信号处理
- `src/core/**`：运行时契约与通用类型（`InboundMessage`、`DeliveryTarget`、`JobExecutor` 等）
- `src/services/**`：会话编排、命令处理、消息分发、项目注册
- `src/adapters/agent/**`：Agent provider 与共享 CLI session 骨架
- `src/adapters/platform/**`：平台入站解析、出站发送、格式化与平台策略
- `src/infra/**`：logging、IPC router、JSON store 等基础设施
- `src/config/**`：schema、loader、normalizer、init

## 5. CLI 与本地 IPC

守护进程启动后会监听 Unix Socket：
- `POST /send`
- `POST /cron/add`
- `GET /cron/list`
- `POST /cron/del`

CLI 对应命令：

```bash
# 交互式初始化配置
d-connect init -c ./config.json

# 主动发消息到某个项目会话
d-connect send -p my-backend -s local:debug "hello"

# cron 管理
d-connect cron add -p my-backend -s local:debug -e "*/30 * * * * *" "status"
d-connect cron list -p my-backend
d-connect cron del -i <job-id>
```

## 6. 本地调试方式

## 6.1 纯本地链路调试（不依赖 IM）

适合先验证 Agent/会话/Cron：

1. 启动守护进程

```bash
pnpm run dev start -c ./config.json
```

2. 在另一个终端发送消息

```bash
pnpm run dev send -p my-backend -s local:alice "请给我当前项目结构"
```

3. 查看多会话行为（更换 `-s`）

```bash
pnpm run dev send -p my-backend -s local:bob "你好"
```

4. 验证 cron 回投

```bash
pnpm run dev cron add -p my-backend -s local:alice -e "*/20 * * * * *" "输出一次状态"
```

说明：
- `cron` 的异步回投依赖某个 `sessionKey` 最近一次成功收到的平台消息；该发送目标会持久化到 `dataDir/sessions/sessions.json`
- 守护进程重启后，只要平台支持异步发送且该 `sessionKey` 已建立过发送目标，`cron` 仍可继续回投
- 纯 `local:<name>` 调试不会自动生成 IM 平台发送目标，因此更适合验证 runtime/IPC/cron 执行本身

## 6.2 DingTalk 联调

1. 在钉钉开放平台创建应用，开通机器人能力，选择 Stream 模式
2. 获取 `clientId/clientSecret` 写入 `config.json`
3. 启动：`pnpm run dev start -c ./config.json`
4. 在钉钉里给机器人发文本，观察终端日志与机器人回复

说明：
- 当前支持 DingTalk `text`、`richText`、`picture`、`audio`、`video`、`file`
- 富文本会提取可读文本；语音消息若携带钉钉 `recognition`，则直接把识别文本传给后端 agent，不再下载音频本体；图片/视频/文件会尝试通过 `downloadCode` 下载到本机临时目录，再把 `media_path` / `media_mime_type` 以及对应的 typed key（如 `image_path`、`video_path`、`file_path`）注入给后端 agent
- 引用文字会作为上下文前缀注入；引用图片会尝试直接下载；引用文件/视频/语音会优先按 `conversationId + msgId` 命中本地缓存，缓存失效后在群聊场景下再通过群文件 API 按时间窗口兜底下载
- 媒体下载失败时不会丢消息，至少会保留媒体占位、`media_download_code` 和 typed `*_download_code`
- 默认 `processingNotice="处理中..."` 时，若处理超过一个短延迟，会先发送一条轻量确认消息；设为 `"none"` 可关闭
- 机器人回包会在检测到标题、列表、代码块等 markdown 结构时自动切换为 DingTalk `markdown` 消息，普通短文本仍走 `text`
- DingTalk 的异步回投依赖消息里携带的 `sessionWebhook`；该 webhook 自带有效期，过期后 `cron`/重启后的异步回投会失败，直到收到新的真实钉钉消息刷新发送目标

## 6.3 Feishu 联调

1. 在飞书开放平台创建企业自建应用并开通机器人能力
2. 订阅事件：`im.message.receive_v1`
3. 获取 `appId/appSecret` 写入 `config.json`
4. 启动：`pnpm run dev start -c ./config.json`
5. 在飞书私聊或群聊 @机器人 发送文本，观察回复

说明：
- 默认 `groupReplyAll=false` 时，群聊通常需要 @机器人 才处理
- 默认 `reactionEmoji="OnIt"` 时，处理消息期间会先给原消息加一个 reaction，完成后移除；设为 `"none"` 可关闭
- v1 当前只处理文本消息

## 7. 数据目录

`dataDir` 下会持久化：
- `sessions/sessions.json`：会话状态与最近一次可用的异步发送目标
- `crons/jobs.json`：定时任务状态
- `ipc.sock`：本地 IPC socket

## 8. 测试

```bash
pnpm test
pnpm run build
```

## 9. 常见问题

1. `agent cli not found`
- 确认 CLI 已安装并在 `PATH` 中，或在 `agent.options.cmd` 写绝对路径。

2. `session is busy`
- 同一会话正在处理请求，等待当前请求结束再发送。

3. IPC 无法连接
- 先确认 `start` 已启动，并检查 `dataDir/ipc.sock` 是否存在。

4. cron 没有回投到 IM
- 先确认对应 `sessionKey` 最近至少收到过一次真实平台消息；异步回投依赖持久化的 `DeliveryTarget`。
