# Changelog

## 0.4.2 (2026-08-26)

**R16：`/new` 语义收敛——只开新会话**

- **变更**：`/new` 现在只清空当前工作区的会话上下文（generation +1 换新 sessionId）；不再清除该会话的 `/model` pin，工作区绑定保持不变（此前也未重置）。模型 pin 由 bridge 持有（`state.selections`），跨会话重开保留并自动装回新 agent。
- **迁移**：此前可借 `/new` 清除 pin 回到部署默认模型；如需指回请显式 `/model <provider>/<model>`。`/model default`（把当前选择存为部署默认）语义不变。
- 测试：新增回归「`/new` keeps the `/model` pin into the fresh session」，共 **146/146** 通过。

## 0.4.1 (2026-08-25)

**R13：私聊话题回复归属修复（入站批合并）**

- **修复**：私聊中创建话题后，dsh 的回答落到私聊根而不进话题。根因是飞书 SDK 入站**600ms 文本批合并**（`mergeBatch` 取批次最后一条的 messageId/threadId）——话题消息与相邻主界面消息同时到达时丢失 thread_id。修复：`channelOptions` 增加 `safety.batch.text.delayMs: 0` 关闭批合并窗口（`chatQueue.enabled` 只能串行不能关闭该窗口）；新增 `tests/adapter.spec.ts` 回归。

**R14：中文路径兼容加固（写权限误申请）**

- **修复**：含中文（全角空格 U+3000 / 多余空格 / NFC 变体）的工作区路径导致 dsh 「明明有写权限却反复申请写权限」且 feishu4dsh 无任何异常提示。
  - `src/workspaces.ts`：新增 `normalizeWorkspacePath`（NFC + 逐段剥离全部 Unicode 空白，含 U+3000）；`canonicalPath` / `resolveWorkspaceDirectory` 回退前先尝试规范化拼写（覆盖任意层级，不再只处理末段 ASCII 空格）。
  - `src/bridge.ts`：绑定工作区时若配置拼写被规范化，**报告异常**并**回写 canonical 路径**自愈（dsh 沙箱 workspace-write 写权限根 = 会话 header.cwd，回写后新会话以正确 cwd 创建，沙箱根与 `/status` 对齐）。
  - workspaces 测试新增 R14 九项。

## 0.4.0 (2026-08-25)

**R12：远程仓库管理定稿 + CI 修复 + 版本发布**

- **远程同步边界二次定稿（模型 A）**：GitHub 仅发布测试过、去敏的白名单快照；主仓 main 为内部全量权威，解除对 origin 的 upstream 跟踪，**不得直接 push 主仓到远程**。
- **沉淀 git 管理经验**：「全量 / 去敏 / 远程」三个仓库的职责与同步规则定稿，含本次事故教训与后续约定。
- **CI 修复**：`pnpm-workspace.yaml` 的 `allowBuilds` 由占位符改为 `protobufjs: true`，修复 `pnpm install` 报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.5` 导致每次 push 后 CI 全红的问题。
- 文档去敏：`docs/CONFIG.md` 移除对内部规格「R11 规格 §0」的悬空引用，改为指向公开的 TROUBLESHOOTING §3。

**R11：模型/工作区切换加固**

- **完成 R10-d（默认工作区兜底）**：默认工作区本身失效（目录被删/手改配置/空串）时，`ensureBinding` 三级兜底——坏值 → 默认工作区 → 守护进程 cwd，逐级控制台告警；`/status` 显示的工作区与 Agent 实际可写目录保证一致，不再出现「落到宿主自身目录」的紊乱复发入口。
- **`/cd` 接入 ACL 门控**：与 `/ws add`、`/model` 一致——配置 `approvers` 时仅名单内可切换，未配置时由会话驱动者操作；无权时回复 `cdNoPermission` 文案。配置了 `approvers` 的群聊为有意收紧。
- **并发去重**：`ensureAgent` 以 in-flight promise 合并同一 agentKey 的并发创建，紧邻消息不再可能对同一 sessionId 双建 agent；`dispose` 会先等 in-flight 创建落地再统一释放。
- **旧会话尾事件抑制**：`/cd`（或 `/new`）后，前一会话迟到的输出/摘要/错误不再混入当前回复流；审批卡片路由不受影响。
- 明确结论并写入文档：模型与工作区切换均无需 `/new`，且 `/new` 会清除该会话的模型 pin。
- 测试：新增 R11-a/b/c/d/e 五项回归，共 **134/134** 通过。

**R10：工作区路径校验与控制台兼容性更新**

- 工作区路径校验与规范化：`/cd`、`/ws add` 之外进入的工作区路径（含 `chatWorkspaces` / 新话题继承）使用前会校验为真实存在的目录；含错误空格（如 `20260730 - 示例目录`）或指向不存在目录的路径，会回退默认工作区并告警，避免 `/status` 显示的工作区与 Agent 实际沙盒目录不一致。
- 版本兼容：文档从 dsh `0.1.0-rc.6` 更正为当前实际验证的 dsh `0.1.1-rc.2`。

## 0.3.0 (2026-08-19)

**手机侧管理工作区**：不必再改配置文件重启，直接在飞书里添加/移除可用工作区。

- 新增 `/ws add <路径>`：把一个已存在的目录登记为可用工作区（含存在性/目录校验），之后即可 `/cd` 进入；`/ws` 列表中可见；经 settings 持久化，重启保留。
- 新增 `/ws remove <名称或路径>`：移除 `/ws add` 添加的工作区；默认与宿主注册的工作区受保护不可移除。
- **权限门控**：`/ws add`/`/ws remove` 沿用审批 ACL——配置了 `approvers` 时仅名单内可操作；未配置时由会话驱动者操作（私聊即本人）。群聊建议配置 `approvers`。
- `cdNotAllowed` 提示同步指引「可用 /ws add 添加」。
- **修复（Bugfix）**：新建 Agent 时未向 `agents.create()`/`agents.resume()` 传入 `agentOptions`（默认 provider/model），导致飞书会话报 `agent "..." has no provider/model`。现改为读取 `agentDefaultModel.currentSelection()` 作为 `agentOptions` 传入（`bridge.ensureAgent`）。详见 `docs/TROUBLESHOOTING.md` §1。
- 测试：工作区区 6 项 + 修复 2 项（默认模型传入 / 无默认服务降级），共 **91/91** 通过。

## 0.2.1 (2026-08-19)

**`/help` 命令分组与来源标识**：此前频道命令与 dsh 宿主命令混排、来源不清。现在按「feishu4dsh 频道命令 / dsh 宿主命令」分组输出，每条命令说明后附来源标识（`[频道]` / `[dsh]`），一眼可辨命令归属。`/status` 描述同步更新为「会话 / 当前工作区 / 模型」。测试 83/83 通过。

## 0.2.0 (2026-08-19)

**多工作区支持**：此前所有会话共用同一个 `workspace`；现在会话身份升级为 **(scope × workspace × generation)**，可以在飞书（含手机端）里为每个聊天切换工作区。

- 新增 `/ws`：列出可用工作区（默认 + 宿主 `workspaceRegistry` 注册项），标记当前/默认。
- 新增 `/cd <名称或路径>`：切换当前会话的工作区；目标须为默认、已注册或位于 `workspaceRoots` 之内，否则拒绝（fail-safe）。
- `/status` 增强：输出会话 id、会话粒度、当前工作区（名称+路径）与模型。
- 切换经 settings `chatWorkspaces` 持久化，重启后恢复；切回原工作区时复用其会话、不串上下文。
- 新模块 `src/workspaces.ts`（纯函数：目录构建 / 合法性校验 / `/cd` 解析）；`src/sessions.ts` 按 (scope×workspace) 生成 agentKey / sessionId。
- `host.ts` 新增 `workspaceRegistry` 契约；`config.ts` 新增 `workspaceRoots` / `chatWorkspaces`。
- 测试：新增 workspaces 单测与 bridge 工作区切换集成测试，共 **82/82** 通过。

## 0.1.1 (2026-08-19)

- **重命名**：`dsh-feishu-channel` → **`feishu4dsh`**（npm 包名、Cordis 插件名、settings 命名空间、日志前缀、运行时收件箱目录 `.feishu4dsh/` 同步更新）。
- 新增会话记录（SESSION-LOG）文档：prompt / 时间 / 模型 / 用量口径。
- 新增 `docs/PUBLISHING.md`（发布到 GitHub / npm 的操作指南）与 `.github/workflows/ci.yml`。

## 0.1.0 (2026-08-19)

首个可工作版本（developer preview，对齐 dsh `0.1.0-rc.6`）。

- Cordis 插件骨架（`plugin.yaml` 等价为 package.json 的 `dsh.bundle.patch` + `cordis.patch.yml`）
- WebSocket / Webhook 双传输（基于官方 SDK `LarkChannel`）
- 会话映射：chat / chat-thread / chat-sender 三种作用域；重启可恢复；`/new` 重置
- 回复渲染：`stream` 流式（SDK markdown stream）与 `card` 聚合两种模式；流式去重
- 工具审批卡片：允许/拒绝按钮、转发拦截、超时 fail-closed、审批人名单
- 出站 `send_file` 工具：私聊直发、群聊逐次审批卡片
- 入站媒体收件箱（`.feishu4dsh/inbox/`）：文件名清洗、大小上限、路径注记
- 路径安全：词法包含 + realpath 双段校验，失败文案不泄露宿主绝对路径
- 授权收窄：sender/group 白名单 + approvers；启动时打印可达范围
- 中英双语文案（`locale: auto/zh-CN/en-US`）
- 57 项单元测试全绿
