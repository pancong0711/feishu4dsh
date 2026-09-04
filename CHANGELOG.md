# Changelog

## 0.7.1 (2026-09-04)

**R33：点选卡配套——配置引导 · 清单管理 · send_file 归属修复**

- **配置引导**：`/model` 未配置 `modelCatalog` 时，状态文本附提示行（说明如何开启点选）；`/ws new` 未配置 `workspaceRoots` 的拒绝文案附配置示例。
- **点选清单管理**：`modelCatalog` 支持在飞书端维护——`/model add <provider>/<model>` / `/model del <provider>/<model>`（审批 ACL 同 `/model`，去重、上限 20、至少保留 1 条），修改持久化；**自动学习**：手输切换成功后该模型自动进入点选清单；选择卡上当前模型不在清单时显示「➕ 把当前模型加入清单」一键加入。
- **修复 send_file 偶发落错会话**：文件交付原按"注册工具时的聊天"路由（闭包快照），现改为**按调用会话实时解析**归属聊天——话题请求的文件必落话题所属聊天；无法识别归属的会话（如后台子任务会话）直接拒绝，不再误投；话题内锚缺失仍按既有语义降级到该聊天的根。
- 测试：234/234（新增 5：清单增删与持久化、空清单提示、自动学习、一键加入、未知会话拒发）。

## 0.7.0 (2026-09-02)

**R32：交互卡片选择器——/ws 点选进入 · /ws new 可视化新建 · /model 点选切换 · /session 点选切回**

- **`/ws`（点选进入）**：默认改为交互卡片——每个已注册工作区一个按钮（正文附名称→路径映射），当前工作区标 `✅`，点击即切换，不再需要手输 `/cd`。原文本列表保留为 `/ws list`。
- **`/ws new`（可视化新建）**：打开目录浏览卡——逐级进入子文件夹、翻页、⬆️ 上一级、✅ 就用这个目录（自动注册并切换）；`/ws new <名称>` 在当前浏览位置新建文件夹并进入。仅可在 `workspaceRoots` 配置的目录内浏览（安全默认，未配置则提示改用 `/ws add`），浏览与建目录均需审批 ACL。
- **`/model`（点选切换）**：状态文本之后追加模型选择卡（`select_static` 下拉 + 分页，每页 15 条）；当前会话生效模型标 `✅`；点击其他模型下一轮生效。清单来自新配置 `modelCatalog`（`provider/model` 列表，部署管理员维护）；未配置时 `/model` 行为与旧版一致。
- **`/session`（点选切回）**：文本列表后追加选择卡（同一套稳定编号，当前会话标 `✅`）；点击即切回——进行中的任务先停止（与 `/session <n>` 完全同语义）。
- **安全语义**：所有菜单点击都以**点击者身份**重查对应命令的 ACL（配置 `approvers` 时仅名单内可点），转发到别的会话的卡片一律拒绝；菜单卡 15 分钟自动失效并原地刷新为失效态；`/new` 与会话切换会清掉本会话的活菜单。
- **兜底**：`/cd`、`/ws add/remove`、`/ws list`、`/model <provider>/<model>` 全部保留——旧客户端下拉渲染异常时不影响任何既有用法。
- 测试：229/229（新增 17：菜单注册表/分页/编解码 8 项纯逻辑 + 点选切换、转发与 ACL 拒绝、浏览确认、建目录、无 roots 拒绝、模型点选与分页、会话点选切回、dispose 清理 9 条集成）。

## 0.6.1 (2026-09-02)

**修复：带会话数据的服务重启后，所有消息在回合启动前失败**

- **影响**：v0.6.0 起一旦在 `chatSessions` 已有持久化数据的情况下重启服务，每条飞书消息都会报「本轮执行失败」（日志 `read only property 'lastActiveAt'` / `not extensible`）；`/session` 列表、切换、重命名、归档同样不可用。
- **根因**：宿主（dsh-settings）下发的配置文档是**深度冻结**的（设计契约）；插件水合会话注册表时按引用采纳了冻结的配置对象图，而注册表的全部变更操作都是原地写入——首次「带着数据重启」即触发。
- **修复**：水合时在边界处重建注册表对象图（逐条浅拷贝；记录字段全为原始类型，拷贝完整），插件自有结构承担可变性；新增冻结金丝雀（异常时告警并 structuredClone 兜底）；持久化 agentKey 增加形状校验（`scope§workspace`），畸形残留键跳过并告警、不再永久滞留。
- **测试**：212/212（新增 4 条：深冻配置水合重建 / 畸形键跳过 / undefined 容错 / 桥层深冻配置端到端回归）。
- **升级建议**：受影响部署（v0.6.0 且曾重启过）更新后重启一次即可恢复；重启前残留的畸形 settings 键可顺手清理（不清理也不影响功能，插件会跳过并告警）。

## 0.6.0 (2026-08-28)

**R29：会话回溯与命名（/session）——把 TUI 的会话管理三件套轻量带进飞书**

- **`/session`**：列出当前话题 × 工作区的历史会话（自动标题 = `日期 + 首条消息首行≤12字`；全局稳定编号；默认隐藏已归档，`all` 含归档，当前会话永远可见）。
- **`/session <n>`**：切回旧会话——自动停止进行中任务、重指活跃代，下一条消息从旧上下文继续；**顺带修复存量缺陷**：重启后 generation 归零导致回到最初会话（活跃指针现持久化）。
- **`/session rename <标题>`**：重命名当前会话（用户标题为准），`/status` 会话行联动显示。
- **`/session archive <n>` / `archive old [天数]`**：归档会话——直调宿主 `workspaceRegistry.archiveSession`，与 dsh web **共用同一归档集合**（`~/.dsh/storages/workspace.json`）；`/new` 不自动归档；宿主缺该 API 时优雅降级。当前 dsh 无 unarchive，归档单向（通道 `all` 视图仍可切回）。
- **工作区分组修复**：通道创建/恢复会话后调用 `workspace.attachSession` 记账——此前通道从不记账，飞书会话在 dsh web 全部落入"未分组"；失败自动重试（resume 时自愈历史会话）。
- **归档边界**：通道侧仅可归档飞书端创建的会话（`feishu-` 前缀校验），dsh web 会话不受通道影响。
- 配置新增：`chatSessions` / `chatActiveGen`（运行时状态，勿手改）。测试 208/208（新增 18 条）。

## 0.5.0 (2026-08-27)

**R25–R28：话题锚修复 · /status 增强 · /mode 模式设置 · /model effort 推理强度**

- **R25（修复）**：`send_file` 的文件消息现跟随当前话题锚——私聊话题/群聊话题内不再落聊天根；群聊审批卡与文件共用同一锚；锚缺失降级落根不报错。（此前文件是全插件唯一不带锚的输出路径）
- **R26**：`/status` 新增「模式 / 推理强度 / 轮次·步 / Token 累计」四行，粒度行双语（如「按话题（chat-thread）」）；统计直接读 dsh 会话日志（`session.events`），重启恢复不归零；旧宿主优雅降级「—」；新模块 `session-stats.ts`（与每轮摘要共用同一累加函数，统一口径）。耗时类指标（LLM/工具/TTFT/tok-s）待核实 dsh 日志时间戳后二期跟进。
- **R27**：新增 `/mode`——查看/设置会话模式（standard/minimal，`AGENT_PRESETS` 清单可扩展）；按 scope 持久化（`chatPresets`），部署默认 `agentPreset: standard`；**设置即开启新会话**（`resume()` 不能换预设）；与 `/new` 共用重开逻辑，模型 pin 与工作区保留。
- **R28**：`/model effort`——按模型设置推理强度（`default/low/high/max`；`default` = 请求不携带 `reasoning_effort`，即模型内置行为）；偏好按 `provider/model` 全局持久化（`modelEfforts`），调整即更新该模型默认；`/model` 总览与 `/status` 显示生效强度及来源（模型偏好 / 会话实测 / 默认）。
- 命令面：`/help` 新增 `/mode`；`/model`、`/status` 描述更新。新增配置：`agentPreset` / `chatPresets` / `modelEfforts`（后两者为运行时状态，勿手改）。
- 测试：190/190（R25 回归 3 + R26 6 + R27 6 + R28 9）。

## 0.4.4 (2026-08-27)

**R24：用户消息资源改用 message-scoped API 下载**

- **修复**：用户通过飞书发送的图片/文件下载一律 400（`im.v1.image.get` 仅限机器人自传资源，实测 `234008 not resource sender`）——现优先走消息域接口 `messages/{message_id}/resources/{file_key}`（`rawClient.im.v1.messageResource.get`），字节经 `bufferFromStream` 收集；消息域不可用（bot 自传/卡片资源等场景）时回退旧接口并保留运维日志。
- **落盘策略不变**：仍写 `<会话绑定工作区>/.feishu4dsh/inbox/<createTime-hash>/<文件名>`，随回复附路径提示。

## 0.4.3 (2026-08-27)

**兼容性修复：撤下 dsh-std 阶段 1 双轨产物**

- **影响**：装有 `@dsh-std/adapter-dsh` 的宿主在安装本插件后启动失败——标准清单声明的入口是阶段 1 占位实现，不满足适配层的 `defineFacet(...)` 对象契约（默认导出需为含 `activate/deactivate?/snapshot?` 的 FacetModule）。legacy 路径不受任何影响。
- **修复**：从发布面整体移除 `dsh-plugin.json`、标准入口与其配套校验脚本/CI 步骤；待真实实现经 spike 验证后再随新版本回归。
- **建议**：使用本插件无需安装任何 dsh-std 包；此前因该问题移除过 adapter-dsh 的部署可直接恢复正常配置。

## Unreleased

**R17：提权/发文件审批卡片跟随来源话题**

- **修复**：`approval/request` 与群聊 `send_file` 审批卡片此前硬编码裸发到聊天根，不进话题；现改为锚定**发起申请的会话当前轮的入站消息**（`{replyTo, replyInThread: true}`），与普通回复同规则。
- **防错锚定**：仅当发起会话是该聊天的当前会话且存在本轮锚点时才进话题；`/cd`、`/new` 后旧会话迟到的审批保持原落点（聊天根），不会锚进错误话题。
- 测试：新增 R17-a/R17-b 回归，共 **148/148** 通过。

**R18：飞书会话默认 standard 预设**

- 飞书通道新建会话显式使用 `standard` agent 预设（完整工具集：fs/search/subagent/workflow），不再继承部署默认的 `minimal`；"需求文档 → 后台 subagent 执行"协作自此可在飞书跑通。既有会话不受影响，`/new` 或新话题后生效。
- 发布脚本悬空引用扫描加固：内部文档名匹配不再要求 `.md` 后缀（修复一处历史提法漏检）。
- 新增后台任务协作手册（需求文档 → subagent 执行 → 验收的完整流程与模板）。

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
