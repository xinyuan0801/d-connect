# d-connect

> Tribute: 本项目在整体思路和使用形态上受 [cc-connect](https://github.com/chenhg5/cc-connect) 启发，感谢原项目提供的方向参考。

`d-connect` 是一个运行在本机上的小型守护进程，用来把本地 Agent CLI 接到 IM 平台里。

你可以把它理解成一层桥接：

- 在钉钉或飞书里发消息
- 消息转给你机器上的 Agent CLI
- 结果再回到原来的聊天里

它也支持多项目、多会话和定时任务，适合把“本地 agent 能力”接进日常沟通流程。

## 适合做什么

- 在钉钉或飞书里直接让本地 Agent 看代码、改代码、回答问题
- 一台机器同时接多个项目，每个项目绑定自己的工作目录和平台配置
- 在同一个聊天对象下创建多条独立 session，按任务切换上下文
- 让 Agent 按计划执行巡检、提醒、状态汇报，再把结果回推到聊天窗口
- 先用纯本地消息调通，再接入真实 IM 平台

## 当前支持

- IM 平台：`DingTalk`、`Feishu`
- Agent CLI：`claudecode`、`qoder`、`iflow`
- 运行环境：Node.js `>=22`
- 配置文件：严格 `JSON`

## 安装

已发布 npm 包：

```bash
npm install -g @xinyuan0801/d-connect
d-connect help
```

## 快速开始

### 1. 生成配置

推荐在项目目录里直接执行：

```bash
d-connect init
```

这会打开一个简单向导，帮你生成一份可用配置。默认读取的配置位置是 `~/.d-connect/config.json`。

### 2. 启动服务

```bash
d-connect start
```

启动后，`d-connect` 会在本地常驻，等待 IM 消息或本地命令。

## 配置示例

下面是一份最常见的配置示例：`Claude Code + DingTalk`

```json
{
  "configVersion": 1,
  "log": {
    "level": "info"
  },
  "loop": {
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
          "model": "claude-sonnet-4-20250514"
        }
      },
      "guard": {
        "enabled": false
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

通常只需要先关心这几个地方：

- `name`：项目名，后续命令里会用到
- `agent.type`：你要接的 Agent CLI
- `agent.options.workDir`：Agent 实际工作的仓库目录
- `platforms[0].options`：平台凭证和允许访问的用户

补充说明：

- `allowFrom: "*"` 表示允许全部用户，也可以改成逗号分隔的用户 ID
- `processingNotice: "none"` 可以关闭“处理中...”提示
- 所有 Agent 默认以 `yolo` 方式运行，不再提供单独的 `agent.options.mode` 配置
- 如果你想接 `Feishu`，把 `platforms` 里的平台类型和凭证改成飞书配置即可

## 常用命令

```bash
d-connect init
d-connect add
d-connect start
d-connect send -p <project> -s <sessionKey> "hello"
d-connect loop add -p <project> -s <sessionKey> -e "*/30 * * * * *" "status"
d-connect loop list -p <project>
d-connect loop del -i <job-id>
```

简单理解：

- `init`：创建配置文件
- `add`：往现有配置里追加一个项目
- `start`：启动本地守护进程
- `send`：从本地直接给某个会话发一条消息
- `loop add/list/del`：管理定时任务

## 聊天里可用的命令

当你在 IM 里发送以 `/` 开头的消息时，会走内置命令：

```text
/help
/new [name]
/list
/switch <id|name>
/loop <request>
/loop list
/loop add <expr> <prompt>
/loop del <id>
```

常见用途：

- `/new`：新开一个逻辑 session
- `/list`：查看当前聊天对象下已有的 session
- `/switch`：切换到别的 session
- `/loop <request>`：用自然语言描述一个定时任务，让 Agent 帮你整理成可执行命令
- `/loop ...`：直接在聊天里管理定时任务

## 本地开发

这一部分保留给本地联调、测试和实现相关说明。

### 开发命令

```bash
pnpm install
pnpm run build
pnpm test
pnpm run dev init -c ./config.json
pnpm run dev add -c ./config.json
pnpm run dev start -c ./config.json
pnpm run dev send -p <project> -s local:debug "hello"
pnpm run dev loop add -p <project> -s local:debug -e "*/30 * * * * *" "status"
pnpm run dev loop list -p <project>
```

### 配置位置

文档默认使用 `~/.d-connect/config.json` 这份配置。本地开发如果要切换到别的配置文件，再显式传 `-c`。

### 运行数据目录

运行数据固定写入 `.d-connect/`：

- 如果配置文件是普通路径，例如 `./config.json`，运行数据目录就是“配置文件同级的 `.d-connect/`”
- 如果配置文件本身就在 `.d-connect/config.json`，则直接复用这个 `.d-connect/`

常见文件包括：

- `.d-connect/ipc.sock`
- `.d-connect/sessions/sessions.json`
- `.d-connect/loops/jobs.json`
- `.d-connect/logs/d-connect.log`

`dataDir` 配置项已经不再支持，旧配置需要删除该字段。

### 本地联调

先启动 daemon：

```bash
pnpm run dev start -c ./config.json
```

另一个终端发送消息：

```bash
pnpm run dev send -p my-backend -s local:alice "请给我当前项目结构"
pnpm run dev send -p my-backend -s local:bob "你好"
```

再加一个 loop 看调度是否正常：

```bash
pnpm run dev loop add -p my-backend -s local:alice -e "*/20 * * * * *" "输出一次状态"
```

这里的 `local:<name>` 不依赖真实 IM 平台，适合先验证 runtime、IPC、session 和 loop。

### DingTalk 联调提示

- 当前 `init` / `add` 默认生成 `DingTalk` 模板
- DingTalk 机器人消息走 `CALLBACK`，不是普通 `EVENT`
- 收到 callback 后需要显式回执，否则平台可能会在约 60 秒后重投同一条消息
- 当前实现会按 `msgId` 做 10 分钟去重
- 异步回投依赖入站消息里的 `sessionWebhook`，过期后需要新的真实消息刷新
- 图片、视频、文件等入站内容通常会下载到 `agent.options.workDir/.d-connect/dingtalk-media`

### Feishu 说明

- 代码已经支持 `Feishu`
- 当前向导默认仍生成 `DingTalk` 模板
- 如果你要接飞书，直接把 `platforms` 里的平台配置改成 `feishu` 即可

### 目录概览

- `src/bootstrap/**`：CLI 入口和 daemon 启动编排
- `src/config/**`：配置加载、校验和 init/add 向导
- `src/services/**`：会话、命令、消息 relay
- `src/adapters/agent/**`：各类 Agent CLI 适配器
- `src/adapters/platform/**`：钉钉、飞书适配器
- `src/ipc/**`：本地 IPC
- `src/scheduler/**`：loop 调度与持久化
- `tests/**`：Vitest 测试

### 测试与构建

```bash
pnpm test
pnpm run build
```

如果你改了配置、平台适配器、IPC、调度或公共运行链路，建议不要跳过这两步。

### 常见问题

`agent cli not found`

- 确认对应 CLI 已安装，并且可以在终端里直接执行
- 或在 `agent.options.cmd` 里写完整命令路径

`session is busy`

- 同一个逻辑 session 还在处理上一条请求
- 等它结束，或者先用 `/new` 新开一个 session

IPC 无法连接

- 确认 daemon 已启动
- 确认 `.d-connect/ipc.sock` 已生成

loop 没有回投到 IM

- 先确认这个 `sessionKey` 最近收到过至少一条真实平台消息
- DingTalk 场景下再检查 `sessionWebhook` 是否已经过期
