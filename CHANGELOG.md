# Changelog

## 0.15.3 (2026-10-24)

**R54：给两个出厂 preset 补上真实性门禁——`standard` 与 `minimal` 必须真的能组装**

- **背景**：R52（`subagent` 缺宿主行）与 R53（`{{cwd}}` 变量失效）是同一类缺陷——**preset 行照抄上游但漂移**，而且两个在本机都复现不了。复盘发现三道防线同时失守：本机 77 个通道会话里 70 个跑 `minimal`（`standard` 路径几乎零流量，最后 7 个 `standard` 会话都在 `{{cwd}}` 引入之前）；两个缺陷都发生在运行时（`agent/created` 与提示词组装期），`--dump-config` 组合期全绿；单测跑在手写桩上，既不加载真实 preset 也不调真实插值器。
- **新增门禁（无宿主，永远运行）**：patch 生效值（**剔除 YAML 注释**，否则说明里引用的坏写法会误伤）中出现的每个 `{{name}}` 必须是提示词循环真实提供的变量；`standard`/`minimal` 都必须声明非空 `persona.prefix` 且变量合法；`suffix` 一旦存在必须非空。
- **新增门禁（真实宿主可达时，否则自动 skip）**：把两个 preset 的 persona 交给真实 `dsh-system-prompt` 的 `renderPrompt` 渲染一遍——未注册变量当场抛错，与真机同一失败路径。
- **实测有效**：注入 R53 缺陷后 3 条新门禁全红（含真实宿主那条），恢复后全绿。
- **顺带核清的差异**：逐 id 对照上游 `presets/*.patch.yml` —— 我们 `standard` 缺的 `time-context`/`tool-schedule`/`tool-plugin-market` 是 web 控制台与定时能力（本项目未宣称），`minimal` 缺的 `tool-fs`/`compaction*` 是 R42 定稿的**有意设计**（省 token、README 已声明）；删除 `{{cwd}}` 也不丢工作目录信息——`dsh-working-directory` 是宿主层行，以 `interpolate: false` 的 user 上下文提供 cwd。故本轮**无需改动任何 preset 组合**。
- **测试**：359/359（基线 355 + 4）。

## 0.15.2 (2026-10-24)

**R53：修复每轮直接失败——persona 里的 `{{cwd}}` 变量在 dsh 0.2.1 已失效**

- **现象**：新会话第一轮就失败，报 `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model`。用户真机反馈。
- **根因**：dsh 0.2.1 的提示词插值器是 **strict** 的——遇到未注册的 `{{name}}` 直接抛错，而它只注册 `provider` 与 `model`。当前目录已改由工作目录服务以 user 上下文提供，`cwd` 不再是提示词变量（上游 `dsh-system-prompt` README 已明确要求从 preset 的 `suffix` 字段移除该语句）。我们 preset `standard` 的 `persona` 里仍留着 0.2.0 时代的 `suffix: Your working directory is {{cwd}}.`，R41 迁移时整体照搬未复核；上游 0.2.1 的 `presets/standard.patch.yml` 只有 `prefix`，对照即知多了一行。
- **为什么表现为"整轮失败"**：插值发生在**提示词组装期**，即任何模型请求发出之前，所以跟模型、网络、额度都无关，换模型也不会好。
- **修复**：删掉该 `suffix` 行，保留 `prefix` 里的 `{{model}}`（合法变量）。工作目录信息不丢——由 `dsh-working-directory` 继续提供。
- **门禁**：`tests/bridge.spec.ts` 新增 R53——扫描 patch 的**生效值**（剔除 YAML 注释）里出现的全部 `{{var}}` 引用，只允许宿主真实注册的集合；已实测该断言在修复前红、修复后绿。
- **排障**：`docs/TROUBLESHOOTING.md` 新增章节，含不必等发版就地的热修步骤。
- **测试**：355/355（基线 354 + 1）。

## 0.15.1 (2026-10-21)

**R52：修复调 `subagent` 直接失败——`modelSelectionSettings` 缺少配套宿主行**

- **现象**：飞书侧让模型派子代理时本轮直接失败，报 `tool-subagent (@deepseek-ai/dsh-tool-subagent): tool-subagent: modelSelectionSettings requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope`。其他用户真机反馈。
- **根因**：preset `standard` 的 `subagent` 行照抄了 `dsh-web-app/cordis.patch.yml` 对应 preset 里的 `modelSelectionSettings: true`，但**漏抄了提供 `subagentModelSelection` 服务的宿主行**——dsh-web-app 把它放在自己的 `cordis.patch.yml`（不在 preset 内）。该项让 `dsh-tool-subagent` 在每个 `agent/created` 去宿主作用域取该服务，取不到就抛错，**整个子代理工具装不上**。
- **为什么长期没被发现**：校验点在 standing composition（`agent/created`）分支，所以 `dsh --dump-config` 组合全绿、服务启动也正常，只有第一次真正派子代理才炸；且宿主自带（`dsh-base`）的 `tool-subagent` 行并没开这个选项，问题自 R41（v0.10.0）preset 层接管宿主行之后才随版本上线。
- **修复**：`cordis.patch.yml` 补上宿主行 `- id: subagent-model-selection-settings / name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'`，位置与 dsh-web-app 一致（`agent-preset-registry` 之后、`preset-standard` 之前）。**保留子代理按设置限定可选模型的能力**：该设置默认 `enabled: false`，因此修复后子代理行为与之前完全一致，不会擅自放开选模型。
- **门禁**：`tests/bridge.spec.ts` 新增 R52——只要 patch 里出现 `modelSelectionSettings: true`，就必须同时存在该宿主行、且必须排在 `preset-standard` 之前（宿主层而非 preset 层）。已实测该断言在修复前红、修复后绿，避免"抄一半"再次漏网。
- **排障**：`docs/TROUBLESHOOTING.md` 新增 §9，含判定依据与**不必等发版**的就地热修步骤（往部署副本的 `cordis.patch.yml` 补同一行后重启）。
- **测试**：354/354（基线 353 + 1）。

## 0.15.0 (2026-10-21)

**R50：适配 dsh `0.2.1-rc.2`——四处宿主契约硬伤 + 三处能力退化 + 补上 `ask_user` 提问通道（R51）**

- **背景**：dsh 升级到 `0.2.1-rc.2` 后服务仍能启动并连上飞书，`typecheck`/`332` 单测也全绿——但**全部测试跑在手写宿主桩上**，桩把旧签名复制了一遍，真机四处契约漂移一条都没测出来。本版按「先对账、再修、再把对账钉进 CI」的顺序处理。
- **P0-1 `agent.cancel(cause: string)` → `cancel(cause: AgentCancelCause)`**：0.2.1 按 `cause.kind` 分支并对未知变体 `assertNever`。裸字符串让 `abortedCancelCause` 抛 `unreachable variant: undefined`，`turn/end` 的 `reason` 保持 `undefined` → 宿主 `Session.append` 判非 JSON 再次抛错 → **`turn/end` 永不落盘**，飞书侧流式卡停在"生成中"，会话日志留下未闭合 turn。三处调用（`/stop`、`/new`+`/mode`、`/session` 切换）统一改走 `hookCancel(reason)`（`{kind:'hook', reason}`）：宿主认识该变体，且原因原样写入 `turn/end.reason.reason`，审计不丢。
- **P0-2 `commands.execute` 新增第三参 `submittedAttachments`**：插件仍传三参 → `signal` 为 `undefined` → 实现首句 `signal.aborted` 抛 `TypeError`。standard 模式的 `/compact` 与 `/goal` 等宿主命令兜底全挂。改为 `(agent, line, [], signal)`。
- **P1-3 `archivedSessionIds` 方法 → 取值器**：`registryService.archivedSessionIds()` 抛 `TypeError`，被旧 `try/catch` 吞成 `undefined` → `archiveSupported=false` → **`/session archive` 一律回"当前部署不支持"**。改为按属性读取，并把读取结果拆成 `ok | unsupported | failed` 三态：读失败**响亮报错**（operator 日志 + 用户可见文案），不再伪装成"宿主不支持"。
- **P1-4 `observeSession()` 变成引用计数租约**：不 dispose 会让 prepared 观察缓存永不回收。两处调用（会话预设观测、代次新鲜度自检）改为 `try/finally` 调 `releaseObservation()`（`[Symbol.dispose]`，旧宿主无该符号时安全跳过）。
- **P1-5 `Session.events` 移除，只剩 `snapshotEvents()`**：`/status` 的轮次·步·Token 退化显示 `—`；R46 `/compact` 的"最近 N 轮原文"尾巴**静默变空**。新增 `sessionEvents(session)` 适配层（优先 `snapshotEvents()`，回退旧属性 `events`），两处读取统一走它。
- **P2-6 `turn/end` 词表 5→7**：补 `interrupted`（崩溃遗留 turn 的补收口）与 `forked`（fork 边界收口）。功能上压缩仍只认 `completed`（fail-closed 不变），但 R47 立的"词表漂移即红"门禁本身必须同步。
- **P2-7 patch 空指向**：`dsh-base` 0.2.1 已无 `tool-ralph` 宿主行，`disabled: true` 只剩启动告警 → 删除该 disable 行（preset `standard` 内的 `@deepseek-ai/dsh-tool-ralph` 保留）。
- **R51 `ask_user` 提问通道（原为缺口）**：`ask_user` 走**独立瀑布** `user-questions/request`，而插件此前只注册 `approval/request`——模型一提问就只能等宿主超时。现补齐：一张飞书**表单卡**（每题一个原生控件：单选 `select_static` / 多选 `checker`，外加"其他"文本输入）→ 提交按钮携带待答 token；`action.form_value` 从原始回调读取（SDK 归一化事件只留 `value/tag/name/option`，故通道开启 `includeRawEvent: true`）。答案批**每题恰好一条**（未答 = 空选择，宿主接受为跳过）；越权（非审批人/非原会话）拒答；超时或宿主撤回 → 卡片定格为超时并 `next()` 委托，绝不编造空答案。
- **门禁升级（本轮最重要的工程改动）**：`tests/host-contract.spec.ts` 从"只断言自家常量"扩成**双层对账**——(1) 内部：常量/比较字面量/fixture 词表/cancel 必须走 `hookCancel`/`execute` 必须四参/`archivedSessionIds` 不得调用/业务代码不得直读 `session.events`；(2) **对已安装宿主**：定位真实 `@deepseek-ai/dsh-*` 的 `.d.ts`，解析 `TurnEndReasonMap`、`AgentCancelCause`、`execute` 签名、`archivedSessionIds` getter、`snapshotEvents`、`SessionObservation extends Disposable`、`user-questions/request` 逐条比对；宿主不可达时自动 skip（保持独立构建）。
- **测试**：353/353（基线 332 + 21：host-contract 新增真实宿主 7 项 + 内部 4 项，bridge 新增 R50-a/b/c/d/d2 与 R51-a…e）。

## 0.14.0 (2026-10-12)

**R49：卡片正文溢出改为「多张卡依次流式」——消除中途静默与收口爆发**

- **根因（真机取证 `feishu-755ea2773268-r10`，journalctl --user）**：live reasoning 卡面在正文超单卡预算时走 R36-2「冻结头部 + 收口把全文一次性发」的旧阀；一个持续产出长正文的 turn 里，卡片冻住不再更新（观感"卡住"约 20 分钟），直到 `/stop`→finish 才由 `sendFallback`→R48 `sendLongMarkdown` 把整段切成多条无间隔连发（观感"突然弹一堆"）。真正问题是**延迟投递**，不是连发。
- **修复**：
  - `openCardReplyStream` 重写为「卡页序列 + 活动页」状态机：正文超预算即**滚动翻页**——当前卡定格为头 + 「▸ 接下页」提示，另起一张流式卡承接后续正文，全程边生成边可见；每张新卡都带**同一 `{replyTo, replyInThread:true}`**（复用 `anchorOptions`），全部留在话题内。
  - 分页边界复用 `splitWithCodeFences`（R48），代码围栏跨页闭合/重开、每页自洽。
  - 建卡动作单独频控：`CARD_ROLLOVER_MIN_CHARS=2000` + `CARD_ROLLOVER_MIN_INTERVAL_MS=1000` 双门，避免快速翻页撞飞书 API 限流。
  - 建新卡的 `port.send` 加与 R21/R22 同规格的**有界等待**（`replyFinishTimeoutMs`）：挂起的建卡不会 park `append`/turn/end；超时该页文本仍由 finish 兜底送达，内容恰好一次不丢。
  - `finish()` 只终态渲染活动页，**移除全文群发路径**。
  - 决策 #1：`CARD_STREAM_MAX_CHARS` 24000→28000（接近硬限、减少翻页）；#6：给降级路径 `sendLongMarkdown` 也加片间最小间隔（`SEND_CHUNK_MIN_INTERVAL_MS=300`，经 timing 旋钮 `sendChunkMinIntervalMs` 可在测试零化）。
- **测试**：332/332（基线 324 + R49 净增 8：R49-a…g 覆盖即时翻页/同锚/短回复不翻/围栏不破/降级带锚/建卡挂起不 park/节流；AC7 覆盖兜底片间节流；改写 R36-13 与 AC2 断言为滚动语义）。

## 0.13.0 (2026-10-12)

**R48：长回复分片丢话题锚修复——出站长文本改为「带锚分片」**

- **根因**：feishu4dsh 把超长文本整段交给 SDK（`port.send({ markdown })`），而 `@larksuiteoapi/node-sdk` 的 `sendMarkdown`/`sendText` 自动分片时只给第 0 片传 `replyTo`，第 1..N 片走 `message.create` → 落到聊天根、丢失话题锚。与 `sessionScope`、入站 `thread_id`、批合并、`binding.replyTo` 均无关。
- **修复**：
  - `src/util.ts` 新增 `splitWithCodeFences(text, limit)`（移植 SDK 同名列实现并加固）：**硬保证任一 chunk ≤ limit**（含超长单行硬换行；SDK 原版会漏掉这种行导致其再次分片丢锚），代码围栏跨片闭合/重开、每片自洽，优先在标题前断行。
  - `src/bridge.ts` 新增 `sendLongMarkdown()`：按 `MAX_CHUNK = 3000`（< SDK `DEFAULT_CHUNK_LIMIT` 3500，确保 SDK 不再二次分片）分片，**每一片共用同一 `{ replyTo, replyInThread: true }`**；某片失败逐片上报、不中断后续片。
  - 全部 5 处 `{ markdown }` 出站点统一改造：`safeSend` / `openReplyStream` 流降级兜底 ×2 / 卡片面 `sendFallback`（含 reasoning panel 兜底）。`replyTo === undefined` 三态语义原样保留（无锚不臆造锚）。
- **产品形态**：超长回复以「多条带锚回复」承载；卡片溢出 = 卡片头 + 带锚正文分片；思考过程全量输出。
- **测试**：324/324（新增 14：`splitWithCodeFences` 单测 9 + 确定性 property 测试 1 + R48 端到端 AC1/AC2/AC4/AC5/AC6 5；并修正 R36-13 旧断言「整段一条」为「多条带锚分片」）。

## 0.12.2 (2026-10-09)

**R47：`/compact` 收口词表修复（completed）——真机取证后的一次单词级止血 + 防再犯门禁 + 摘要卫生**

- **根因（真机实证 `feishu-755ea2773268-r7`）**：宿主 `TurnEndReasonMap` 的真实键集是 `completed / aborted / blocked / error / max-tokens`（+null），而本仓测试基建自早期起使用不存在的 `'complete'`；v0.12.1 的 A1「收紧」把判定锚在了测试假词表上 → 所有真实成功收口落入失败分支，`/compact` 在真机上从未成功（fail-closed 设计满分：会话无损、可重试，但功能达成度 0%）。
- **修复**：
  - F1：收口判定改 `kind === 'completed'`（经 `TURN_END_COMPLETED` 常量）；
  - F2：**契约对账门禁**（`tests/host-contract.spec.ts`）——src 中 reason.kind 比较字面量与 fixture 造载荷都必须落在宿主词表内，漂移即 CI 红；词表常量注明类型出处（dsh-session `TurnEndReasonMap`）；
  - F3：fixture 清扫——28 处 `{ kind: 'complete' }` → `'completed'`（涉及 R21–R46 各代测试）；
  - F4：**摘要卫生**——双语指令加硬约束「第一行必须是 `# ` 一级标题」；插件兜底 `normalizeCompactSummary()`：捕获文本从第一个 `# ` 标题起存档（模型 meta 思考泄漏不再污染摘要文件；无标题则原文照存）。
- **测试**：310/310（新增 6：R47-a 真实词表端到端 / R47-b `aborted` 仍判失败 / R47-c meta 前缀剥离 / host-contract ×3）。

## 0.12.1 (2026-10-08)

**R46 发布后审计修复：/compact 三处边界缺陷（全部为「用户消息/会话绝不静默丢失」性质）**

- **收口判定收紧**：只有 `turn/end.reason.kind === 'complete'` 才允许存档摘要并重置会话——被取消/中断收口（含 `reason:null`）可能只产出部分摘要，此前会误存半份上下文再清会话；现在一律按失败处理，原会话原样保留；
- **破坏性命令竞速**：压缩 pending 期间执行 `/new` `/stop` `/mode` `/session` `/cd` → 压缩立即按取消结算（不再空等 180s 超时），挂起消息**响亮丢弃**（明确回执条数，请用户重发），不再静默丢失；
- **opener 阶段失败兜底**：新会话建立失败 → 明确失败回执（含挂起消息数与重发指引），不再裸抛异常；
- **文档**：README 命令表补 `/compact`；TROUBLESHOOTING 新增 §7（minimal 长会话膨胀的处置优先级：/compact → /mode standard → 人工 SOP）。
- **测试**：304/304（+1：R46-g 破坏性命令取消结算与挂起消息响亮丢弃）。

## 0.12.0 (2026-10-08)

**R46：频道 `/compact [N] [问题]`——压缩上下文 · 存档摘要 · 开启新会话（minimal 不加任何插件）**

- **动机**：minimal 无压缩栈（R42 决议保其简约），长会话只能 `/new` 弃上下文；人工 SOP（总结→/new→带回）该自动化。方案定稿：**纯通道编排，零挂载、零常驻 token 成本**——压缩作为命令的副产品，不是模式的属性。
- **命令**：
  - `/compact`：旧历史由模型总结为交接摘要 → 插件写入 `<workspace>/.feishu4dsh/compact/<YYYYMMDD-HHMMSS>.md`（含时间戳/源会话/模式）→ 开新会话 → 摘要作为新会话首条材料注入；
  - `/compact N`：另把**最近 N 轮**「用户/助手」原文随开场注入（从会话日志轮次折叠重建，字符预算 6000，**从最新往旧花**，超支截断并注明全文所在）；
  - `/compact N <问题>`：新问题随行，新会话首轮即回答它。
- **归属**：standard（及任何挂了宿主压缩栈的 preset）中 `/compact` 仍走宿主命令运行时（compactNow）；通道仅在宿主缺失该命令的 preset（minimal）接管。R42 的「当前模式未提供」区不再列 compact（通道已提供，`/help` 频道区可发现）。
- **安全红线**：摘要未落文件前**绝不 reset**——摘要 turn 失败/超时（180s）/空输出 → 失败回执、原会话原样保留、可重试；压缩进行中到达的纯文本消息挂起并在新会话开场后自动转发（首条给提示），带附件的消息退回请用户稍后重发；其余斜杠命令期间照常可用。
- **其他**：压缩 turn 的输出照常渲染（透明可复核）；ACL 沿用管理面门控（群聊=审批人+管理员）；旧会话保留于会话注册表可 `/session` 切回（无损存档）。
- **测试**：303/303（新增 7：基线存档+N 尾带+失败保上下文 ×2（error/中断 null）+ standard 分流 + 忙拒绝 + hold 队列转发；R42-a/b 两条改口径至新语义）。

## 0.11.1 (2026-10-08)

**R45：turn/end 渲染链加固与上下文超限引导（AI 代码审核 P1–P4 打包）**

- **触发**：用户会话终态不渲染。审计日志实证 10-07 序列——`turn/end` 带 `reason:null`（dsh 0.2.0 中断 turn 收口形状）渲染链直接读 `reason.kind` 抛错；随后 `agent/inbox/spliced`（`removedCount:3, outcome:"canceled"`)把 3 条排队输入静默丢弃，用户侧毫无回执。
- **修复**：
  - **P1**：`TurnEndData.reason` 类型改可空，`turnErrorDetail()` 对 `null` 返回空——中断 turn 按无详情正常折叠收口，渲染管线不再 panic；
  - **P2**：`resetSessionScope` 补清该绑定的 `streamedTurns`（此前只有 `dispose` 全清，`/mode`/`/new` 半清留脏标记，恢复后的 turn 可能吞正文或误判重复）；
  - **P3**：宿主丢弃排队输入时给用户回执（双语）；通道自己发起的取消（`/stop`、`/session` 切换、preset 重置）已在调用 `cancel()` **之前**注册静默闸——宿主在 cancel 内同步 splice，注册晚了会输掉竞速——其丢弃不重复播报；闸板一次消费即失效，dispose 后回收未消费标记；
  - **P4**：`turn/end` 失败原因命中 `maximum context length` 时，在失败说明后追加引导（`/compact` 压缩本会话（标准模式组合）或 `/new` 开新会话）；与 R42 在 `/help` 中的「当前模式未提供」事前告知互补，不替代。
- **测试**：296/296（新增 4：R45-a 空安全收口 / R45-b `/new` 清流标记 / R45-c 自发丢弃回执+通道取消静默 / R45-d 超限引导追加）。R45-c 一并锁定了「静默闸必须先于 cancel 注册」的时序约定。

## 0.11.0 (2026-10-07)

**R44：修复 dsh 0.2.0 上的持久化断链（根）与 `/mode` 切换失效（果）**

- **问题**：升级 dsh 0.2.0 后，插件的全部运行态持久化**静默失效**——`/mode` 切换在内存里成功、却因指针落后于磁盘而撞回旧会话（会话预设首轮后锁定），用户看到「切换无效」；`/model` 清单增删、推理强度表、会话注册表的改动全部重启即丢，且日志里**没有任何报错**。
- **根因**：0.2.0 移除了 `settings.register(ns, schema, { base })`（插件的 settings 节即 profile patch 的 entry config，校验走插件自身 Config schema）。插件启动时调用它抛 TypeError，仅 cordis logger 可见（journald 不可见）；随后 `settingsScope = undefined` 让 7 个持久化 hook 全部变为 undefined，bridge 的可选链调用静默跳过——连 catch 都进不去，零失败上报。
- **修复**：
  - **A（根）**：runtime.ts 迁到 0.2.0 API——写经 `settings.update('feishu4dsh', patch)`（deep-merge，等价旧语义）；读 = entry config（R30 深冻结水合边界不变）；`src/config.ts` 把 8 个运行时状态字段标 `volatile`（0.2.0 只接受 volatile 路径写入；经构建产物核验 `meta.volatile === true` 8/8）。
  - **B（保险带）**：`/mode`//`/new` 的代次推进后核对目标 id 在磁盘上的新鲜度（`sessionQuery.observeSession` 成功=已存在 → 继续推进，有界 5 次）——持久化再出故障也能真正切出会话；与 R37 的 create 侧自愈分工互补。
  - **C（可观测）**：settings 服务不可用时通过运维通知明确告警（「持久化已禁用：/mode、/model 清单与推理强度、会话注册表的改动重启即丢」），不再静默。
- **测试**：292/292（新增 4：ns 包装 / 缺失告警 / volatile 元数据 / 撞车推进）。

## 0.10.2 (2026-10-07)

**R43：`/model del` 持久化修复 + 子命令防呆**

- **修复**：`/model del <provider>/<model>` 此前只改内存、不落盘——重启或配置重载后条目会回来（若之后恰好 auto-learn 过新模型，又会被顺带写回，表现为时好时坏）。现在删除成功即调用与 add 相同的持久化路径。R33 引入起即存在，非回归。
- **防呆**：
  - `/model remove` 成为 `del` 的别名（兼容习惯说法）；
  - 含空白的伪目标（如 `/model rm p/m`）在解析层被拒绝并回用法——不再 pin 出不存在的 `provider="remove p"`，也不再把它 auto-learn 进点选清单；
  - `/model del|remove` 无参数仍回用法提示。
- **测试**：288/288（新增 3：删除持久化断言收紧、`remove` 别名持久化、空白伪目标不 pin/不写清单；清理 R33 残留调试输出）。

## 0.10.1 (2026-10-07)

**R42：minimal 模式下的 `/compact` 可用性提示**

- **背景**：`/compact` 是宿主插件行（`dsh-command-compact` + `compaction-basic`），按 preset 挂载；`minimal` 刻意不含压缩栈（省 token 为该模式的设计目标），此前在 minimal 下输入 `/compact` 只会得到「未知命令」，用户无从得知"切模式即可用"。
- **变更**（仅 UX，不改任何 preset 组合）：
  - minimal 会话 `/help` 在宿主命令区后新增「**当前模式未提供**」区，列出 `/compact` 并提示 `/mode standard`（切换会开启新会话）；宿主实际已注册的同名命令会被过滤，避免重复；
  - minimal 会话直接输入 `/compact` 时回复同样的说明（含设计理由），不再回「未知命令」；
  - `standard` 行为不变（`/compact` 正常列出并可用）。
- **测试**：285/285（新增 2 条：minimal 的 `/help` 提示、`/compact` 直接调用提示）。

## 0.10.0 (2026-10-01)

**R41：迁移到 dsh 0.2.0-rc.2 的 Agent 预设机制（破坏性兼容断代）**

- **兼容底线**：要求 **dsh ≥ 0.2.0-rc.2**。dsh 0.2.0 把预设机制整体重做，本版与 v0.9.x（dsh 0.1.5 线）**不可混装**。
- **背景**：0.2.0 移除了 `@deepseek-ai/dsh-agent-presets`（内置 standard/minimal/cordis/ptc 预设目录 + roster 服务），改为 `@deepseek-ai/dsh-agent-preset-registry`（`agentPresets` 服务）**+ 每个预设一条 `@deepseek-ai/dsh-agent-preset` 声明行**（组合内联在 `plugins`），且 **dsh 不再内置任何预设**；配置载体由 `settings.yaml` 迁移到 per-profile `cordis.patch.yml`。升级后飞书入口曾报 `agent-presets: preset "minimal" not found (available: none)`，导致会话无法 resume/创建。
- **修复**：
  - 插件 bundle patch（`cordis.patch.yml`）改为挂 `agent-preset-registry` 行，并**出厂声明** `standard`（完整编码 Agent）与 `minimal`（仅持久 shell、无 runtime context 注入）两条预设；部署层 profile patch 可用同 id 覆盖声明，保留按部署定制的能力；
  - 宿主模型面工具行 disable 清单对齐 0.2.0 的 24 行：`workflow-worker-thread` → `workflow-ptc`（0.2.0 改名）、新增 `tool-plugin-manager`；
  - bridge 代码零改动：`agentPresets.mount` / `sessionQuery.observeSession` / `llm.resolveModelInfo` / `meta.agentPreset` 等契约在 0.2.0 形状兼容。
- **测试**：283/283（R38-g patch 断言升级为 0.2.0 口径：24 行 disable 精确相等、registry 行与两条声明在位、旧包与旧行 id 负断言）。

## 0.9.0 (2026-09-27)

**R38+R39：preset 真正生效（minimal 从未生效的修复）+ `/model effort` 预校验与精确键**

- **兼容底线（破坏性）**：要求 **dsh ≥ 0.1.5-rc.1**（0.1.4 及以下不可用）。本版插件 bundle patch 挂载宿主 `agent-presets` 名册并把宿主模型面工具行让位给 preset 层，更早的 dsh 既无名册也无该拆层语义。
- **R38：agent preset 由宿主真实挂载**（此前所有版本上，`/mode` 只是写会话头标签，standard/minimal 工具面从未变化）：
  - 插件 bundle patch（`cordis.patch.yml`）挂 `agent-presets` 名册（`default: standard`），并按 dsh-web-app 口径把 23 条宿主模型面工具行逐条 `disabled: true`（shell/fs/skills/jobs/goals/plan-mode/subagent 工具/workflow/ralph/todo/web/compaction 等）——工具与提示面改由 preset 组合提供；
  - 会话创建 setup **先 `agentPresets.mount(agentCtx, preset)` 再注册 agent 面行**（与 web 入口同构；preset 组合损坏时会话创建失败，不产出半装配会话）；
  - 恢复旧会话前经宿主 `sessionQuery.observeSession` 读取**会话真实 preset**（投影优先、会话头次之），读不到回退配置链路值；观察失败每进程仅一条运维提示；
  - `/status` 的"模式"一行从此反映实际挂载的组合。`standard` = 完整工具集；`minimal` = 仅持久 shell（无 fs/subagent/workflow，且无 runtime context 注入）。
- **R39：`/model effort` 设置前按模型能力预校验**（对照 dsh web `selectModel`）：
  - 设置前经宿主 `llm.resolveModelInfo` 校验档位：模型无 reasoning 能力、或档位不在支持列表（如 qwen3.8-flash 的 `high`）→ **当场双语报错并列出支持档位**，不再"设置成功、下一轮报 UNSUPPORTED_REASONING_EFFORT"；`default` 恒合法；宿主 llm 不可达时按现状写表（每进程一条降级提示）；
  - 设置/清除确认文案改显**精确 `provider/model` 键**（偏好按 provider/model 记住，同名模型跨 provider 各自独立）；
  - 修复 opencode-go 等模型 effort"设了没反应"（偏好键缺失所致，配置层恢复见部署说明）。
- **测试**：283/283（基线 271 + R38 新增 7 + R39 新增 5）。

## 0.8.1 (2026-09-14)

**R37：修复会话恢复失败的死循环（`session "..." already exists`）**

- **现象**：宿主升级后，部分升级前的旧会话每轮报「本轮执行失败：session "..." already exists」，与模型无关、重试无效，直到手动 `/new` 推进到全新会话。
- **根因**：会话恢复（resume）失败的第一因被通道层静默吞掉，兜底逻辑用**同一个 id** 新建会话；宿主会话存储已登记该 id（恢复半途失败的残留），新建必然撞车，且该 id 在进程存活期内永久不可用。
- **修复**：① 恢复失败的第一因现在会进入运维日志（兜底吞控制流不吞信息）；② 新建撞到"id 已占用"时自动推进到全新代际重试（与 `/new` 同机制，最多 3 次、单轮封顶 4 次创建），成功后告知用户「旧会话无法恢复，已自动开启新会话（旧记录可 `/session` 回看）」；③ 其他类型的创建错误原样抛出，不掩盖根因。
- **测试**：271/271（新增 5：首撞自愈+持久化+提示 / 连撞有界推进 / 耗尽如实报错 / 第一因上报 / 非占用错误不自愈）。

## 0.8.0 (2026-09-11)

**R36：飞书端思考过程（reasoning）可见——可折叠思考面板 + 过程行止血**

- **问题**：多数轮次模型只产出思考、不产出正文，而插件把 reasoning 整段丢弃（`bridge.ts` 只放行 `text-delta`），卡片又停在 SDK 默认英文占位 `Thinking...`、`step/start` 事件从未消费——用户全程只见静止的"正在处理"，主观感受是"卡死"。
- **阶段一（止血）**：流式占位改为本地化文案（`💭 正在思考…`，随 `locale` 切换）；推理期间卡片按 1.5s / 200 字节流更新过程行（`💭 思考中 · 第 3 步 · 已 12s · 工具 bash ×2`，**只统计字数与时长，不显示思考原文**）；一轮只有思考没有正文时，收口为 `💭 本轮只有思考：1,204 字 · 18s · 工具 bash ×2`，不再是"假死"观感。
- **阶段二（完整形态）**：回复卡片拆成两块——`collapsible_panel` **思考区**（reasoning 原文，流式增量更新）+ markdown **正文区**；轮末思考区收成一行 `💭 思考过程（N 字 · Xs）` 并**默认折叠保留**。新增配置 `showReasoning`（默认 `true`）与会话级命令 `/reasoning`（查看当前值与来源）/ `/reasoning on|off`（按 scope 覆盖并持久化，ACL 同 `/mode`）。**私聊默认展开、群聊默认折叠**；超长思考保留头尾并标注「已省略 N 字」。
- **工具调用细节**：维持原有取舍（不逐步刷屏，轮末聚合一行），仅把实时计数并入过程行。
- **降级**：`showReasoning: false`、`/reasoning off`、或传输不支持整卡流时，静默回到既有 Markdown 流式路径；`output: card` 不做 live 过程行，但收口卡片仍带折叠面板。`collapsible_panel` 需客户端 ≥ V7.9（更低版本面板体显示升级占位，正文不受影响）。
- **实现取舍**：未采用 SDK 的 `{card:{initial,producer}}` 流控制器——其内部定时 patch 失败会成为 unhandledRejection（对照 markdown 控制器缺少 `streamingFailed` 兜底），一次撤回/限流即可能终止宿主进程；改为「占位发送 + 桥层节流整卡 patch」，最终同样落到 `im.v1.message.patch`，视觉等价而失败有界。正文落账语义（`streamedTurns`）全程未被思考内容污染。
- **测试**：266/266（新增 28：阶段一 8 + 阶段二 20；含 6 组变异验证确认用例有捕获力）。

## 0.7.2 (2026-09-09)

**R34：修复 /model 下拉点选静默失效**

- **影响**：v0.7.0 起 `/model` 选择卡（下拉）点击后无任何反应，模型从未切换（确认卡也不出现）；文本命令 `/model <provider>/<model>` 不受影响。
- **根因**：飞书 `select_static` 下拉的卡片回调把选中项的值放在 `action.option`，而桥只解码 `action.value`（组件级 value，本卡为空串）→ 解析失败 → 静默丢弃。按钮类卡片（审批、/ws、/session、翻页）走 `action.value`，不受影响。
- **修复**：回调解码改为 `action.option` 优先（非空字符串时），否则回落 `action.value`。
- **顺带加固**：下拉选项的解析与渲染改为同一数据源（运行时清单）——此前渲染用运行时清单、解析用启动冻结副本，清单经 `/model add|del` 或自动学习变化后两者会错位，点击可能切到错误模型；已失效菜单的点击从静默改为回复提示（转发到其他聊天的失效卡仍静默）。
- **测试**：238/238（新增 3 条：下拉真实回调形态点击切换、清单同源解析、失效提示与静默边界；修复前还原验证 3 条全红）。

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
