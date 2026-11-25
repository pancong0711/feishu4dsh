# 配置参考

feishu4dsh 的配置由 Cordis profile patch / settings 提供，凭据建议通过环境文件注入。字段分为传输、会话、工作区、输出、审批与文案几类。

## 传输与凭据

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | — | 飞书/Lark 自建应用 App ID |
| `appSecret` | — | 飞书/Lark App Secret；建议放 systemd EnvironmentFile |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `connectionMode` | `websocket` | `websocket` 长连接或 `webhook` |
| `verificationToken` | — | webhook 模式校验 token |
| `encryptKey` | — | webhook 模式加密 key |
| `webhookPort` | `3081` | webhook 监听端口 |
| `requireMention` | `true` | 群聊是否必须 @ 机器人 |

## 会话与工作区

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | 进程 cwd | 默认工作区 |
| `workspaceRoots` | `[]` | `/cd` 可进入的目录前缀 |
| `sessionScope` | `chat` | `chat` / `chat-thread` / `chat-sender` |
| `agentPreset` | `standard` | 新会话默认 preset |
| `chatPresets` | `{}` | `/mode` 持久化 map（运行时字段） |
| `chatWorkspaces` | `{}` | `/cd` 持久化 map（运行时字段） |
| `userWorkspaces` | `[]` | `/ws add` 持久化列表（运行时字段） |
| `chatSessions` | `{}` | 会话注册表（运行时字段） |
| `chatActiveGen` | `{}` | 活动代次指针（运行时字段） |

## 输出与推理

| 字段 | 默认 | 说明 |
|---|---|---|
| `output` | `stream` | `stream` 或 `card` |
| `showProcess` | `true` | 显示工具/耗时/Token 过程行 |
| `showReasoning` | `true` | 显示 reasoning 折叠面板 |
| `chatReasoning` | `{}` | `/reasoning` 持久化 map |
| `modelCatalog` | `[]` | `/model` 点选清单 |
| `modelEfforts` | `{}` | `provider/model` 推理强度偏好 |

## 文件与审批

| 字段 | 默认 | 说明 |
|---|---|---|
| `receiveFiles` | `true` | 接收入站文件 |
| `maxReceiveFileBytes` | 20 MiB | 单文件上限 |
| `maxMessageReceiveBytes` | 1 GiB | 单消息媒体总量上限 |
| `saveImagesToInbox` | `true` | 图片落工作区 inbox |
| `attachImages` | `false` | 图片送入视觉模型 |
| `sendFiles` | `true` | 允许出站文件 |
| `maxSendFileBytes` | 20 MiB | 出站文件上限 |
| `approvalTimeoutMs` | 300000 | 审批超时，下限 10 秒 |
| `senderAllowlist` | `[]` | 私聊 open_id 白名单 |
| `groupAllowlist` | `[]` | 群 chat_id 白名单 |
| `approvers` | `[]` | 审批/管理操作 open_id 白名单 |

白名单只收窄；应用可见范围仍由飞书侧控制。

## 文案

| 字段 | 默认 | 说明 |
|---|---|---|
| `locale` | `auto` | `auto` / `zh-CN` / `en-US` |

## cordis.patch.yml 示例

```yaml
- insert:
    - id: feishu4dsh
      name: 'feishu4dsh'
      config:
        appId: !!js process.env.FEISHU_APP_ID
        appSecret: !!js process.env.FEISHU_APP_SECRET
        sessionScope: chat-thread
        requireMention: true
        output: stream
        showProcess: true
        # workspace: /path/to/default-workspace
        # workspaceRoots: ['/path/to/projects']
        # senderAllowlist: ['ou_xxx']
        # groupAllowlist: ['oc_xxx']
        # approvers: ['ou_admin']
```

> `!!js` 表示配置解析期求值；单感叹号 `!js` 语义不同，勿混用。

## 边界

SHE agent control plane（任务、agent/sandbox/broker、`/she`）已迁移到独立项目 `2611she`。本插件配置中不包含 `secretary*` 或 `she*` 字段。
