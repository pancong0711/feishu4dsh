# 配置参考

配置来源优先级：**入口配置（`cordis.patch.yml` / 环境变量）→ settings 用户文档**。所有字段均可省略，未填写取默认值。

## 凭据（必填）

| 字段 | 环境变量建议 | 默认 | 说明 |
|---|---|---|---|
| `appId` | `FEISHU_APP_ID` | — | 飞书自建应用 App ID（`cli_...`） |
| `appSecret` | `FEISHU_APP_SECRET` | — | App Secret |

两者缺失时插件不启动传输，控制台打印配置指引。

## 传输

| 字段 | 默认 | 说明 |
|---|---|---|
| `domain` | `feishu` | `feishu`（国内）或 `lark`（国际版） |
| `connectionMode` | `websocket` | `websocket` 长连接（推荐，无需公网）或 `webhook` |
| `verificationToken` | — | webhook 模式：飞书「加密策略」中的 Verification Token |
| `encryptKey` | — | webhook 模式：Encrypt Key（消息加密） |
| `webhookPort` | `3081` | webhook 模式本地监听端口，回调地址为 `https://<host>:<port>/webhook/event` |

## 会话与输出

| 字段 | 默认 | 说明 |
|---|---|---|
| `sessionScope` | `chat` | `chat`（整个聊天一个会话）/ `chat-thread`（按话题）/ `chat-sender`（按发送人） |
| `requireMention` | `true` | 群聊是否需要 @ 机器人 |
| `output` | `stream` | `stream` 流式逐块输出 / `card` 单卡片聚合 |
| `showProcess` | `true` | 是否展示每轮聚合的工具调用与 Token 用量摘要；例如“调用工具 bash × 3 次 · Token：输入 1,234 · 输出 56 · 缓存读 890”，并跟随入站消息的 `replyTo` 显示在话题内 |
| `locale` | `auto` | 渠道文案语言；`auto` 无提示时默认 zh-CN |

> **话题/线程说明**：飞书话题 = thread。`sessionScope: chat` 时所有话题共享一个 Agent 会话；`chat-thread` 时每个话题独立会话。`/status` 显示的是配置原文（如 `chat` / `chat-thread`），不是自动判断的“话题”。

## 工作区

dsh 把每个 Agent 会话根植（root）在一个工作区内，并把写操作限制在其中。插件的会话身份是 **(会话 scope × 工作区)**；在飞书里可用 `/ws` 与 `/cd` 查看、切换工作区，也可以在聊天（含手机端）中把 Agent 指向另一个目录。

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | 宿主进程 cwd | 默认工作区；入站收件箱与 `send_file` 都以其为准 |
| `workspaceRoots` | `[]` | `/cd` 可进入的目录前缀列表。**为空时只允许默认工作区与已注册工作区**（安全默认） |
| `chatWorkspaces` | `{}` | 隐藏字段：`/cd` 持久化的「scopeKey→工作区」映射，运行时写入，勿手改 |
| `userWorkspaces` | `[]` | 隐藏字段：`/ws add` 添加的工作区路径列表，运行时写入，勿手改 |

切换规则（`/cd`）：
- **权限**（R11）：与 `/ws add`、`/model` 一致，沿用审批 ACL——配置了 `approvers` 时仅名单内可切换，未配置时由会话驱动者操作；无权时回复「无权切换工作区」。
- 目标 = **默认工作区**，或 **宿主 `workspaceRegistry` 中已注册的工作区**，或 **`/ws add` 添加的工作区** → 允许；
- 目标在 `workspaceRoots` 某个前缀之内 → 允许；
- 其余一律拒绝（目录不存在会提示 `not_found`，不在范围内提示 `not_allowed`）。
- 切换后写入 settings（`chatWorkspaces`），重启后自动恢复；切回原工作区会复用原会话，不会串上下文。切换**无需 `/new`**（见下）。
- **路径校验**（R10/R11）：凡是进入 `chatWorkspaces` / `userWorkspaces` / 新话题继承的工作区路径，使用前都会校验为**真实存在且规范化的目录**，三级兜底：坏值 → 默认工作区 → 守护进程 cwd，逐级控制台告警，保证 `/status` 显示的工作区与 Agent 实际可写目录始终一致。若看到 `workspace ... is not a real directory ... fix the 'workspace' setting` 告警，说明默认工作区本身失效，请尽快修配置。**勿手改隐藏字段；若曾手改出含空格/失效路径，删除空格或补正为无空格绝对路径后重启 feishu4dsh 即可。**
- **关于 `/new`**：`/cd` 与 `/model` 都是即时改绑定、下一轮生效，**不需要也不应该用 `/new` 来"确保切换成功"**；`/new` 只用于清空当前工作区的上下文，模型 pin 与工作区绑定均保持不变（详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3「切换模型/工作区」）。

手机侧管理工作区（无需改配置重启）：
- `/ws add <绝对路径>`：把一个**已存在的目录**登记为可用工作区（含存在性/目录校验），之后即可 `/cd` 进入；持久化到 settings。
- `/ws remove <名称或路径>`：移除 `/ws add` 添加的工作区；默认与宿主注册的工作区**不可移除**。
- **权限**：两者均属扩权操作，沿用审批 ACL——配置了 `approvers` 时仅名单内可操作，未配置时由会话驱动者操作；每次操作在控制台留痕。**群聊建议配置 `approvers`**。


## 媒体

| 字段 | 默认 | 说明 |
|---|---|---|
| `receiveFiles` | `true` | 入站文件/音频/视频/图片落入 `<workspace>/.feishu4dsh/inbox/<消息键>/` |
| `maxReceiveFileBytes` | `20971520`（20 MiB） | 单入站文件上限，非法值回退默认 |
| `maxMessageReceiveBytes` | `1073741824`（1 GiB） | 单条消息所有入站附件总大小上限 |
| `saveImagesToInbox` | `true` | 图片是否也保存到工作区 inbox（关闭时仅按 `attachImages` 决定是否给模型） |
| `attachImages` | `false` | 图片是否作为模型可见附件（需模型支持视觉 + 宿主 attachments 服务） |
| `sendFiles` | `true` | 是否给 Agent 注册 `send_file` 工具 |
| `maxSendFileBytes` | `20971520` | 单出站文件上限 |

未开启视觉且 `saveImagesToInbox: false` 时的图片、超限文件、不支持的类型，都会以**注记**形式随消息交给模型——模型至少知道「收到了但没拿到」。

## 审批与授权

| 字段 | 默认 | 说明 |
|---|---|---|
| `approvalTimeoutMs` | `300000`（5 分钟） | 审批卡超时，下限 10 秒；超时按拒绝处理 |
| `senderAllowlist` | `[]` | 允许私聊的 open_id；空 = 应用可见范围内的任何人 |
| `groupAllowlist` | `[]` | 允许服务的群 chat_id；空 = 机器人所在的任何群 |
| `approvers` | `[]` | 可点击允许/拒绝的 open_id；空 = 谁驱动会话谁审批 |

白名单**只收窄、不放行**：可触达范围本身由飞书应用的「可用范围」决定。

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
        # workspaceRoots: ['/path/to/projects']   # 允许 /cd 进入的目录前缀
        # senderAllowlist: ['ou_xxx']
        # groupAllowlist: ['oc_xxx']
        # approvers: ['ou_admin']
```

> `!!js`（双感叹号）表示「在配置解析期求值的环境表达式」；单感叹号 `!js` 语义不同，勿混用。
