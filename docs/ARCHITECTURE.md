# 架构设计：把 Hermes 飞书适配器的思路移植到 dsh

## 1. 出发点

共享会话中的结论是：Hermes Agent 的飞书官方支持是 **MIT 许可**、且以**独立平台适配器**（`gateway/platforms/feishu.py` + `plugins/platforms/feishu/adapter.py`）形态存在的能力模块——WebSocket/Webhook 双模式、多消息类型、交互卡片与按钮回调、去重、限流、@提及控制。它可以被提取、移植到其他 AI Agent，关键工作是补一层**对接层（胶水代码）**：

1. **接收事件**：从适配器拿到标准化消息事件；
2. **调用 Agent**：转成目标 Agent 能理解的输入并驱动执行；
3. **发送回复**：把 Agent 输出经由适配器接口送回 IM。

本仓库把这条路线在 **DeepSeek Harness（dsh）** 上落地，产出一个完整的 dsh 插件代码库，实现同等效果：**dsh Agent 以飞书机器人的形态工作**。

与直接复制 Hermes Python 代码不同，dsh 是 TypeScript/Cordis 运行时，且飞书官方 Node SDK（`@larksuiteoapi/node-sdk` 1.73+）已内置与 Hermes 传输层同级的通道能力 `LarkChannel`。因此移植策略是：

> **传输层复用官方 SDK 的 `LarkChannel`（等价于 Hermes `gateway/platforms/feishu.py`），原创实现对接层（等价于移植所需的胶水代码），宿主契约集中在 `src/host.ts`。**

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│ 飞书开放平台（应用 / 事件订阅 / 卡片回调）                     │
└───────────────▲───────────────────────────┬─────────────────┘
                │ WebSocket 长连接 / Webhook │ OpenAPI
┌───────────────┴───────────────┐   ┌───────▼─────────────────┐
│ @larksuiteoapi/node-sdk        │   │ 发送 / 流式 / 卡片更新 /  │
│  LarkChannel（传输层）          │   │ 上传下载 / Reaction       │
│  · 事件去重 · 同聊天串行队列     │   └───────▲─────────────────┘
│  · 白名单/@提及策略 · 限流重试   │           │
└───────────────▲───────────────┘           │
                │ NormalizedMessage /        │ ChannelPort（窄接口）
                │ CardActionEvent / Reject   │
┌───────────────┴───────────────────────────┴─────────────────┐
│ bridge.ts（对接层 / 胶水）                                    │
│  · 会话映射 scopeKey → sessionId → AgentLedger               │
│  · 入站媒体 → 收件箱/附件块      · 回复流（stream/card）       │
│  · 斜杠命令派发                 · 审批瀑布应答（卡片+超时）     │
│  · send_file 出站（群聊审批卡）  · i18n 文案                   │
└───────────────▲───────────────────────────▲─────────────────┘
                │ agents / session/event /   │ Context
                │ approval/request           │
┌───────────────┴───────────────────────────┴─────────────────┐
│ dsh 宿主（Cordis 组合）：agents 注册表 · session 日志 ·        │
│ tools · commands · settings · attachments · llm …            │
└─────────────────────────────────────────────────────────────┘
```

## 3. 模块职责

| 模块 | 职责 | 对应 Hermes 概念 |
|---|---|---|
| `src/adapter.ts` | 组装 `LarkChannel`、webhook 端点，暴露窄接口 `ChannelPort` | `gateway/platforms/feishu.py` 的传输职责 |
| `src/bridge.ts` | 对接层：消息↔会话↔Agent、回复渲染、审批、命令、媒体、工作区切换 | 移植指南中的「胶水代码层」 |
| `src/sessions.ts` | 会话身份 **(scope × workspace × generation)** → 确定性 agentKey/sessionId；`/new` 代数递增 | Hermes 的会话隔离/话题隔离 |
| `src/workspaces.ts` | 工作区目录构建、`/cd` 解析与准入校验（纯函数） | —（dsh 写限制特有） |
| `src/acl.ts` | 部署级授权：发送人/群收窄、审批人名单 | Hermes 白名单与 group policy |
| `src/cards.ts` | 卡片 JSON 构建与动作载荷编解码（纯函数） | Hermes 交互卡片与按钮回调 |
| `src/files.ts` | 收件箱落地、出站路径校验、`send_file` 工具 | Hermes 文件收发与安全边界 |
| `src/config.ts` | schemastery 配置 schema + 解析（默认值/下限） | Hermes 平台配置段 |
| `src/strings.ts` | zh-CN/en-US 渠道文案 | Hermes 本地化 |
| `src/host.ts` | dsh 宿主服务的窄契约（唯一适配面） | —（dsh 特有） |
| `src/runtime.ts` | Cordis `apply`：bootstrap、settings、端口装配、拆卸 | —（dsh 特有） |

## 4. 能力映射：Hermes 飞书适配器 → 本插件

| Hermes 适配器能力 | 本插件实现位置 | 备注 |
|---|---|---|
| WebSocket（推荐） | `adapter.ts`：`transport: 'websocket'` | 官方 SDK WSClient，含重连保活 |
| Webhook | `adapter.ts`：`createWebhookEndpoint` | node:http + `adaptDefault`，自动应答 challenge |
| 事件去重（重复推送） | SDK `safety.dedup` | 默认 TTL+LRU |
| 限流 | SDK 发送管线的退避重试 | `outbound.retry` |
| @提及控制 | SDK `policy.requireMention` | 未 @ 的消息被 `reject` 事件报出 |
| 群策略 / 白名单 | SDK `policy` + `acl.ts` 审批人 | 传输层与桥层双道收窄 |
| 多消息类型（文本/图片/文件/音频） | `bridge.collectMedia` + `files.storeInboundFile` | 图片可转模型附件块 |
| 连续消息合并 | SDK `chatQueue`（同聊天串行）+ Agent 收件箱 | 保持发言归属，不做跨发送人合并 |
| 交互卡片 + 按钮回调 | `cards.ts` + `bridge.handleCardAction` | approval / file-send 两类动作 |
| 审批卡（Allow/Deny，超时拒绝） | `bridge.answerApproval` + `waitForCardDecision` | fail-closed，默认 300s |
| 长文本拆分 | SDK `outbound.textChunkLimit` | 默认开启 |
| 打字状态/过程展示 | `bridge.renderSessionEvent` 过程行（节流） | 路线图：原生思考过程 API |
| 斜杠命令 | `bridge.runCommand` + 宿主 `commands.execute` | 未知命令回退宿主 |
| 本地化 | `strings.ts` | auto/zh-CN/en-US |
| 会话恢复 | `bridge.ensureAgent`：resume 失败则 create | `/new` 递增代数换 sessionId |
| —（Hermes 无对应） | **多工作区 `/ws` + `/cd`**：`workspaces.ts` 准入校验、会话按工作区分身、settings 持久化 | dsh 写限制场景的补强，详见 §7 |

## 5. 对接层契约（dsh 宿主面）

dsh 的服务 API 在预览期会变化，因此宿主契约**收敛在 `src/host.ts` 的结构化窄类型**里（不 import 宿主源码包，保证自包含构建）。桥层只依赖这些形状：

- **`ctx.agents`（必需，`inject: ['agents']`）**：`resume/create → { agent, dispose }`；`agent.followup(message)` 驱动回合、`agent.cancel(cause)`、`agent.session.id`。
- **`ctx.on('session/event')`**：会话日志事件（`turn/start`、`assistant/chunk`、`assistant/message`、`tool/call`、`turn/end`），桥层把它们渲染进聊天。
- **`ctx.on('approval/request')` 瀑布**：权限提问。只回答**本通道拥有的** Agent（`sessionScopes` 查得到），其余一律 `next()` 交给下一个应答者——这保证多通道共存时不抢答。
- **可选服务**（缺省则降级，不阻塞启动）：`tools`（注册 `send_file`）、`commands`（宿主斜杠命令）、`attachments`（图片附件化）、`settings`（持久化配置段与工作区选择）、`workspaceRegistry`（列举/注册工作区，供 `/ws` `/cd`）、`agentDefaultModel`（`/status` 展示）、`loader`（等待组合完成）。
- **宿主配置只读契约（R30）**：`dsh-settings` 对下发的配置节**深度冻结**（`deepFreeze`，设计行为而非事故）——凡从 `config.*` 读入桥内工作状态的对象图（如 `chatSessions` 的会话注册表），水合时必须在边界处**重建**（逐条浅拷贝/克隆，见 `hydrateSessionRegistry`），绝不按引用采纳；可变性由插件自有结构承担。持久化键还须过形状校验（agentKey = `scope§workspace`，见 `isAgentKey`）。
- **会话单写入方假设（长期目标 R31）**：桥层的事件渲染、每 agentKey 单句柄与审批路由均以「通道独占驱动所建会话」为前提；宿主契约未暴露会话归属/活动排他（`HostSession` 仅 id/events/requestHeader），无法检测或拒绝外部（如 dsh web）驱动同一会话——双写入方会串扰渲染乃至损坏会话日志。当前以文档约定规避，根治待上游能力或回合发起方过滤。

入站消息 → Agent 的映射（**会话 = scope × workspace × generation**）：

```
NormalizedMessage ──► scopeKey(sessionScope) ──┐
                                                │
                 binding.workspacePath（/cd 切换）├─► agentKey = scopeKey § workspacePath
                                                │
                 generation（/new 递增）────────┘
                                                ▼
                  sessionId = hash(scopeKey @ workspacePath) + 可选 -rN
                                                ▼
                  AgentLedger[agentKey] ─► resume 或 create(cwd = workspacePath)
                                                ▼
   media 收集（inbox / 附件块 / note）→ HostUserMessage ─► agent.followup
```

回复渲染的关键决策：**以「是否已流式输出」去重**——`assistant/chunk(text-delta)` 流入回复流并标记该 binding 已流式；随后的 `assistant/message` 是同内容的落账记录，跳过，避免回复出现两次。`turn/end` 收口流；错误原因并入流尾。

## 6. 安全设计要点

- **审批 fail-closed**：计时器到期未点击 → 按拒绝处理并更新卡片为超时态；宿主 `request.signal` 中止同样按拒绝收口。
- **卡片绑定原聊天**：载荷携带 `chatId`，转发到其他聊天的点击只回一句提示，不产生任何副作用。
- **出站路径双段校验**（`files.resolveOutboundFile`）：
  1. 词法包含检查先行——即使目标不存在，`../x` 也会被明确报为 `outside_workspace`（注入指令的典型形态必须留痕）；
  2. `realpath` 后对规范工作区二次包含检查——`<ws>/link → /etc/shadow` 会在 realpath 段被拦下；
  3. 给人/给模型看的失败文案只说工作区内相对位置，绝不出现宿主绝对路径。
- **群聊出站必审批**：私聊直发、群聊每次弹卡片，且不提供关闭项。
- **授权只收窄**：`mayApprove` 在配置了 `approvers` 时**仅**名单内可决策；未配置时由会话驱动者决策。
- **工作区切换准入**：`/cd` 拒绝默认/已注册/`workspaceRoots` 之外的一切路径，`workspaceRoots` 为空时只信任默认与已注册工作区（fail-safe）。

## 7. 与 Hermes 实现的取舍差异

| 差异 | 原因 |
|---|---|
| 传输层不复制 Python 代码，而用官方 Node SDK 的 `LarkChannel` | dsh 是 Node/TS 运行时；官方 SDK 已提供同级安全管线，复制反而引入维护债 |
| 不做「扫码一键建应用」onboarding | 保持依赖面最小；手动建应用流程已文档化（FEISHU-SETUP.md） |
| 未实现文档评论回复、会议邀请自动加入 | 属于 Hermes 高级功能，列入后续版本目标 |
| `output: 'stream'` 用 Markdown 流式而非原生思考过程消息 | 兼容旧客户端；`message_cot` 方案在路线图 |
| 单机器人实例 | 多实例与 @ 交接（bot peers/hops）在路线图 |

## 8. 多工作区设计（v0.2.0 / v0.3.0）

**背景**：dsh 把写操作限制在 Agent 会话的工作区内。此前插件所有聊天共用同一个 `workspace` 配置，无法在手机飞书里换目录。本版把会话身份升级为 **(scope × workspace × generation)**，并支持在聊天侧（含手机）直接登记可用工作区。

**关键点**：
- **切换=换会话，不是搬家**：`/cd` 改变 binding 的 `workspacePath`，下一条消息就驱动**新工作区的那个会话**（`agentKey = scopeKey § workspacePath`）。原工作区的会话仍保留在 `AgentLedger`，`/cd` 回去即复用，**互不串上下文**。
- **准入即安全**（`workspaces.resolveCdTarget`）：目标须为默认工作区、`workspaceRegistry` 已注册项、`/ws add` 添加项、或在 `workspaceRoots` 前缀内；`workspaceRoots` 为空时只信任默认与已注册/已添加——任意路径不可达。相对路径按默认工作区的**父目录**解析，便于切换兄弟项目。
- **手机侧登记（v0.3.0）**：`/ws add <绝对路径>` 把一个已存在目录登记为可用工作区（realpath + 目录校验），`/ws remove` 移除；二者沿用**审批 ACL** 门控（配置 `approvers` 时仅名单内可操作），每次操作控制台留痕。添加项与 `/cd` 选择都持久化到 settings（`userWorkspaces` / `chatWorkspaces`）。
- **持久化**：`/cd`、`/ws add/remove` 分别经 `hooks.onWorkspaceChange` / `onUserWorkspacesChange` 写入 settings，重启后恢复；宿主持久层不可用时降级为「进程内存」。
- **登记**：切换与建会话时尽力调用 `workspaceRegistry.create`，让 `/ws` 对所有聊天可见（失败不阻塞）。
- **`/status`** 输出当前会话 id、scope、工作区名称+路径与模型，是工作区状态的单一查询入口。

**边界已知**：切换发生在回合之间；若一个回合正在旧工作区写入，`/cd` 会先收口当前流再换目录，不做跨工作区的原子迁移。

## 9. 测试策略

- **纯逻辑模块**（config/sessions/workspaces/acl/cards/files/util/strings）全部无网络单测；
- **bridge 集成测试**用 `FakePort` + `fakeHost`：文本回合、流式去重、失败回合、审批点击/超时 fail-closed/跨会话委托/转发拦截、命令（help/new/stop/status/ws/cd/ws add/ws remove/未知）、媒体落盘、工作区切换/添加/移除与持久化、会话复用、帮助来源标识、默认模型传入/降级——**91 项全部通过**；
- 真实链路验证（需要飞书应用凭据）：按 README 挂载后在飞书发消息回归。
