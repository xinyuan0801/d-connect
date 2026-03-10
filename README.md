# d-connect

> Tribute: 本项目在整体思路和使用形态上受 [cc-connect](https://github.com/chenhg5/cc-connect) 启发，感谢原项目提供的方向参考。

`d-connect` 是一个运行在本机上的守护进程，用来把本地 Agent CLI 桥接到 IM 平台。

## 它解决什么问题

- 在 IM 里直接让本地 Agent 看代码、改代码、回答问题。
- 把巡检、日报、提醒等任务交给 loop 定时执行，并自动回投聊天窗口。

## 功能展示

<table>
  <tr>
    <td align="center" valign="top" width="25%">
      <strong>定时任务</strong><br />
      <sub>聊天内直接发送 <code>/loop</code>，把自然语言需求转成可执行的定时任务。</sub><br /><br />
      <img src="https://github.com/user-attachments/assets/ffd4b955-e8c0-4123-ad51-9c1de46fd838" alt="定时任务" width="180" />
    </td>
    <td align="center" valign="top" width="25%">
      <strong>语音输入</strong><br />
      <sub>语音识别结果自动纳入同一会话流程，适合移动端快速提问。</sub><br /><br />
      <img src="https://github.com/user-attachments/assets/0f9f89f8-0ff4-4bdb-8b77-bf805729b246" alt="支持语音输入" width="180" />
    </td>
    <td align="center" valign="top" width="25%">
      <strong>图片识别与理解</strong><br />
      <sub>直接发图给 Agent，适合看图说明、读截图排障等场景。</sub><br /><br />
      <img src="https://github.com/user-attachments/assets/6315f6ea-45c1-453b-9054-f775c6ad7833" alt="图片识别" width="180" />
    </td>
    <td align="center" valign="top" width="25%">
      <strong>Guard 安全拦截</strong><br />
      <sub>支持按项目开启 Guard，在请求进入 Agent 前拦截敏感内容。</sub><br /><br />
      <img src="https://github.com/user-attachments/assets/1d3bedb5-62cf-40c2-8624-17e5154b7a6c" alt="可配置 guard 拦截" width="180" />
    </td>
  </tr>
</table>
  
## 当前支持

| 类别 | 当前支持 |
| --- | --- |
| IM 平台 | `DingTalk`、`Feishu` |
| Agent CLI | `claudecode`、`qoder`、`iflow` |
| 运行环境 | Node.js `>=22` |

## 5 分钟跑通

### 前置要求

- Node.js `>=22`
- 已安装并能直接执行至少一个 Agent CLI：`claude`、`qodercli` 或 `iflow`
- 如果要接真实 IM，还需要对应平台的机器人凭证
- 凭证获取[参考](https://github.com/xinyuan0801/d-connect/blob/main/docs/dingtalk_credential.md)

### 1. 安装

```bash
npm install -g @xinyuan0801/d-connect
```

### 2. 生成配置

```bash
d-connect init
```

执行后会进入一个交互式 TUI 向导，用来选择 Agent 类型、工作目录、`allowFrom` 访问范围（允许所有人或指定用户 ID）以及平台凭证：

<img width="446" height="344" alt="init 配置 TUI" src="https://github.com/user-attachments/assets/f75348af-8869-480f-a78e-7d88b60b06c3" />

### 3. 启动守护进程

```bash
d-connect start
```

进程启动成功后，你便可以通过钉钉和你本地的 coding agent 对话

## 配置示例

下面是一份常见的 `Claude Code + DingTalk` 配置：

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

### 关键字段

| 字段 | 含义 |
| --- | --- |
| `name` | 项目名，后续命令通过 `-p` 使用 |
| `agent.type` | Agent CLI 类型，当前支持 `claudecode` / `qoder` / `iflow` |
| `agent.options.workDir` | Agent 实际工作的仓库目录 |
| `agent.options.cmd` | 可执行命令名或完整路径 |
| `agent.options.model` | Agent 使用的模型名；留空则走对应 CLI 默认值 |
| `guard.enabled` | 是否启用项目级 Guard |
| `guard.rules` | 自定义 Guard 规则，优先级高于默认规则 |
| `platforms[].options.allowFrom` | 允许访问的用户 ID 列表；逗号分隔，`"*"` 表示全部允许；`init` 向导会显式询问此项 |

### 平台字段补充

- `DingTalk`
  - `clientId` / `clientSecret`：平台凭证
  - `processingNotice`：处理中提示；设为 `"none"` 可关闭

> [!NOTE]
> 当前所有 Agent 都默认以 `yolo` 方式运行，不再提供 `agent.options.mode` 配置项。

## 聊天内命令

在 IM 中发送 `/` 开头消息即可：

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看命令帮助 |
| `/new [name]` | 新建并切换到一个逻辑 session |
| `/list` | 列出当前聊天对象下的 session |
| `/switch <id|name>` | 切换到指定 session |
| `/stop` | 停止当前活跃 session 对应的 Agent 进程 |
| `/loop <request>` | 用自然语言描述定时任务 |
| `/loop list` | 列出当前聊天对象下的 loop |
| `/loop add <expr> <prompt>` | 直接创建 loop |
| `/loop del <id>` | 删除 loop |

这些命令的回执默认是中文提示，偶尔会夹带一点不影响下班的冷幽默。
`loop` 默认使用每条任务独立的执行会话，不继承当前聊天 session 的历史；任务结果仍会回投到创建它的那个聊天对象。

## 常用 CLI 命令

| 命令 | 作用 |
| --- | --- |
| `d-connect init` | 创建配置文件 |
| `d-connect add` | 给现有配置追加一个项目 |
| `d-connect start` | 启动本地守护进程 |
| `d-connect restart` | 重启本地守护进程 |
| `d-connect send -p <project> -s <sessionKey> "hello"` | 从本地直接向某个会话发送消息 |
| `d-connect loop add -p <project> -s <sessionKey> -e "*/30 * * * * *" "status"` | 添加 loop |
| `d-connect loop list -p <project>` | 查看项目下的 loop |
| `d-connect loop del -i <job-id>` | 删除 loop |

## 运行数据目录

运行数据固定写入 `.d-connect/`：

- 配置文件是普通路径，例如 `./config.json`，则运行目录是配置文件同级的 `.d-connect/`
- 配置文件本身位于 `.d-connect/config.json`，则直接复用该目录

常见文件：

- `.d-connect/ipc.sock`
- `.d-connect/sessions/sessions.json`
- `.d-connect/loops/jobs.json`
- `.d-connect/logs/d-connect.log`

## 本地开发

### 常用命令

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

再加一个 loop 验证调度：

```bash
pnpm run dev loop add -p my-backend -s local:alice -e "*/20 * * * * *" "输出一次状态"
```

### 目录概览

- `src/bootstrap/**`：CLI 入口与 daemon 启动编排
- `src/config/**`：配置加载、校验、`init` / `add` 向导
- `src/services/**`：会话、命令、消息 relay
- `src/adapters/agent/**`：各类 Agent CLI 适配器
- `src/adapters/platform/**`：DingTalk / Feishu 适配器
- `src/ipc/**`：本地 IPC
- `src/scheduler/**`：loop 调度与持久化
- `tests/**`：Vitest 测试

## 平台联调提示

### DingTalk

- 当前 `init` / `add` 默认生成 DingTalk 模板
- 机器人消息走 `CALLBACK`，不是普通 `EVENT`
- 收到 callback 后需要显式回执，否则平台大约 60 秒后可能重投
- 当前实现按 `msgId` 做 10 分钟去重
- 即时回复仍使用入站消息里的 `sessionWebhook`
- 异步回投/loop 会直接走机器人主动发送：群聊用 `/v1.0/robot/groupMessages/send`，单聊用 `/v1.0/robot/oToMessages/batchSend`，不再尝试 `sessionWebhook`
- 历史 `DeliveryTarget` 若缺少 `conversationType`、`robotCode`，以及群聊所需的 `openConversationId` 或单聊所需的 `userId`，需要新的真实 DingTalk 消息刷新后，loop 才能稳定主动发送
- 图片、视频、文件等入站内容会下载到 `agent.options.workDir/.d-connect/dingtalk-media`

### Feishu

- 代码已支持 Feishu
- 当前向导默认仍生成 DingTalk 模板
- 群聊默认只处理 @ 机器人的消息；如需全量处理，可打开 `groupReplyAll`
- 默认会为收到的消息加上 `OnIt` reaction，可通过 `reactionEmoji: "none"` 关闭

## 测试与构建

```bash
pnpm test
pnpm run build
```

如果你改了配置、平台适配器、IPC、调度或公共运行链路，建议不要跳过这两步。

## 常见问题

### `agent cli not found`

- 确认对应 CLI 已安装且可以在终端里直接执行
- 或在 `agent.options.cmd` 填完整命令路径

### `session is busy`

- 同一逻辑 session 正在处理上一条请求
- 等处理完成，或先 `/new` 新开一个 session

### `qoder` 调用 `AskUserQuestion` 后看起来停住

- `d-connect` 会在检测到 `AskUserQuestion` 工具调用后结束当前这一轮，避免 CLI 一直阻塞
- 聊天窗口会收到问题摘要，直接回复你的选择（例如 `dev` / `prod`）即可继续同一 `session`

### IPC 无法连接

- 确认 daemon 已启动
- 确认 `.d-connect/ipc.sock` 已生成

### loop 没有回投到 IM

- 确认该 `sessionKey` 最近收到过至少一条真实平台消息
- `loop` 默认使用按 `job.id` 隔离的执行会话；如果你在排查“为什么没继承上一轮聊天上下文”，这是当前设计，不是故障
- DingTalk 场景下，优先检查 `.d-connect/sessions/sessions.json` 里的 `DeliveryTarget` 是否带有 `conversationType`、`robotCode`，以及群聊所需的 `openConversationId` 或单聊所需的 `userId`
- 若历史 DingTalk target 缺这些主动发送字段，或只剩过期的 `sessionWebhook`，需要新的真实消息刷新
