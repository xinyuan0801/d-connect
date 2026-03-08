# 获取钉钉应用 `Client ID` 和 `Client Secret`

本文用于说明如何为 `d-connect` 创建一个钉钉应用，并拿到配置里需要的 `clientId` 和 `clientSecret`。

> 截图参考来源：[阿里云文档：快速部署并使用 OpenClaw](https://help.aliyun.com/zh/simple-application-server/use-cases/quickly-deploy-and-use-openclaw)

## 前提条件

- 你有可登录 [钉钉开放平台](https://open-dev.dingtalk.com/) 的账号。
- 你已经加入某个组织，并拥有该组织的开发者权限。
- 如果登录后提示选择组织，请选择有开发者权限的组织；如果没有，需要先向组织管理员申请。

## 1. 创建钉钉应用

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com/) 并登录。
2. 选择一个有开发者权限的组织。
3. 进入“钉钉应用”页面，点击右上角“创建应用”。
4. 填写应用名称和应用描述。
5. 上传应用图标后点击“保存”。

完成后，你会进入该应用的开发控制台。

![选择组织](./dingtalk-client-credentials-assets/select-organization.png)

![创建应用入口](./dingtalk-client-credentials-assets/create-app-entry.png)

## 2. 给应用添加机器人能力

1. 在左侧菜单中进入“添加应用能力”。
2. 找到“机器人”能力卡片并点击“添加”。
3. 在机器人配置页打开机器人开关。
4. 消息接收模式选择 `Stream` 模式。
5. 按页面提示完成其他必填项后，点击“发布”。

说明：

- 机器人消息预览图只是群里添加机器人时的展示素材。
- 首次调试时可以先上传一张符合格式要求的占位图片，后续再调整。

![添加机器人能力](./dingtalk-client-credentials-assets/add-bot-capability.png)

![机器人配置](./dingtalk-client-credentials-assets/bot-config.png)

## 3. 发布一个应用版本

如果这个应用需要被企业内其他成员使用，或者你希望配置正式生效，通常还需要发布一个版本。

1. 进入目标应用。
2. 在左侧菜单打开“版本管理与发布”。
3. 点击“创建新版本”。
4. 填写版本号和版本描述。
5. 选择合适的应用可见范围。
6. 点击“保存”，然后在弹窗中确认发布。

建议先确认应用对测试人员可见，否则即使机器人能力已配置，后续联调也可能找不到应用。

![进入目标应用](./dingtalk-client-credentials-assets/app-list.png)

![创建新版本](./dingtalk-client-credentials-assets/create-version.png)

## 4. 获取 `Client ID` 和 `Client Secret`

1. 在目标应用左侧菜单中进入“凭证与基础信息”。
2. 在页面中找到应用凭证区域。
3. 复制 `Client ID`。
4. 复制 `Client Secret`。

这两个值就是 `d-connect` 钉钉平台配置里需要填写的凭证。

![复制 Client ID 和 Client Secret](./dingtalk-client-credentials-assets/client-id-secret.png)

## 5. 回填到 `d-connect` 配置

在项目配置文件中，把钉钉平台块写成类似下面这样：

```json
{
  "type": "dingtalk",
  "options": {
    "clientId": "dingxxxx",
    "clientSecret": "xxxx",
    "allowFrom": "*",
    "processingNotice": "处理中..."
  }
}
```

如果你使用的是 `d-connect init` 生成配置，只需要把向导里对应的钉钉凭证替换成刚刚复制出来的值即可。

## 常见问题

### 登录开放平台后看不到“创建应用”

通常是当前选择的组织没有开发者权限。切换到另一个组织，或者先向管理员申请开发者权限。

### 已经配置机器人，但 `d-connect` 还是收不到消息

优先检查下面几项：

- 机器人接收模式是否为 `Stream`。
- 应用版本是否已经发布。
- 当前测试用户是否在应用可见范围内。
- 配置里的 `clientId` 和 `clientSecret` 是否复制正确。