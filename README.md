# d-connect

本项目用于将本地 Agent CLI（Claude Code / Codex / Qoder CLI / OpenCode / iFlow CLI）桥接到 IM 平台。

当前版本支持：
- 平台：DingTalk、Feishu（飞书）
- Agent：`claudecode`、`codex`、`qoder`、`opencode`、`iflow`
- 配置格式：`JSON`（不支持 JSONC 注释）

## 1. 环境要求

- Node.js >= 22
- macOS 或 Linux
- 对应 Agent CLI 已安装并可在终端执行（或在配置中指定 `cmd`）

## 2. 安装

```bash
npm install
npm run build
```

可选：
- 开发模式运行（不先 build）：`npm run dev -- <args>`
- 构建后运行：`node dist/index.js <args>`

## 3. 配置文件

配置文件优先级：
1. `-c / --config` 指定路径
2. `./config.json`
3. `~/.d-connect/config.json`

首次启动若配置不存在，会自动生成模板并退出：

```bash
node dist/index.js start -c ./config.json
```

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
            "allowFrom": "*"
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
        "type": "codex",
        "options": {
          "workDir": "/path/to/repo",
          "cmd": "codex"
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
npm run dev -- start -c ./config.json
```

## 5. CLI 与本地 IPC

守护进程启动后会监听 Unix Socket：
- `POST /send`
- `POST /cron/add`
- `GET /cron/list`
- `POST /cron/del`

CLI 对应命令：

```bash
# 主动发消息到某个项目会话
node dist/index.js send -p my-backend -s local:debug "hello"

# cron 管理
node dist/index.js cron add -p my-backend -s local:debug -e "*/30 * * * * *" "status"
node dist/index.js cron list -p my-backend
node dist/index.js cron del -i <job-id>
```

## 6. 本地调试方式

## 6.1 纯本地链路调试（不依赖 IM）

适合先验证 Agent/会话/Cron：

1. 启动守护进程

```bash
npm run dev -- start -c ./config.json
```

2. 在另一个终端发送消息

```bash
npm run dev -- send -p my-backend -s local:alice "请给我当前项目结构"
```

3. 查看多会话行为（更换 `-s`）

```bash
npm run dev -- send -p my-backend -s local:bob "你好"
```

4. 验证 cron 回投

```bash
npm run dev -- cron add -p my-backend -s local:alice -e "*/20 * * * * *" "输出一次状态"
```

## 6.2 DingTalk 联调

1. 在钉钉开放平台创建应用，开通机器人能力，选择 Stream 模式
2. 获取 `clientId/clientSecret` 写入 `config.json`
3. 启动：`npm run dev -- start -c ./config.json`
4. 在钉钉里给机器人发文本，观察终端日志与机器人回复

## 6.3 Feishu 联调

1. 在飞书开放平台创建企业自建应用并开通机器人能力
2. 订阅事件：`im.message.receive_v1`
3. 获取 `appId/appSecret` 写入 `config.json`
4. 启动：`npm run dev -- start -c ./config.json`
5. 在飞书私聊或群聊 @机器人 发送文本，观察回复

说明：
- 默认 `groupReplyAll=false` 时，群聊通常需要 @机器人 才处理
- 默认 `reactionEmoji="OnIt"` 时，处理消息期间会先给原消息加一个 reaction，完成后移除；设为 `"none"` 可关闭
- v1 当前只处理文本消息

## 7. 数据目录

`dataDir` 下会持久化：
- `sessions/sessions.json`：会话状态
- `crons/jobs.json`：定时任务状态
- `ipc.sock`：本地 IPC socket

## 8. 测试

```bash
npm test
npm run build
```

## 9. 常见问题

1. `agent cli not found`
- 确认 CLI 已安装并在 `PATH` 中，或在 `agent.options.cmd` 写绝对路径。

2. `session is busy`
- 同一会话正在处理请求，等待当前请求结束再发送。

3. IPC 无法连接
- 先确认 `start` 已启动，并检查 `dataDir/ipc.sock` 是否存在。
