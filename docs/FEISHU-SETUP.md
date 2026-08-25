# 飞书开放平台应用创建指南

本插件需要一个**企业自建应用**并启用**机器人**能力。WebSocket 模式只需 App ID / App Secret 两项；Webhook 模式另需 Verification Token 与 Encrypt Key。

## 1. 创建应用

1. 打开 [open.feishu.cn](https://open.feishu.cn)（国际版 [open.larksuite.com](https://open.larksuite.com)），扫码登录。
2. 「开发者后台 → 创建企业自建应用」，填写名称（即机器人显示名）与描述。
3. 在「凭证与基础信息」复制 **App ID**；点击「重置」获取 **App Secret**。

## 2. 启用机器人能力

「应用能力 → 机器人」开启机器人能力。

## 3. 配置事件订阅

「事件与回调 → 事件配置」：

- **订阅方式**：
  - WebSocket 模式（推荐）：选择 **「使用长连接接收事件」**。无需公网地址。
  - Webhook 模式：选择「将事件发送至开发者服务器」，填回调地址 `https://<host>:<webhookPort>/webhook/event`，并在「加密策略」获取 Verification Token / Encrypt Key。
- **添加事件**（至少前两项）：

| 事件 | 用途 | 必需 |
|---|---|---|
| `im.message.receive_v1` | 接收用户/群消息 | ✅ |
| `card.action.trigger` | 卡片按钮回调（审批/文件确认） | ✅ |
| `im.message.message_read_v1` | 消息已读回执 | 可选 |

## 4. 配置权限

「权限管理」中添加（或批量导入）：

```jsonc
{
  "scopes": {
    "tenant": [
      "im:message",                 // 发送与接收消息
      "im:message:send_as_bot",     // 以机器人身份发送
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:readonly",
      "im:resource",                // 读取消息中的图片/文件资源
      "im:chat",                    // 获取群信息
      "cardkit:card:write"          // 卡片写入（更新审批卡状态）
    ]
  }
}
```

## 5. 发布应用

「版本管理与发布 → 创建版本 → 申请发布」。企业自建应用需管理员审核通过后，机器人才能被搜索到。**可用范围决定谁能找到机器人**——这是第一道授权边界（见 CONFIG.md 的白名单说明）。

## 6. 接入与验证

启动 `dsh web` 后，控制台出现：

```
[feishu4dsh reach: DMs from ... ; groups: ... ; approvals by ...]
[feishu4dsh: connected as <机器人名> (cli_...)]
```

在飞书搜索机器人名发送「你好」即可收到回复。群聊先把机器人拉进群，再 @它。

## 常见问题

| 现象 | 排查 |
|---|---|
| 启动打印 `no appId/appSecret configured` | 环境变量 / patch 配置未生效，重启 dsh |
| WebSocket 握手失败 | 检查网络可达飞书域名；确认 App Secret 正确 |
| 群里 @ 无响应 | 应用未发布 / 事件未加 `im.message.receive_v1` / 权限未审批 |
| 点按钮报错 | 事件订阅缺少 `card.action.trigger`；卡片 15 分钟回调窗口过期 |
| 收不到文件/图片 | 缺少 `im:resource` 权限或事件权限未生效 |
