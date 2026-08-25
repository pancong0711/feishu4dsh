# Changelog

## 0.4.0 (2026-08-25)

**R12：远程仓库管理定稿 + CI 修复 + 版本发布**

- **远程仓库管理定稿**：远程仓库仅发布**测试过、去敏的白名单快照**；日常开发提交保留在本地全量仓库，本地主分支不再直接推送远程（发布流程见 `docs/PUBLISHING.md`「三个仓库」）。
- **CI 修复**：pnpm ≥10 默认忽略依赖构建脚本，导致 `pnpm install` 报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.5`、每次 push 后 CI 失败；已在 `pnpm-workspace.yaml` 放行 `protobufjs` 构建脚本。
- 版本号 0.3.0 → 0.4.0。

**R11：模型/工作区切换加固**

- **完成 R10-d（默认工作区兜底）**：默认工作区本身失效（目录被删/手改配置/空串）时，`ensureBinding` 三级兜底——坏值 → 默认工作区 → 守护进程 cwd，逐级控制台告警；`/status` 显示的工作区与 Agent 实际可写目录保证一致，不再出现「落到宿主自身目录」的紊乱复发入口。
- **`/cd` 接入 ACL 门控**：与 `/ws add`、`/model` 一致——配置 `approvers` 时仅名单内可切换，未配置时由会话驱动者操作；无权时回复 `cdNoPermission` 文案。配置了 `approvers` 的群聊为有意收紧。
- **并发去重**：`ensureAgent` 以 in-flight promise 合并同一 agentKey 的并发创建，紧邻消息不再可能对同一 sessionId 双建 agent；`dispose` 会先等 in-flight 创建落地再统一释放。
- **旧会话尾事件抑制**：`/cd`（或 `/new`）后，前一会话迟到的输出/摘要/错误不再混入当前回复流；审批卡片路由不受影响。
- 明确结论并写入文档：模型与工作区切换均无需 `/new`，且 `/new` 会清除该会话的模型 pin。
- 测试：新增 R11-a/b/c/d/e 五项回归，共 **134/134** 通过。

**R10：工作区路径校验与控制台兼容性更新**

- 工作区路径校验与规范化：`/cd`、`/ws add` 之外进入的工作区路径（含 `chatWorkspaces` / 新话题继承）使用前会校验为真实存在的目录；含错误空格的路径或指向不存在目录的路径，会回退默认工作区并告警，避免 `/status` 显示的工作区与 Agent 实际沙盒目录不一致。
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
