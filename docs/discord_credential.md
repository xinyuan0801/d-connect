# 获取 Discord `botToken` 和 `allowFrom` 所需用户 ID

本文用于说明如何为 `d-connect` 创建一个 Discord Bot，并拿到配置里需要的：

- `platform.options.botToken`
- `platform.options.allowFrom` 里要填的 Discord 用户 ID

> 这条接入链路的鉴权方式与 openclaw 常见做法一致，都是直接使用标准 Discord `Bot Token`。

## 前提条件

- 你可以登录 [Discord Developer Portal](https://discord.com/developers/applications)
- 你有一个可用于测试的 Discord 服务器，并且在该服务器里有添加应用 / bot 的权限
- 你的 `d-connect` 版本已经包含 `discord` 平台支持

## 1. 创建一个 Discord Application

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)。
2. 点击右上角 `New Application`。
3. 输入应用名称并创建。
4. 创建完成后会进入应用详情页；这里可以按需补充图标、描述等基础信息。

如果你后面需要手动拼授权链接，也可以在这里顺手记下 `Application ID`。

## 2. 创建 Bot 并生成 `botToken`

1. 在左侧进入 `Bot` 页面。
2. 如果页面还没有 bot，先创建一个 bot user。
3. 在 `Token` 区域生成或重置 token。
4. 立即复制并妥善保存这个 token。

这个值就是 `d-connect` 配置里的 `platform.options.botToken`。

注意：

- `Bot Token` 非常敏感，不要提交到 Git 仓库，也不要发到群里。
- 如果你怀疑 token 已泄露，直接在 `Bot` 页面重置它，再同步更新本地配置。

## 3. 开启 `MESSAGE CONTENT INTENT`

`d-connect` 当前的 Discord 适配器通过 Gateway 接收普通消息，并依赖消息正文驱动 Agent。对群聊来说，这意味着你通常需要打开 `MESSAGE CONTENT INTENT`。

操作方式：

1. 仍然在应用的 `Bot` 页面。
2. 找到 `Privileged Gateway Intents` 区域。
3. 打开 `Message Content Intent`。
4. 保存修改。

补充说明：

- 按 Discord 当前文档，未验证、且规模还不大的 bot，一般可以直接在这里打开。
- 如果你的 bot 后续进入较多服务器并触发验证/审批要求，可能还需要在 Developer Portal 里申请该 privileged intent。
- 即使没有这个 intent，`DM` 和显式 `@bot` 的消息仍可能带正文；但普通群消息正文可能会变空，不适合作为 `d-connect` 的主链路。

## 4. 把 Bot 安装到测试服务器

你可以用两种方式安装，选一种即可。

### 方式 A：使用 `Installation` 页面默认安装链接

1. 打开左侧 `Installation` 页面。
2. 确认 `Guild Install` 已开启。
3. 在默认安装设置里至少给 bot 加上这些能力：
   - 读取目标频道
   - 发送消息
   - 读取历史消息
4. 复制安装链接并在浏览器里打开。
5. 选择你的测试服务器并完成安装。

### 方式 B：使用 `OAuth2` -> `URL Generator`

1. 打开左侧 `OAuth2` -> `URL Generator`。
2. 勾选 `bot` scope。
3. 选择 bot 需要的最小权限。
4. 复制生成的 URL，在浏览器中打开并完成安装。

安装完成后，bot 应该会出现在服务器成员列表里。

## 5. 获取 `allowFrom` 需要的用户 ID

`d-connect` 的 `allowFrom` 对 Discord 平台使用的是 Discord 用户 ID，不是用户名。

先打开 Developer Mode：

1. 在 Discord 客户端进入 `User Settings`。
2. 打开 `Advanced`。
3. 启用 `Developer Mode`。

然后复制用户 ID：

1. 在 Discord 里右键目标用户头像、用户名，或消息中的用户名。
2. 点击 `Copy ID`。
3. 把复制出来的数字字符串填进 `allowFrom`。

如果你要允许多个人访问，用英文逗号分隔，例如：

```text
123456789012345678,234567890123456789
```

如果只是本地测试，也可以临时写成 `"*"`，但这意味着任何能给 bot 发消息的人都可能触发本地 Agent。

## 6. 回填到 `d-connect` 配置

平台块可以写成这样：

```json
{
  "type": "discord",
  "options": {
    "botToken": "discord-bot-token",
    "allowFrom": "123456789012345678",
    "requireMention": true
  }
}
```

字段说明：

- `botToken`：上面复制到的 Bot Token
- `allowFrom`：允许访问的 Discord 用户 ID；多个 ID 用逗号分隔
- `requireMention`：群聊里是否要求显式 `@bot` 或回复 bot 消息；默认建议保持 `true`

如果你使用 `d-connect init` 或 `d-connect add`：

- 在平台选择里选 `Discord`
- 把 `botToken` 粘进去
- 再按需要选择 `allowFrom` 和 `requireMention`

## 常见问题

### Bot 已经进服务器了，但群聊里发普通消息没反应

优先检查下面几项：

- `Message Content Intent` 是否已经打开
- 当前发消息的用户 ID 是否在 `allowFrom` 里
- 你的配置里是否启用了 `requireMention: true`
- 如果启用了 `requireMention: true`，你是否真的在群里 `@bot` 了，或者是在回复 bot 的消息

### 可以私聊 bot，但群聊里正文像是读不到

这通常是 `MESSAGE CONTENT INTENT` 没开，或者 bot 后续进入较多服务器后没有完成对应的 privileged intent 审批。

### 我只知道用户名，不知道用户 ID

先打开 Discord 的 `Developer Mode`，然后右键用户选择 `Copy ID`。`allowFrom` 不能直接写用户名，因为用户名和昵称都可能变化。

### 需要 `Application ID` 吗

`d-connect` 当前接 Discord 平台只需要 `botToken` 和 `allowFrom`。`Application ID` 在手动生成安装链接时会比较有用，但不是运行时必填项。

## 参考资料

- [Discord Developer Docs: Developing A User-Installable App](https://docs.discord.com/developers/tutorials/developing-a-user-installable-app)
- [Discord Developer Docs: Gateway](https://docs.discord.com/developers/events/gateway)
- [Discord Help: How do I get Privileged Intents for my bot?](https://support-dev.discord.com/hc/en-us/articles/6205754771351-How-do-I-get-Privileged-Intents-for-my-bot)
- [Discord Help: Message Content Privileged Intent FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055-Message-Content-Privileged-Intent-FAQ)
- [Discord Help: Where can I find my Application/Team/Server ID?](https://support-dev.discord.com/hc/en-us/articles/360028717192-Where-can-I-find-my-Application-Team-Server-ID)
