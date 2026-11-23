/**
 * UI copy in zh-CN and en-US. Channel-owned strings render in the READER's
 * language when `locale` is `auto`; host-provided content is never rewritten.
 * @module feishu4dsh/strings
 */

import type { Config } from './config.js'

export type Locale = 'zh-CN' | 'en-US'

/** Every channel-owned string, both languages. */
export interface Strings {
  thinking: string
  processHeader: string
  toolCallLine: (toolName: string) => string
  toolCallCountLine: (toolName: string, count: number) => string
  toolCallSummary: (parts: readonly string[]) => string
  /**
   * R36: the placeholder a streaming reply carries before its first chunk.
   * Fed to the SDK as `outbound.streamInitialText`, replacing its built-in
   * English `Thinking...`, and kept here so the adapter holds no copy.
   */
  streamInitial: string
  /**
   * R36: one live process line while a turn runs — step / elapsed seconds /
   * tool tallies, never reasoning text. `step <= 0` omits the step segment;
   * an empty `tools` omits the tool segment.
   */
  processLine: (step: number, elapsedSeconds: number, tools: string) => string
  /** R36: compact per-tool tally inside process/summary lines (`bash × 2`). */
  toolCountCompact: (toolName: string, count: number) => string
  /**
   * R36: turn/end closing line for a turn that reasoned but produced no body
   * text, so the card never ends on a live status line (or an empty reply).
   */
  reasoningOnlyLine: (chars: string, elapsedSeconds: number, tools: string) => string
  /**
   * R36-2: live header of the collapsible reasoning panel while a turn runs
   * (card reply surfaces only).
   */
  reasoningPanelTitleLive: (chars: string, elapsedSeconds: number) => string
  /**
   * R36-2: closing header of the reasoning panel — `turn/end` folds the panel
   * and keeps it, with the turn's reasoning size and duration.
   */
  reasoningPanelTitleDone: (chars: string, elapsedSeconds: number) => string
  /**
   * R36-2: middle-omission marker when reasoning exceeds the card element
   * budget (head + tail are kept, this states how much was dropped).
   */
  reasoningOmitted: (chars: string) => string
  /**
   * R49: a card page filled its body budget and rolled over to a fresh card;
   * this note closes the frozen page pointing at the next one.
   */
  cardOverflowNextPageNote: string
  usageSummary: (input: string, output: string, cacheRead: string | undefined, cacheWrite: string | undefined, reasoning: string | undefined) => string
  approvalTitle: string
  approvalReasonLabel: string
  approveButton: string
  denyButton: string
  approvalApprovedBy: (name: string) => string
  approvalDeniedBy: (name: string) => string
  approvalTimedOut: string
  approvalWrongChat: string
  /** R51: heading of an `ask_user` form card. */
  questionTitle: string
  /** R51: submit button of an `ask_user` form card. */
  questionSubmit: string
  /** R51: placeholder of a `select_static` option control. */
  questionSelectPlaceholder: string
  /** R51: placeholder of the free-text "other" input. */
  questionCustomPlaceholder: string
  /** R51: shown when a question offers no options (free text only). */
  questionNoOptionsHint: string
  /** R51: settled-card status when a human answered. */
  questionAnsweredBy: (name: string) => string
  /** R51: settled-card status when the ask expired or was withdrawn. */
  questionTimedOut: string
  fileReceivedNote: (pathInWorkspace: string, size: string) => string
  imageReceivedNote: string
  unsupportedMediaNote: (kind: string) => string
  mediaTotalTooLargeNote: (limit: string) => string
  helpTitle: string
  /** Section header for commands owned by this channel. */
  helpChannelHeader: string
  /** Section header for commands delegated to the dsh host. */
  helpHostHeader: string
  /** R42: host commands the current preset deliberately does not mount. */
  helpUnavailableHeader: string
  helpUnavailableCommand: (command: string, preset: string) => string
  commandUnavailable: (command: string, preset: string) => string
  /** R45 (P4): appended to a context-length failure (channel commands can shrink the session). */
  contextLimitHint: string
  /** R45 (P3): receipt when the host discarded queued inputs without running them. */
  queuedInputsDropped: (count: string) => string
  /** R46: /compact channel help line (only where the host compaction stack is absent). */
  compactHelpLine: string
  /** R46: the summarization instruction sent to the model as the compaction turn. */
  compactInstruction: string
  /** R46: refusal when a compaction is already pending or a turn is running. */
  compactBusy: string
  /** R46: refusal when there is no live session to compact. */
  compactNoSession: string
  /** R46: failure receipt; the session is preserved verbatim. */
  compactFailed: (detail: string) => string
  /** R46: failure reasons. */
  compactTimedOut: string
  compactEmptySummary: string
  /** R46: success receipt (file path + how many held messages were forwarded). */
  compactDone: (path: string, held: string) => string
  /** R46: first notice when a text message is held during a compaction. */
  compactHolding: string
  /** R46: the compaction was canceled by a destructive command (/new, /stop, …). */
  compactCanceled: string
  /** R46: held messages dropped because the session was reset mid-compaction. */
  compactHeldDropped: (count: string) => string
  /** R46: refusal for attachments during a compaction (v1 holds text only). */
  compactAttachmentHolding: string
  /** R46: opener sections. */
  compactOpenerHeader: string
  compactOpenerSummaryHeader: string
  compactOpenerTailHeader: (count: string) => string
  compactTailTruncated: string
  compactOpenerQuestionHeader: string
  compactTailUser: string
  compactTailAssistant: string
  /** Inline source tag for a channel-owned command line. */
  helpChannelTag: string
  /** Inline source tag for a dsh host command line. */
  helpHostTag: string
  /** Channel-owned command lines (`/cmd — description`), one per entry. */
  channelCommands: readonly string[]
  statusTitle: string
  statusSession: (sessionId: string) => string
  statusScope: (scope: string) => string
  /** Bilingual scope label: Chinese name + English in parentheses (R26). */
  scopeLabel: (scope: string) => string
  statusWorkspace: (name: string, path: string) => string
  statusModel: (model: string) => string
  /* /status statistics block (R26): preset / effort / turns / token totals. */
  statusPreset: (preset: string) => string
  statusEffort: (effort: string, source: string) => string
  statusTurns: (turns: string, steps: string) => string
  statusTokens: (input: string, output: string, cacheRead: string | undefined, cacheWrite: string | undefined, reasoning: string | undefined) => string
  statusTokensUnavailable: string
  /** Source tag when the shown effort was measured from the last request. */
  effortSourceMeasured: string
  /** The “—” placeholder for unavailable statistics. */
  statusStatsUnavailable: string
  /* Model display & switching (/model, R7/R8). */
  modelTitle: string
  /** Marker appended when the shown model comes from this session; '' = none. */
  modelSourceSession: string
  modelDefaultNotStarted: string
  modelSwitched: (provider: string, model: string) => string
  modelSaveDefaultDone: (provider: string, model: string) => string
  modelSaveDefaultUnsupported: string
  modelUnsupported: string
  modelUnknown: string
  modelNoPermission: string
  modelUsage: string
  /* Reasoning effort (/model effort, R28/R55). */
  modelEffortLine: (effort: string, source: string) => string
  effortSourcePreferred: string
  effortUnknown: string
  effortUsage: string
  /** R55-D4: host-advertised effort ids for the current route. */
  effortSupportedLine: (supported: string) => string
  /** R55-D6: last request-header state, separate from the preference table. */
  effortMeasuredUnavailable: string
  effortMeasuredNone: string
  effortMeasuredAbsent: string
  effortMeasuredValue: (level: string) => string
  /** R55-D3: shown when the in-memory change could not be persisted. */
  effortPersistenceWarning: string
  /**
   * R39: rejection when the model HAS a reasoning capability but not the
   * requested level. `supported` is the capability's effort-id list joined
   * with " / ". The model shows the exact `provider/model` preference key.
   */
  effortUnsupported: (level: string, model: string, supported: string) => string
  /** R39: rejection when the model carries no reasoning capability at all. */
  effortUnsupportedNoCapability: (model: string) => string
  /**
   * R39: the confirmation names the EXACT `provider/model` key the
   * preference is remembered under (`model` here is that full key).
   */
  effortSet: (level: string, model: string) => string
  /** @see effortSet for the key semantics of `model`. */
  effortCleared: (model: string) => string
  /* Session mode (/mode, R27): view / set the scope's agent preset. */
  modeTitle: string
  modeCurrent: (preset: string) => string
  modeNotStarted: string
  modeNext: (preset: string) => string
  modeDefaultLine: (preset: string) => string
  modeSwitched: (preset: string) => string
  modeAlready: (preset: string) => string
  modeUsage: string
  modeNoPermission: string
  /* Reasoning display (/reasoning, R36 stage two): view / set the scope switch. */
  reasoningTitle: string
  /** `state` is {@link reasoningShown} / {@link reasoningHidden}. */
  reasoningCurrent: (state: string, source: string) => string
  reasoningDefaultLine: (state: string) => string
  reasoningSwitched: (state: string) => string
  reasoningAlready: (state: string) => string
  reasoningUsage: string
  reasoningNoPermission: string
  /** Label for the enabled state (`显示` / `shown`). */
  reasoningShown: string
  /** Label for the disabled state (`隐藏` / `hidden`). */
  reasoningHidden: string
  /** Where the shown state comes from: this scope's `/reasoning` override. */
  reasoningSourceScope: string
  /** Where the shown state comes from: the deployment's `showReasoning`. */
  reasoningSourceConfig: string
  /* Session registry (/session, R29): list / switch / rename / archive. */
  sessionTitle: string
  sessionListEmpty: string
  sessionArchivedTag: string
  sessionUsage: string
  sessionSwitched: (title: string) => string
  sessionAlreadyCurrent: (title: string) => string
  sessionUnknown: (n: number) => string
  sessionRenamed: (title: string) => string
  sessionRenameUsage: string
  sessionNothingToRename: string
  sessionNoPermission: string
  sessionArchiveUnsupported: string
  sessionArchiveUnavailable: (detail: string) => string
  sessionArchiveUsage: string
  sessionArchivedOne: (title: string) => string
  sessionArchivedMany: (count: number, titles: string) => string
  sessionArchivedAlready: (title: string) => string
  sessionArchiveNone: (days: number) => string
  sessionArchiveFailed: (detail: string) => string
  /** Boundary note: only Feishu-side sessions are archivable from the channel. */
  sessionArchiveForeign: string
  /**
   * R37: notice when the session id this chat pointed at was poisoned
   * (resume failed and create reported it taken) and the bounded self-heal
   * opened a fresh generation automatically. States: the old session could
   * not be resumed, the new one is live, and the old records stay browsable
   * via /session.
   */
  sessionAutoHealed: (oldId: string, newId: string) => string
  /* Workspace listing & switching (/ws, /cd). */
  wsTitle: string
  wsEmpty: string
  wsCurrentTag: string
  wsDefaultTag: string
  cdUsage: string
  cdSwitched: (name: string, path: string) => string
  cdNotFound: (target: string) => string
  cdNotAllowed: (target: string) => string
  cdAmbiguous: (target: string, names: string) => string
  cdNoPermission: string
  /* Workspace management (/ws add, /ws remove). */
  wsUsage: string
  wsAddUsage: string
  wsRemoveUsage: string
  wsNoPermission: string
  wsAdded: (name: string, path: string) => string
  wsRemoved: (name: string, path: string) => string
  wsNotUserAdded: (target: string) => string
  wsNotDirectory: (target: string) => string
  /* Interactive menus (R32: /ws picker, /ws new browser, /model picker, /session picker). */
  wsMenuTitle: string
  wsMenuEmpty: string
  wsMenuNote: string
  modelMenuTitle: string
  modelMenuPlaceholder: string
  modelMenuExpiredNote: string
  menuPrevLabel: string
  menuNextLabel: string
  menuPageOf: (page: number, total: number) => string
  menuExpired: string
  /** R34: the card's menu is gone entirely (replaced, dropped, or a restart). */
  menuGone: string
  menuWrongChat: string
  menuWsSettledTitle: string
  menuModelSettledTitle: string
  menuSessionSettledTitle: string
  menuBrowseSettledTitle: string
  sessionMenuTitle: string
  sessionMenuNote: string
  browseNoRoots: string
  browseEmpty: string
  browseConfirm: string
  browseParent: string
  browseNote: string
  wsMkdirDone: (name: string, path: string) => string
  wsMkdirInvalid: (name: string) => string
  wsMkdirUsage: string
  /* R33: model catalog management. */
  modelCatalogHint: string
  modelAddDelUsage: string
  modelAdded: (entry: string) => string
  modelAddExists: (entry: string) => string
  modelCatalogFull: (cap: number) => string
  modelDelMissing: (entry: string) => string
  modelDeleted: (entry: string) => string
  modelRemoveLast: string
  modelAddCurButton: string
  newSessionDone: string
  stopped: string
  nothingToStop: string
  turnFailed: (detail: string) => string
  sendFileApprovalTitle: string
  sendFileApprovalDetail: (pathInWorkspace: string, workspaceName: string, size: string) => string
  outsideWorkspaceRefusal: string
  fileNotFoundRefusal: string
  notAFileRefusal: string
  tooLargeRefusal: (size: string, limit: string) => string
  commandUnknown: (line: string) => string
  /* SHE secretary handoff (R56). */
  sheUsage: string
  sheHelpTopic: (topic: string) => string
  sheDisabled: string
  sheNoPermission: string
  sheInitUnavailable: string
  sheNeedTitle: string
  sheNeedItem: (status: string, label: string, detail: string) => string
  sheNeedReady: string
  sheNeedNext: string
  /* SHE build-sandbox (R61). */
  sheSandboxStatusTitle: string
  sheSandboxReady: string
  sheSandboxNotReady: string
  sheSandboxWizardTitle: (step: string) => string
  sheSandboxWizardSummary: (name: string, target: string, agent: string, tools: string, network: string) => string
  sheSandboxTargetNote: string
  sheSandboxAgentNote: string
  sheSandboxToolsNote: string
  sheSandboxConfirmNote: string
  sheSandboxBack: string
  sheSandboxNext: string
  sheSandboxBuild: string
  sheSandboxCancel: string
  sheSandboxToolLabel: (label: string, selected: boolean) => string
  sheSandboxImageRequired: (label: string) => string
  sheSandboxTargetUnavailable: string
  sheSandboxTargetWarning: string
  sheSandboxCardUpdateFailed: string
  sheSandboxPackageDone: (name: string, archivePath: string) => string
  sheSandboxUsageGuide: (name: string, requiresRootBootstrap: boolean, targetUser: string) => string
  sheSandboxUnavailable: string
  sheNeedAliasHint: string
  sheNeedPackageDeprecated: string
  sheInitOk: (shadowRepo: string, runtimeRoot: string, version: string) => string
  sheInitUpdateOk: (shadowRepo: string, head: string) => string
  sheInitResetOk: (shadowRepo: string) => string
  sheReturned: (label: string, returnDir: string, changed: number, added: number, outputs: number) => string
  sheAccepted: (label: string, staged: number, copied: number, appliedPatch: boolean) => string
  sheDoctorTitle: string
  sheDoctorSource: (source: string, stateFile: string, statePresent: string) => string
  sheDoctorHealth: (ok: boolean, detail: string) => string
  sheDoctorRuntime: (runtimeRoot: string, worktreeRoot: string, reposRoot: string) => string
  sheDoctorScope: (shadowRepo: string | undefined) => string
  sheSubmitted: (label: string, status: string) => string
  sheContinued: (label: string, status: string) => string
  sheInvalid: (reason: string) => string
  sheListEmpty: string
  sheTopicListLine: (label: string, status: string, excerpt: string, summary: string) => string
  sheTaskListLine: (label: string, status: string, excerpt: string) => string
  sheTaskSummary: (total: string, running: string, queued: string, done: string) => string
  sheStatusTitle: string
  sheStatusTopic: (label: string, status: string, excerpt: string) => string
  sheStatusTask: (label: string, status: string, excerpt: string) => string
  sheStatusSession: (sessionId: string) => string
  sheStatusReport: (path: string) => string
  sheStatusAttachments: (count: string) => string
  sheNotFound: (reference: string) => string
  sheReportMissing: (label: string) => string
  sheReportReady: (label: string, size: string) => string
  sheStopped: (label: string) => string
  sheResumed: (label: string) => string
  sheRenamed: (oldLabel: string, newLabel: string) => string
  sheRemoved: (label: string, purged: boolean) => string
  sheError: (code: string, detail: string) => string
}


function sheHelpZh(topic: string): string {
  const map: Record<string, string> = {
    init: [
      '/she init — 初始化当前话题的 SHE 运行环境',
      '',
      '作用：',
      '  1. 读取当前聊天绑定的 git workspace，在共享区创建 shadow repo；',
      '  2. 创建 SHE runtime 与 worktree root；',
      '  3. 设置 bot2603/opencode-she ACL；',
      '  4. 探测 OpenCode /api/info；',
      '  5. 写入 0600 状态文件，并在当前进程启动 SHE。',
      '',
      '仓库名自动生成：<源仓库 basename>-shadow-repo，不接受自定义名称。',
      '同一 scope 只能初始化一次；已初始化请用 /she init update，',
      '需要更换源仓库时先 /she init reset。',
      '注意：仅审批人可用；当前工作区必须是 git 仓库；clone 只包含已提交 HEAD。',
    ].join('\n'),
    update: [
      '/she init update — 更新当前 scope 的 shadow repo',
      '',
      '从源 repo fetch 已提交更新并 fast-forward；有排队/运行中任务、',
      'shadow 主工作区有未提交改动或非 fast-forward 时拒绝。',
    ].join('\n'),
    reset: [
      '/she init reset — 清除当前 scope 的 shadow repo 映射',
      '',
      '只删除状态文件中的 scope 映射，不删除 shadow repo 目录；',
      '用于误初始化后重新 /she init，或切换到其他源仓库。',
    ].join('\n'),
    need: [
      '/she need — 兼容入口：等同 /she sandbox status',
      '/she need verify — 兼容入口：等同 /she sandbox status',
      '/she need package — 已弃用；按默认 OpenCode 方案转交 /she sandbox build',
      '',
      '新部署请直接使用：/she sandbox status / /she sandbox build。',
    ].join('\n'),
    sandbox: [
      '/she sandbox — 打开 build-sandbox 交互式构建向导',
      '/she sandbox status — 合并只读检查：主机预检 + descriptor/OpenCode/runtime 接入检查',
      '/she sandbox build [flags] — 非交互生成安装包',
      '',
      'flags: --target current-user|dedicated-user --agent opencode|hermes|deepseek-harness|blank|custom',
      '       --image <ref> --tools core,node,python,build,data,search --network none|egress --name <name>',
      '',
      '生成包固定使用 $HOME/.local/share/feishu4dsh/sandboxes/<name>/；',
      '工作区只挂载 workspace/home/cache 三个叶子目录，不挂 Docker socket 或父目录。',
      '专用账户模式会另带 root bootstrap 脚本，必须在飞书外审查执行。',
    ].join('\n'),
    doctor: [
      '/she doctor — 查看 SHE 诊断信息',
      '',
      '显示：来源（manual/bootstrap/none）、状态文件、OpenCode health、',
      'runtime/worktree/repos 路径、当前话题的 shadow repo。',
      '仅审批人可执行，避免泄露宿主绝对路径。',
    ].join('\n'),
    submit: [
      '/she submit <任务原文> — 新建 Topic 并提交任务',
      '',
      '建议写成：目标 + 范围 + 验收 + 禁止事项。',
      '报告/补丁/outputs 路径由 SHE 固定信封自动生成，用户不要指定。',
      '示例：/she submit 阅读 README.md，总结当前插件用途；',
      '  验收：200 字以内；禁止：修改文件、commit/push、安装依赖。',
    ].join('\n'),
    continue: '/she continue <Topic> <任务原文> — 在同一 Topic 追加串行任务。\n示例：/she continue 1 补充测试并更新报告。',
    list: '/she list — 查看全部 Topic/Task。\n/she list <Topic> — 查看指定 Topic 的任务列表。',
    status: '/she status <Topic|Task> — 查询 Topic 或任务状态；运行中的任务会主动刷新一次执行器状态。',
    report: '/she report <Task> — 校验并回传任务报告文件；群聊仍走文件审批。',
    return: [
      '/she return <Task> — 把任务结果复制回当前项目的 she_returns/<task-id>/',
      '',
      '生成 REPORT.md、CHANGES.patch、changed-files/、new-files/、outputs/ 和 manifest.json；',
      '不修改项目源码、不 git add、不 commit。',
    ].join('\n'),
    accept: [
      '/she accept <Task> — 应用 she_returns/<task-id>/ 到当前项目并 stage',
      '',
      '先 git apply --check；冲突时拒绝。只 stage manifest 列出的项目路径；',
      '不 commit、不 push。默认动作等价于 git apply + 新文件复制 + git add。',
    ].join('\n'),
    stop: '/she stop <Task> — 中断当前运行任务并暂停其 Topic；排队任务保留。',
    resume: '/she resume <Topic> — 恢复暂停的 Topic 队列，从下一个 queued task 继续。',
    rename: '/she topic rename <旧编号> <新编号> [--force] — 重命名 Topic；冲突时用 --force 自动改旧编号。',
    remove: '/she topic remove <Topic> [--purge] — 归档并隐藏 Topic；--purge 会删除 worktree 与数据库记录。',
  }
  return map[topic] ?? `未知 SHE 帮助主题：${topic}\n发送 /she help 查看全部命令。`
}

function sheHelpEn(topic: string): string {
  const map: Record<string, string> = {
    init: [
      '/she init — initialize SHE for the current chat',
      '',
      'Creates a shared shadow repo from the current git workspace, prepares the',
      'runtime/worktree root and ACLs, probes OpenCode, writes a 0600 state file,',
      'and starts SHE in-process.',
      '',
      'The repo name is derived as <source-basename>-shadow-repo; custom names are not accepted.',
      'One init per scope: use /she init update to refresh it, or /she init reset before switching source repos.',
      'Admins only; the current workspace must be a git repository; the clone contains committed HEAD only.',
    ].join('\n'),
    update: '/she init update — fast-forward the current scope shadow repo from committed source HEAD; refuses with unfinished tasks, dirty shadow tree or non-FF updates.',
    reset: '/she init reset — forget the current scope→shadow mapping without deleting files; use before re-initializing or switching projects.',
    need: '/she need and /she need verify are compatibility aliases for /she sandbox status. /she need package is deprecated and maps to the default OpenCode /she sandbox build path.',
    sandbox: '/she sandbox — open the interactive build-sandbox wizard. /she sandbox status — read-only Docker/rootless/user/subuid/linger checks. /she sandbox build [flags] — generate a package non-interactively.',
    doctor: '/she doctor — show source, state file, OpenCode health, runtime paths and current-scope shadow repo (admins only).',
    submit: [
      '/she submit <request> — create a Topic and enqueue a task',
      '',
      'A good request states: goal + scope + acceptance + forbidden actions.',
      'SHE injects the report/patch/output paths automatically; do not specify them.',
      'Example: /she submit Read README.md and summarize the plugin; acceptance: <=200 words;',
      '  forbidden: modify files, commit/push, install dependencies.',
      '',
      'Keep it concise: scope, acceptance and prohibitions matter more than long background prose.',
    ].join('\n'),
    continue: '/she continue <Topic> <request> — append a serial task to an existing Topic.',
    list: '/she list — show all Topics/Tasks. /she list <Topic> — show one Topic.',
    status: '/she status <Topic|Task> — query state; running tasks are polled once.',
    report: '/she report <Task> — validate and return the report file; group chats still require file approval.',
    return: '/she return <Task> — copy a task result into <project>/she_returns/<task-id>/ (REPORT, patch, changed/new files, outputs, manifest) without modifying project source.',
    accept: '/she accept <Task> — git apply --check, apply the return bundle, copy new files, and stage only affected project paths; never commit/push.',
    stop: '/she stop <Task> — interrupt the running task and pause its Topic.',
    resume: '/she resume <Topic> — resume a paused Topic queue.',
    rename: '/she topic rename <old> <new> [--force] — rename a Topic label.',
    remove: '/she topic remove <Topic> [--purge] — archive/hide; --purge removes worktree and DB rows.',
  }
  return map[topic] ?? `Unknown SHE help topic: ${topic}\nSend /she help for the command list.`
}

const zhCN: Strings = {
  thinking: '正在处理…',
  processHeader: '执行过程',
  toolCallLine: toolName => `调用工具 ${toolName}`,
  toolCallCountLine: (toolName, count) => `调用工具 ${toolName} × ${count} 次`,
  toolCallSummary: parts => parts.join('、'),
  streamInitial: '💭 正在思考…',
  processLine: (step, elapsedSeconds, tools) =>
    `💭 思考中${step > 0 ? ` · 第 ${step} 步` : ''} · 已 ${elapsedSeconds}s${tools === '' ? '' : ` · 工具 ${tools}`}`,
  toolCountCompact: (toolName, count) => `${toolName} × ${count}`,
  reasoningOnlyLine: (chars, elapsedSeconds, tools) =>
    `💭 本轮只有思考：${chars} 字 · ${elapsedSeconds}s${tools === '' ? '' : ` · 工具 ${tools}`}`,
  reasoningPanelTitleLive: (chars, elapsedSeconds) => `💭 思考中 · ${chars} 字 · ${elapsedSeconds}s`,
  reasoningPanelTitleDone: (chars, elapsedSeconds) => `💭 思考过程（${chars} 字 · ${elapsedSeconds}s）`,
  reasoningOmitted: chars => `……（已省略 ${chars} 字）……`,
  cardOverflowNextPageNote: '▸ 接下页……',
  usageSummary: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Token：输入 ${input} · 输出 ${output}${cacheRead === undefined ? '' : ` · 缓存读 ${cacheRead}`}${cacheWrite === undefined ? '' : ` · 缓存写 ${cacheWrite}`}${reasoning === undefined ? '' : ` · 推理 ${reasoning}`}`,
  approvalTitle: '⚠️ 需要确认操作',
  approvalReasonLabel: '原因',
  approveButton: '✅ 允许',
  denyButton: '❌ 拒绝',
  approvalApprovedBy: name => `已由 ${name} 允许`,
  approvalDeniedBy: name => `已由 ${name} 拒绝`,
  approvalTimedOut: '超时未确认，已按拒绝处理',
  approvalWrongChat: '此卡片仅可在原会话中操作',
  questionTitle: '💬 需要你的回答',
  questionSubmit: '提交',
  questionSelectPlaceholder: '请选择（也可在下方填写其他答案）',
  questionCustomPlaceholder: '其他答案（可留空）',
  questionNoOptionsHint: '_本题可直接在下方输入回答_',
  questionAnsweredBy: name => `已由 ${name} 回答`,
  questionTimedOut: '未在规定时间内作答，提问已超时',
  fileReceivedNote: (path, size) => `[已收到文件 ${path}（${size}），可用工具读取]`,
  imageReceivedNote: '[已收到图片，但当前未开启视觉能力，未交给模型]',
  unsupportedMediaNote: kind => `[收到暂不支持处理的消息类型：${kind}]`,
  mediaTotalTooLargeNote: limit => `[本次消息附件总大小超过限制：${limit}，已跳过后续附件]`,
  helpTitle: '可用命令',
  helpChannelHeader: 'feishu4dsh 频道命令',
  helpHostHeader: 'dsh 宿主命令',
  helpUnavailableHeader: '当前模式未提供',
  helpUnavailableCommand: (command, preset) =>
    `${command} — ${preset} 模式未提供（用 /mode standard 切换后可用）`,
  commandUnavailable: (command, preset) =>
    `${command} 在 ${preset} 模式下不可用：该模式不做上下文压缩（以最省 token 为设计目标）。` +
    '用 /mode standard 切换后可用（会开启新会话）。',
  contextLimitHint: '上下文已接近上限：用 /compact 打包压缩本会话历史（标准模式组合），或用 /new 开新会话。',
  queuedInputsDropped: count => `排队中的 ${count} 条消息已被终止未能执行（会话该轮已停止）。重新发送即可继续。`,
  compactHelpLine: '/compact [N] [问题] — 压缩上下文：旧历史总结为摘要文件（.feishu4dsh/compact/）并开启新会话；N=最近 N 轮原文随行；问题=新会话首问',
  compactInstruction:
    '请把本次会话（截至当前）压缩为一份交接摘要，供开启新会话时无缝继续。要求：' +
    '①用 Markdown；②分节【背景与目标】【已完成与结论】【关键决定与口径】【未决事项与下一步】【重要文件/路径/命令】；' +
    '③只写事实与结论，不写寒暄，不复述原文；④直接输出摘要本身，不要调用工具，不要额外说明；⑤第一行必须是 `# ` 开头的一级标题，标题之前不得有任何文字（包括思考或说明）。',
  compactBusy: '当前会话正忙（压缩进行中或上一轮未结束），稍候再试 /compact。',
  compactNoSession: '当前没有可压缩的会话。',
  compactFailed: detail => `压缩失败，本会话原样保留（可重试）：${detail}`,
  compactTimedOut: '摘要生成超时',
  compactEmptySummary: '模型未返回摘要内容',
  compactDone: (path, held) => `已压缩并开启新会话。摘要文件：${path}${held === '' ? '' : `；挂起消息已转发 ${held} 条`}`,
  compactHolding: '正在压缩上下文，这条消息已挂起，将在新会话开始后自动发出。',
  compactCanceled: '压缩已被取消。',
  compactHeldDropped: count => `会话已重置，压缩期间挂起的 ${count} 条消息未执行——请重新发送。`,
  compactAttachmentHolding: '正在压缩上下文，暂不受理附件——请稍后重发这条带附件的消息。',
  compactOpenerHeader: '[feishu4dsh /compact] 上一会话已压缩归档，以下为交接材料。请据此继续工作。',
  compactOpenerSummaryHeader: '## 上一会话摘要',
  compactOpenerTailHeader: count => `## 最近 ${count} 轮对话原文`,
  compactTailTruncated: '（……超出预算已截断，全文见摘要文件与会话存档）',
  compactOpenerQuestionHeader: '## 新问题',
  compactTailUser: '用户',
  compactTailAssistant: '助手',
  helpChannelTag: '频道',
  helpHostTag: 'dsh',
  channelCommands: [
    '/help — 查看命令列表',
    '/new — 开启新会话（清空上下文）',
    '/mode — 查看/设置会话模式（standard/minimal，设置后开启新会话）',
    '/reasoning — 查看/设置思考内容显示（on/off，本会话生效）',
    '/session — 会话列表 / 切换 / 重命名 / 归档（/session 查看用法）',
    '/stop — 停止当前任务',
    '/status — 会话 / 工作区 / 模式 / 模型 / 推理强度 / 轮次与 Token 累计',
    '/ws — 列出可用工作区',
    '/ws add <路径> — 添加一个可用工作区（手机上添加）',
    '/ws remove <名称或路径> — 移除一个已添加的工作区',
    '/cd <名称或路径> — 切换当前会话的工作区',
    '/model <provider>/<model> — 切换当前会话模型（/model effort 设置推理强度）',
    '/she — 秘书任务：提交给 OpenCode 异步执行、查看状态与报告（/she help 查看子命令）',
  ],
  statusTitle: '会话状态',
  statusSession: id => `会话：${id}`,
  statusScope: scope => `会话粒度：${scope}`,
  scopeLabel: scope => scope === 'chat'
    ? '整个聊天（chat）'
    : scope === 'chat-thread'
      ? '按话题（chat-thread）'
      : scope === 'chat-sender'
        ? '按发送人（chat-sender）'
        : scope,
  statusWorkspace: (name, path) => `工作区：${name}\n  路径：${path}`,
  statusModel: model => `模型：${model}`,
  statusPreset: preset => `模式：${preset}`,
  statusEffort: (effort, source) => `推理强度：${effort}${source}`,
  statusTurns: (turns, steps) => `轮次：${turns} · 步：${steps}`,
  statusTokens: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Token 累计：输入 ${input} · 输出 ${output}${cacheRead === undefined ? '' : ` · 缓存读 ${cacheRead}`}${cacheWrite === undefined ? '' : ` · 缓存写 ${cacheWrite}`}${reasoning === undefined ? '' : ` · 推理 ${reasoning}`}`,
  statusTokensUnavailable: 'Token 累计：—',
  effortSourceMeasured: '（会话实测）',
  statusStatsUnavailable: '—',
  modelTitle: '模型',
  modelSourceSession: '',
  modelDefaultNotStarted: '（默认，尚未开始对话）',
  modelSwitched: (provider, model) => `已切换当前会话模型为 ${provider}/${model}，将在下一轮对话生效。`,
  modelSaveDefaultDone: (provider, model) => `已把部署默认模型保存为 ${provider}/${model}。`,
  modelSaveDefaultUnsupported: '当前部署不支持保存默认模型（缺少 agentDefaultModel.saveSelection 服务）。',
  modelUnsupported: '当前部署不支持切换模型（缺少 installModelSelection 服务）。',
  modelUnknown: '暂无已知模型（部署未声明默认模型，会话也尚未开始对话）。',
  modelNoPermission: '当前发送者无权切换模型（需为配置的审批人/授权用户）。',
  modelUsage: '用法：/model（查看当前模型） · /model <provider>/<model>（切换会话模型） · /model default（写入部署默认）',
  modelEffortLine: (effort, source) => `推理强度：${effort}${source}`,
  effortSourcePreferred: '（模型偏好）',
  effortUnknown: '尚未确定模型：先发起一轮对话，或用 /model <provider>/<model> 指定。',
  effortUsage: '用法：/model effort（查看） · /model effort <default|low|high|max 或宿主支持的档位>（设置当前模型的推理强度，下一轮生效；按 provider/model 持久化） · /model effort default（恢复默认）',
  effortSet: (level, model) => `已将 ${model} 的推理强度设为 ${level}，下一轮生效（按 provider/model 精确记住）。`,
  effortCleared: model => `已恢复 ${model} 的推理强度为默认（请求不再携带 reasoning_effort 参数；按 provider/model 精确记住）。`,
  effortSupportedLine: supported => `宿主支持档位：${supported}`,
  effortMeasuredUnavailable: '最近请求：不可用（宿主不提供 requestHeader）',
  effortMeasuredNone: '最近请求：尚无记录',
  effortMeasuredAbsent: '最近请求：未携带 reasoning_effort',
  effortMeasuredValue: level => `最近请求：${level}（请求头实测）`,
  effortPersistenceWarning: '⚠️ 持久化不可用：本设置仅在当前进程内生效，重启后会丢失。',
  // R39: the capability truth comes from the host llm service; `supported`
  // arrives pre-joined as "low / medium / xhigh"-style.
  effortUnsupported: (level, model, supported) =>
    `不支持 ${level}：${model} 支持的档位是 ${supported}。`,
  effortUnsupportedNoCapability: model =>
    `该模型不支持推理强度设置（无 reasoning 能力）：${model}。`,
  modeTitle: '会话模式',
  modeCurrent: preset => `当前会话模式：${preset}`,
  modeNotStarted: '当前会话尚未开启（下次新会话将使用下方模式）',
  modeNext: preset => `下次新会话模式：${preset}`,
  modeDefaultLine: preset => `部署默认：${preset}`,
  modeSwitched: preset => `已切换到 ${preset} 模式，并已开启新会话`,
  modeAlready: preset => `已是 ${preset} 模式；如需重开会话请用 /new`,
  modeUsage: '用法：/mode 查看 · /mode <standard|minimal> 设置（设置后开启新会话）',
  modeNoPermission: '无权切换会话模式',
  reasoningTitle: '思考内容显示',
  reasoningCurrent: (state, source) => `当前会话：${state}（来源：${source}）`,
  reasoningDefaultLine: state => `部署默认：${state}`,
  reasoningSwitched: state => `已设置为：${state}（下一轮生效）`,
  reasoningAlready: state => `已经是：${state}`,
  reasoningUsage: '用法：/reasoning 查看 · /reasoning <on|off> 设置思考内容显示（私聊展开/群聊折叠）。',
  reasoningNoPermission: '无权设置思考内容显示',
  reasoningShown: '显示',
  reasoningHidden: '隐藏',
  reasoningSourceScope: '本会话设置',
  reasoningSourceConfig: '部署配置',
  sessionTitle: '会话列表',
  sessionListEmpty: '当前话题 × 工作区还没有已登记的会话——发送任意一条普通消息，当前会话即自动登记。',
  sessionArchivedTag: ' [已归档]',
  sessionUsage: '用法：/session 列表 · /session all 含已归档 · /session <序号> 切换 · /session rename <标题> · /session archive <序号> · /session archive old [天数，默认2]',
  sessionSwitched: title => `已停止当前任务，并切换到「${title}」`,
  sessionAlreadyCurrent: title => `「${title}」已是当前会话`,
  sessionUnknown: n => `列表中没有第 ${n} 个会话（/session 查看编号）`,
  sessionRenamed: title => `当前会话已重命名为「${title}」`,
  sessionRenameUsage: '用法：/session rename <新标题>',
  sessionNothingToRename: '当前会话尚未登记（先发一条消息），无标题可改。',
  sessionNoPermission: '无权切换/重命名/归档会话',
  sessionArchiveUnsupported: '当前部署不支持会话归档（宿主缺 workspaceRegistry.archiveSession）。',
  sessionArchiveUnavailable: detail => `读取宿主归档集合失败：${detail}（未按「不支持」静默降级，请查日志）`,
  sessionArchiveUsage: '用法：/session archive <序号> · /session archive old [天数，默认2]',
  sessionArchivedOne: title => `已归档「${title}」`,
  sessionArchivedMany: (count, titles) => `已归档 ${count} 个陈旧会话：${titles}`,
  sessionArchivedAlready: title => `「${title}」已在归档中`,
  sessionArchiveNone: days => `没有超过 ${days} 天未更新的未归档会话。`,
  sessionArchiveFailed: detail => `归档失败：${detail}`,
  sessionArchiveForeign: '仅可归档飞书端创建的会话（dsh web 端会话请在 web 管理）。',
  sessionAutoHealed: (oldId, newId) =>
    `⚠️ 旧会话 ${oldId} 无法恢复，已自动开启新会话 ${newId}。\n旧会话记录仍保留，可用 /session 查看；本条及后续消息将在新会话中正常处理。`,
  wsTitle: '可用工作区',
  wsEmpty: '当前没有可用的工作区。',
  wsCurrentTag: '当前',
  wsDefaultTag: '默认',
  cdUsage: '用法：/cd <工作区名称或路径>（/ws 查看可用工作区）',
  cdSwitched: (name, path) => `已切换工作区到「${name}」（${path}）。后续消息将在新工作区中继续。`,
  cdNotFound: target => `找不到工作区「${target}」（目录不存在？）`,
  cdNotAllowed: target => `「${target}」不在允许的工作区范围内。可用 /ws add <路径> 添加，或在配置 workspaceRoots 中添加允许的目录。`,
  cdAmbiguous: (target, names) => `「${target}」对应多个工作区，请改用完整路径：${names}`,
  cdNoPermission: '当前发送者无权切换工作区（需为配置的审批人/授权用户）。',
  wsUsage: '用法：/ws（点选进入） · /ws list（文本列表） · /ws new（新建工作区） · /ws add <路径> · /ws remove <名称或路径>',
  wsAddUsage: '用法：/ws add <工作区目录的绝对路径>',
  wsRemoveUsage: '用法：/ws remove <工作区名称或路径>',
  wsNoPermission: '当前发送者无权管理工作区（需为配置的审批人/授权用户）。',
  wsAdded: (name, path) => `已添加工作区「${name}」（${path}）。可用 /cd ${name} 切换过去。`,
  wsRemoved: (name, path) => `已移除工作区「${name}」（${path}）。`,
  wsNotUserAdded: target => `「${target}」不是通过 /ws add 添加的，无法移除（默认/宿主注册的工作区不可移除）。`,
  wsNotDirectory: target => `「${target}」不是一个已存在的目录，无法添加为工作区。`,
  newSessionDone: '已开启新会话，上下文已清空。',
  stopped: '已停止当前任务。',
  nothingToStop: '当前没有进行中的任务。',
  turnFailed: detail => `本轮执行失败：${detail}`,
  sendFileApprovalTitle: '📎 发送文件确认',
  sendFileApprovalDetail: (path, wsName, size) => `Agent 请求发送文件\n位置：${wsName} 内 ${path}\n大小：${size}`,
  outsideWorkspaceRefusal: 'The path is outside the workspace; only files inside it can be sent.',
  fileNotFoundRefusal: 'No such file in the workspace.',
  notAFileRefusal: 'That path is not a regular file.',
  tooLargeRefusal: (size, limit) => `The file is ${size}, over the ${limit} limit.`,
  commandUnknown: line => `未知命令：${line}（/help 查看可用命令）`,
  wsMenuTitle: '🗂 工作区（点选进入）',
  wsMenuEmpty: '当前没有已注册的工作区（默认工作区除外）。用 /ws new 或 /ws add 添加。',
  wsMenuNote: '点击即切换 · /ws list 文本列表 · /ws new 新建',
  modelMenuTitle: '🧠 模型（点选切换）',
  modelMenuPlaceholder: '请选择模型…',
  modelMenuExpiredNote: '点击即切换会话模型（下一轮生效）',
  menuPrevLabel: '‹ 上一页',
  menuNextLabel: '下一页 ›',
  menuPageOf: (page, total) => `${page} / ${total} 页`,
  menuExpired: '该菜单已失效，请重新发送对应命令打开。',
  menuGone: '这张卡片已失效，请重新执行对应命令获取新卡片。',
  menuWrongChat: '此菜单仅可在原会话中操作',
  menuWsSettledTitle: '✅ 已切换工作区',
  menuModelSettledTitle: '✅ 已切换模型',
  menuSessionSettledTitle: '✅ 已切回会话',
  menuBrowseSettledTitle: '✅ 已选定工作区',
  sessionMenuTitle: '💬 会话（点选切回）',
  sessionMenuNote: '点击即切回该会话；进行中的任务会先停止',
  browseNoRoots: '未配置 workspaceRoots，无法浏览目录建工作区；请在部署配置中添加（示例：workspaceRoots: [你的项目根目录]），或改用 /ws add <路径>。',
  browseEmpty: '（此目录下没有子文件夹）',
  browseConfirm: '✅ 就用这个目录',
  browseParent: '⬆️ 上一级',
  browseNote: '输入 /ws new <名称>：在当前浏览位置新建文件夹并进入',
  wsMkdirDone: (name, path) => `已创建工作区「${name}」（${path}），并切换过去。`,
  wsMkdirInvalid: name => `无法创建「${name}」：名称不能包含路径分隔符或为空。`,
  wsMkdirUsage: '用法：/ws new（浏览并选择目录） · /ws new <名称>（在当前浏览位置新建文件夹）',
  modelCatalogHint: '💡 未配置 modelCatalog：在部署配置中添加后即可点选切换（每项 provider/model）。',
  modelAddDelUsage: '用法：/model add <provider>/<model> · /model del|remove <provider>/<model>（增删点选清单，删除即时持久化）',
  modelAdded: entry => `已将 ${entry} 加入点选清单。`,
  modelAddExists: entry => `${entry} 已在点选清单中。`,
  modelCatalogFull: cap => `点选清单已满（${cap} 条）；请先 /model del 腾出位置。`,
  modelDelMissing: entry => `${entry} 不在点选清单中。`,
  modelDeleted: entry => `已将 ${entry} 移出点选清单。`,
  modelRemoveLast: '至少保留 1 条点选清单项。',
  modelAddCurButton: '➕ 把当前模型加入清单',
  sheUsage: [
    '用法：',
    '/she help [命令] — 查看全局或子命令帮助',
    '/she init — 初始化共享 shadow repo、SHE runtime 与状态文件',
    '/she init update — 更新当前 scope 的 shadow repo',
    '/she init reset — 清除当前 scope 的 shadow repo 映射',
    '/she need — 兼容入口，等同 /she sandbox status',
    '/she sandbox [status|build] — 交互式生成 agent sandbox 安装包（无密钥）',
    '/she doctor — 查看 SHE/OpenCode/共享目录诊断',
    '/she submit <原文> — 新建 Topic 并提交任务',
    '/she continue <Topic> <原文> — 在同一 Topic 追加串行任务',
    '/she list [Topic] — 查看 Topic / Task 看板',
    '/she status <Topic|Task> — 查询状态',
    '/she report <Task> — 回传报告文件',
    '/she return <Task> — 复制结果到 she_returns/<task-id>/（不修改源码）',
    '/she accept <Task> — 应用结果到项目并 stage（默认不 commit）',
    '/she stop <Task> — 中断当前任务并暂停 Topic',
    '/she resume <Topic> — 恢复 Topic 队列',
    '/she topic rename <旧编号> <新编号> [--force] — 重命名 Topic',
    '/she topic remove <Topic> [--purge] — 移除 Topic',
  ].join('\n'),
  sheHelpTopic: sheHelpZh,
  sheDisabled: '秘书功能未启用：管理员发送 /she init 完成初始化，或在插件配置中设置 secretaryEnabled: true。',
  sheInitUnavailable: '当前运行环境不支持 /she init（未安装 R58 初始化控制器）。',
  sheNeedTitle: 'SHE sandbox 就绪检查',
  sheNeedItem: (status, label, detail) => `${status} ${label}：${detail}`,
  sheNeedReady: 'she-sandbox 已就绪。下一步可执行 /she init。',
  sheNeedNext: '存在缺失项：请执行 /she sandbox status 查看主机/接入缺口，并用 /she sandbox build 生成安装包。',
  sheSandboxStatusTitle: 'Sandbox 执行面预检',
  sheSandboxReady: '当前用户 Docker 可用；可继续选择沙箱配置。',
  sheSandboxNotReady: '当前用户 Docker 不可用或未确认 rootless：建议选择专用 rootless 账户并生成 root bootstrap 包。',
  sheSandboxWizardTitle: step => ({ target: 'Sandbox · 选择目标账户', agent: 'Sandbox · 选择 Agent', tools: 'Sandbox · 选择基础工具', confirm: 'Sandbox · 确认生成' } as Record<string, string>)[step] ?? 'Sandbox 构建',
  sheSandboxWizardSummary: (name, target, agent, tools, network) => `名称：\`${name}\`\n目标：${target}\nAgent：${agent}\n工具：${tools}\n网络：${network}`,
  sheSandboxTargetNote: '推荐专用 rootless 账户。当前用户模式只在本机 Docker 可达且可接受同账户风险时使用；本版不枚举任意系统用户。',
  sheSandboxAgentNote: '内置 OpenCode 使用固定版本；Hermes/dsh 需显式镜像，不会猜测官方镜像名；镜像存在不等于协议兼容。',
  sheSandboxToolsNote: '工具包可多选；用户态工具装到 /home/agent，系统包写入镜像。Docker CLI 与 socket 永不安装/挂载。',
  sheSandboxConfirmNote: '点击生成后只产出无密钥安装包，不执行 sudo、不创建容器；请由目标用户在飞书外审查执行。',
  sheSandboxBack: '⬅️ 上一步',
  sheSandboxNext: '下一步 ➡️',
  sheSandboxBuild: '📦 生成安装包',
  sheSandboxCancel: '取消',
  sheSandboxToolLabel: (label, selected) => `${selected ? '✅' : '⬜'} ${label}`,
  sheSandboxImageRequired: label => `${label} 需要显式镜像引用。请发送：/she sandbox build --agent custom --image <镜像>；本版不会猜测或静默回退为空白沙箱。`,
  sheSandboxTargetUnavailable: '当前用户 Docker 预检未通过，暂不能选择 current-user；可改用专用 rootless 账户生成 root bootstrap 包。',
  sheSandboxTargetWarning: '当前用户 Docker 预检未完全通过；仍可生成安装包，但请在目标用户侧执行 host-preflight.sh 复核。',
  sheSandboxCardUpdateFailed: '卡片状态更新失败。当前步骤已切换，但飞书卡片可能未刷新；请重新发送 /she sandbox，或查看服务日志。',
  sheSandboxPackageDone: (name, archivePath) => `已生成 sandbox 安装包：${name}\n归档：${archivePath}`,
  sheSandboxUsageGuide: (name, requiresRootBootstrap, targetUser) => {
    const steps = [
      '下载并解压 tar.gz，进入解压目录，执行 chmod +x *.sh',
      './host-preflight.sh',
      'sha256sum -c CHECKSUMS',
      ...(requiresRootBootstrap
        ? [
            'sudo ./bootstrap-host.sh --dry-run',
            'sudo ./bootstrap-host.sh',
            `切换到目标用户 ${targetUser}，在包目录执行 ./create-sandbox.sh`,
          ]
        : ['./create-sandbox.sh']),
      './verify-sandbox.sh，确认输出 SANDBOX_VERIFY_OK',
      '不再需要时执行 ./destroy-sandbox.sh；数据默认保留，--purge 才删除',
    ]
    return [
      `安装包 ${name} 已发送，但尚未创建容器。`,
      '',
      '操作步骤：',
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      '注意：SHE 不会自动执行 sudo、Docker 创建或容器操作，请先审查 plan.json、Dockerfile 与脚本。',
    ].join('\n')
  },
  sheSandboxUnavailable: '当前运行环境不支持 build-sandbox（未装配 sandbox hook）。',
  sheNeedAliasHint: '兼容入口：/she need 已并入 /she sandbox status；后续请优先使用 /she sandbox。',
  sheNeedPackageDeprecated: '/she need package 已并入 /she sandbox；本次按默认 OpenCode 方案继续生成。后续请使用 /she sandbox build。',
  sheInitOk: (shadowRepo, runtimeRoot, version) => `SHE 初始化完成（OpenCode ${version}）。\nShadow repo：${shadowRepo}\nRuntime：${runtimeRoot}\n下一步直接 /she submit。`,
  sheInitUpdateOk: (shadowRepo, head) => `Shadow repo 已更新：${shadowRepo}\nHEAD：${head}`,
  sheInitResetOk: shadowRepo => `已清除当前 scope 的 shadow repo 映射（目录保留）：${shadowRepo}\n现在可以重新执行 /she init。`,
  sheReturned: (label, returnDir, changed, added, outputs) => `任务 ${label} 的结果已复制到：${returnDir}\n修改文件 ${changed}，新增文件 ${added}，输出 ${outputs}。尚未修改项目源码或执行 git add。`,
  sheAccepted: (label, staged, copied, appliedPatch) => `任务 ${label} 已接受：${appliedPatch ? '补丁已应用' : '无补丁'}，复制新增文件 ${copied}，已 stage ${staged} 个路径。未 commit/push。`,
  sheDoctorTitle: 'SHE 诊断',
  sheDoctorSource: (source, stateFile, statePresent) => `来源：${source}；状态文件：${stateFile}（${statePresent}）`,
  sheDoctorHealth: (ok, detail) => `OpenCode：${ok ? 'healthy' : 'unhealthy'}${detail === '' ? '' : `（${detail}）`}`,
  sheDoctorRuntime: (runtimeRoot, worktreeRoot, reposRoot) => `Runtime：${runtimeRoot}\nWorktree：${worktreeRoot}\nRepos：${reposRoot}`,
  sheDoctorScope: shadowRepo => `当前话题 shadow repo：${shadowRepo ?? '未映射'}`,
  sheNoPermission: '当前发送人无权使用 /she（需为审批人 / 会话驱动者）。',
  sheSubmitted: (label, status) => `已提交任务 ${label}（${status}）。完成后用 /she status ${label} 查看。`,
  sheContinued: (label, status) => `已追加任务 ${label}（${status}）。`,
  sheInvalid: reason => `命令参数无效（${reason}）；发送 /she help 查看用法。`,
  sheListEmpty: '当前聊天还没有 Topic。用 /she submit <原文> 创建第一个。',
  sheTopicListLine: (label, status, excerpt, summary) => `${label}  [${status}]  ${excerpt}  ${summary}`,
  sheTaskListLine: (label, status, excerpt) => `${label}  [${status}]  ${excerpt}`,
  sheTaskSummary: (total, running, queued, done) => `共 ${total} 个任务：运行中 ${running}，排队 ${queued}，已完成 ${done}`,
  sheStatusTitle: '秘书任务状态',
  sheStatusTopic: (label, status, excerpt) => `Topic ${label} · ${status} · ${excerpt}`,
  sheStatusTask: (label, status, excerpt) => `Task ${label} · ${status} · ${excerpt}`,
  sheStatusSession: sessionId => `OpenCode session：${sessionId}`,
  sheStatusReport: path => `报告：${path}`,
  sheStatusAttachments: count => `附件：${count} 个`,
  sheNotFound: reference => `未找到 ${reference}。`,
  sheReportMissing: label => `任务 ${label} 尚无已登记报告（可能仍在运行或报告缺失）。`,
  sheReportReady: (label, size) => `任务 ${label} 的报告（${size}）：`,
  sheStopped: label => `已中断 ${label}，所属 Topic 已暂停。`,
  sheResumed: label => `已恢复 Topic ${label} 的队列。`,
  sheRenamed: (oldLabel, newLabel) => `Topic 编号已由 ${oldLabel} 改为 ${newLabel}。`,
  sheRemoved: (label, purged) => purged ? `Topic ${label} 已彻底删除。` : `Topic ${label} 已归档并从看板隐藏；产物保留。`,
  sheError: (code, detail) => `秘书命令失败（${code}）：${detail}`,
}

const enUS: Strings = {
  thinking: 'Working…',
  processHeader: 'Process',
  toolCallLine: toolName => `calling ${toolName}`,
  toolCallCountLine: (toolName, count) => `calling ${toolName} × ${count}`,
  toolCallSummary: parts => parts.join(', '),
  streamInitial: '💭 Thinking…',
  processLine: (step, elapsedSeconds, tools) =>
    `💭 Thinking${step > 0 ? ` · step ${step}` : ''} · ${elapsedSeconds}s${tools === '' ? '' : ` · tools ${tools}`}`,
  toolCountCompact: (toolName, count) => `${toolName} × ${count}`,
  reasoningOnlyLine: (chars, elapsedSeconds, tools) =>
    `💭 Reasoning only this turn: ${chars} chars · ${elapsedSeconds}s${tools === '' ? '' : ` · tools ${tools}`}`,
  reasoningPanelTitleLive: (chars, elapsedSeconds) => `💭 Thinking · ${chars} chars · ${elapsedSeconds}s`,
  reasoningPanelTitleDone: (chars, elapsedSeconds) => `💭 Reasoning (${chars} chars · ${elapsedSeconds}s)`,
  reasoningOmitted: chars => `…… (${chars} chars omitted) ……`,
  cardOverflowNextPageNote: '▸ continued on the next card…',
  usageSummary: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Tokens: ${input} in · ${output} out${cacheRead === undefined ? '' : ` · cache read ${cacheRead}`}${cacheWrite === undefined ? '' : ` · cache write ${cacheWrite}`}${reasoning === undefined ? '' : ` · reasoning ${reasoning}`}`,
  approvalTitle: '⚠️ Approval required',
  approvalReasonLabel: 'Reason',
  approveButton: '✅ Allow',
  denyButton: '❌ Deny',
  approvalApprovedBy: name => `Allowed by ${name}`,
  approvalDeniedBy: name => `Denied by ${name}`,
  approvalTimedOut: 'No response in time; treated as denied',
  approvalWrongChat: 'This card only works in its original chat',
  questionTitle: '💬 Your answer is needed',
  questionSubmit: 'Submit',
  questionSelectPlaceholder: 'Pick one (or type another answer below)',
  questionCustomPlaceholder: 'Other answer (optional)',
  questionNoOptionsHint: '_Answer this one in the field below_',
  questionAnsweredBy: name => `Answered by ${name}`,
  questionTimedOut: 'No answer in time; the question expired',
  fileReceivedNote: (path, size) => `[received file ${path} (${size}); read it with your tools]`,
  imageReceivedNote: '[received an image, but vision is disabled; not passed to the model]',
  unsupportedMediaNote: kind => `[received an unsupported message type: ${kind}]`,
  mediaTotalTooLargeNote: limit => `[total attachments for this message exceed the limit: ${limit}; skipped the rest]`,
  helpTitle: 'Commands',
  helpChannelHeader: 'feishu4dsh channel commands',
  helpHostHeader: 'dsh host commands',
  helpUnavailableHeader: 'Not provided by the current mode',
  helpUnavailableCommand: (command, preset) =>
    `${command} — not provided by the ${preset} mode (switch with /mode standard)`,
  commandUnavailable: (command, preset) =>
    `${command} is unavailable in the ${preset} mode: that mode performs no context compaction ` +
    '(it targets the cheapest possible turn). Switch with /mode standard (opens a new session).',
  contextLimitHint: 'Context is near its limit: use /compact (compacts this session history; standard-mode combo) or /new (fresh session, always available).',
  queuedInputsDropped: count => `${count} queued message(s) were dropped before running (that turn was stopped). Send them again to continue.`,
  compactHelpLine: '/compact [N] [question] — compact the context: older history is summarized into a file (.feishu4dsh/compact/) and a fresh session opens; N keeps the last N turns verbatim; question becomes the first ask of the new session',
  compactInstruction:
    'Condense this conversation (up to now) into a handover summary so a fresh session can continue seamlessly. ' +
    'Requirements: 1) Markdown; 2) sections 【Background & goal】【Done & conclusions】【Key decisions】【Open items & next steps】【Important files/paths/commands】; ' +
    '3) facts and conclusions only — no pleasantries, no verbatim retelling; 4) output the summary itself only: no tool calls, no extra commentary; 5) the FIRST line must be a top-level "# " heading with nothing before it (no thinking, no preamble).',
  compactBusy: 'This session is busy (a compaction is running or the previous turn has not ended); retry /compact shortly.',
  compactNoSession: 'There is no live session to compact.',
  compactFailed: detail => `Compaction failed; this session is preserved as-is (retry anytime): ${detail}`,
  compactTimedOut: 'summary generation timed out',
  compactEmptySummary: 'the model returned no summary text',
  compactDone: (path, held) => `Compacted and opened a fresh session. Summary file: ${path}${held === '' ? '' : `; ${held} held message(s) forwarded`}`,
  compactHolding: 'Compacting the context; this message is held and will be sent automatically once the new session starts.',
  compactCanceled: 'The compaction was canceled.',
  compactHeldDropped: count => `The session was reset; ${count} message(s) held during the compaction were not executed — please send them again.`,
  compactAttachmentHolding: 'A compaction is running; attachments are not accepted right now — please resend this message with attachments afterwards.',
  compactOpenerHeader: '[feishu4dsh /compact] The previous session was compacted and archived; the handover material follows. Continue from here.',
  compactOpenerSummaryHeader: '## Previous session summary',
  compactOpenerTailHeader: count => `## Last ${count} turn(s), verbatim`,
  compactTailTruncated: '(……truncated over budget; full text lives in the summary file and the archived session)',
  compactOpenerQuestionHeader: '## New question',
  compactTailUser: 'User',
  compactTailAssistant: 'Assistant',
  helpChannelTag: 'channel',
  helpHostTag: 'dsh',
  channelCommands: [
    '/help — list commands',
    '/new — start a fresh session (clears context)',
    '/stop — stop the current task',
    '/status — session / workspace / mode / model / reasoning effort / token totals',
    '/ws — list available workspaces',
    '/ws add <path> — add a workspace (from your phone)',
    '/ws remove <name or path> — remove an added workspace',
    '/cd <name or path> — switch the current workspace',
    '/mode — view/set the session mode (standard/minimal; opens a new session)',
    '/reasoning — view/set reasoning display (on/off, this chat)',
    '/model <provider>/<model> — switch the session model',
  ],
  statusTitle: 'Session status',
  statusSession: id => `Session: ${id}`,
  statusScope: scope => `Scope: ${scope}`,
  scopeLabel: scope => scope === 'chat'
    ? 'whole chat (chat)'
    : scope === 'chat-thread'
      ? 'per topic (chat-thread)'
      : scope === 'chat-sender'
        ? 'per sender (chat-sender)'
        : scope,
  statusWorkspace: (name, path) => `Workspace: ${name}\n  Path: ${path}`,
  statusModel: model => `Model: ${model}`,
  statusPreset: preset => `Mode: ${preset}`,
  statusEffort: (effort, source) => `Reasoning effort: ${effort}${source}`,
  statusTurns: (turns, steps) => `Turns: ${turns} · Steps: ${steps}`,
  statusTokens: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Tokens (session): ${input} in · ${output} out${cacheRead === undefined ? '' : ` · cache read ${cacheRead}`}${cacheWrite === undefined ? '' : ` · cache write ${cacheWrite}`}${reasoning === undefined ? '' : ` · reasoning ${reasoning}`}`,
  statusTokensUnavailable: 'Tokens (session): —',
  effortSourceMeasured: ' (last request)',
  statusStatsUnavailable: '—',
  modeTitle: 'Session mode',
  modeCurrent: preset => `Current session mode: ${preset}`,
  modeNotStarted: 'No session yet (the next new session will use the mode below)',
  modeNext: preset => `Next new session mode: ${preset}`,
  modeDefaultLine: preset => `Deployment default: ${preset}`,
  modeSwitched: preset => `Switched to ${preset} mode and opened a new session`,
  modeAlready: preset => `Already in ${preset} mode; use /new to re-open the session`,
  modeUsage: 'Usage: /mode to view · /mode <standard|minimal> to set (opens a new session)',
  modeNoPermission: 'Not allowed to switch the session mode',
  reasoningTitle: 'Reasoning display',
  reasoningCurrent: (state, source) => `This chat: ${state} (source: ${source})`,
  reasoningDefaultLine: state => `Deployment default: ${state}`,
  reasoningSwitched: state => `Set to: ${state} (takes effect next turn)`,
  reasoningAlready: state => `Already: ${state}`,
  reasoningUsage: 'Usage: /reasoning to view · /reasoning <on|off> to set reasoning display (expanded in DMs, collapsed in groups).',
  reasoningNoPermission: 'Not allowed to change the reasoning display',
  reasoningShown: 'shown',
  reasoningHidden: 'hidden',
  reasoningSourceScope: 'this chat',
  reasoningSourceConfig: 'deployment config',
  sessionTitle: 'Sessions',
  sessionListEmpty: 'No registered sessions for this topic × workspace yet -- send any regular message and the current session registers itself.',
  sessionArchivedTag: ' [archived]',
  sessionUsage: 'Usage: /session list · /session all includes archived · /session <n> switch · /session rename <title> · /session archive <n> · /session archive old [days, default 2]',
  sessionSwitched: title => `Stopped the running task and switched to "${title}"`,
  sessionAlreadyCurrent: title => `"${title}" is already the current session`,
  sessionUnknown: n => `No session #${n} in the list (see /session)`,
  sessionRenamed: title => `Session renamed to "${title}"`,
  sessionRenameUsage: 'Usage: /session rename <new title>',
  sessionNothingToRename: 'The current session is not registered yet (send a message first).',
  sessionNoPermission: 'Not allowed to switch/rename/archive sessions',
  sessionArchiveUnsupported: 'Archiving is not supported by this deployment (workspaceRegistry.archiveSession missing).',
  sessionArchiveUnavailable: detail => `Reading the host's archive set failed: ${detail} (not silently downgraded to \"unsupported\"; see the log)`,
  sessionArchiveUsage: 'Usage: /session archive <n> · /session archive old [days, default 2]',
  sessionArchivedOne: title => `Archived "${title}"`,
  sessionArchivedMany: (count, titles) => `Archived ${count} stale session(s): ${titles}`,
  sessionArchivedAlready: title => `"${title}" is already archived`,
  sessionArchiveNone: days => `No unarchived sessions older than ${days} day(s).`,
  sessionArchiveFailed: detail => `Archive failed: ${detail}`,
  sessionArchiveForeign: 'Only sessions created on the Feishu side can be archived (manage dsh web sessions there).',
  sessionAutoHealed: (oldId, newId) =>
    `⚠️ The old session ${oldId} could not be resumed; a new session ${newId} was opened automatically.\nThe old records are kept and can be listed via /session; this and future messages run in the new session.`,
  modelTitle: 'Model',
  modelSourceSession: '',
  modelDefaultNotStarted: ' (default; no turn yet)',
  modelSwitched: (provider, model) => `Switched the session model to ${provider}/${model}; takes effect on the next turn.`,
  modelSaveDefaultDone: (provider, model) => `Saved ${provider}/${model} as the deployment default model.`,
  modelSaveDefaultUnsupported: 'This deployment cannot save a default model (agentDefaultModel.saveSelection missing).',
  modelUnsupported: 'This deployment does not support switching models (installModelSelection service missing).',
  modelUnknown: 'No model is known yet (the deployment advertises no default and no turn has run).',
  modelNoPermission: 'This sender may not switch models (must be a configured approver / authorized user).',
  modelUsage: 'Usage: /model (show current) · /model <provider>/<model> (switch this session) · /model default (save as deployment default)',
  modelEffortLine: (effort, source) => `Reasoning effort: ${effort}${source}`,
  effortSourcePreferred: ' (model preference)',
  effortUnknown: 'No model is known yet: run a turn first, or pin one with /model <provider>/<model>.',
  effortUsage: 'Usage: /model effort (view) · /model effort <default|low|high|max or a host-advertised level> (set for the current model; takes effect next turn; persisted per provider/model) · /model effort default (reset)',
  effortSet: (level, model) => `Set ${model} reasoning effort to ${level}; takes effect next turn (remembered per provider/model).`,
  effortCleared: model => `Reset ${model} reasoning effort to default (requests carry no reasoning_effort; remembered per provider/model).`,
  effortSupportedLine: supported => `Host-supported levels: ${supported}`,
  effortMeasuredUnavailable: 'Last request: unavailable (host exposes no requestHeader)',
  effortMeasuredNone: 'Last request: no record yet',
  effortMeasuredAbsent: 'Last request: no reasoning_effort attached',
  effortMeasuredValue: level => `Last request: ${level} (measured from request header)`,
  effortPersistenceWarning: '⚠️ Persistence unavailable: this setting applies only to the current process and will be lost after restart.',
  // R39: capability truth comes from the host llm service.
  effortUnsupported: (level, model, supported) =>
    `Unsupported effort ${level}: ${model} supports ${supported}.`,
  effortUnsupportedNoCapability: model =>
    `This model does not support reasoning effort (no reasoning capability): ${model}.`,
  wsTitle: 'Workspaces',
  wsEmpty: 'No workspaces available.',
  wsCurrentTag: 'current',
  wsDefaultTag: 'default',
  cdUsage: 'Usage: /cd <workspace name or path> (use /ws to list them)',
  cdSwitched: (name, path) => `Switched to workspace "${name}" (${path}). New messages continue there.`,
  cdNotFound: target => `Workspace "${target}" not found (does the directory exist?)`,
  cdNotAllowed: target => `"${target}" is not within the allowed workspaces. Use /ws add <path> to add it, or add its directory to workspaceRoots.`,
  cdAmbiguous: (target, names) => `"${target}" matches several workspaces; use a full path instead: ${names}`,
  cdNoPermission: 'This sender may not switch workspaces (must be a configured approver / authorized user).',
  wsUsage: 'Usage: /ws (list) · /ws add <path> (add) · /ws remove <name or path> (remove)',
  wsAddUsage: 'Usage: /ws add <absolute path to a workspace directory>',
  wsRemoveUsage: 'Usage: /ws remove <workspace name or path>',
  wsNoPermission: 'This sender may not manage workspaces (must be a configured approver / authorized user).',
  wsAdded: (name, path) => `Added workspace "${name}" (${path}). Use /cd ${name} to switch to it.`,
  wsRemoved: (name, path) => `Removed workspace "${name}" (${path}).`,
  wsNotUserAdded: target => `"${target}" was not added via /ws add and cannot be removed (default / host-registered workspaces are protected).`,
  wsNotDirectory: target => `"${target}" is not an existing directory and cannot be added as a workspace.`,
  newSessionDone: 'Started a new session; context cleared.',
  stopped: 'Stopped the current task.',
  nothingToStop: 'Nothing is running right now.',
  turnFailed: detail => `This turn failed: ${detail}`,
  sendFileApprovalTitle: '📎 Send file',
  sendFileApprovalDetail: (path, wsName, size) => `The agent wants to send a file\nAt: ${path} in ${wsName}\nSize: ${size}`,
  outsideWorkspaceRefusal: 'The path is outside the workspace; only files inside it can be sent.',
  fileNotFoundRefusal: 'No such file in the workspace.',
  notAFileRefusal: 'That path is not a regular file.',
  tooLargeRefusal: (size, limit) => `The file is ${size}, over the ${limit} limit.`,
  commandUnknown: line => `Unknown command: ${line} (try /help)`,
  sheUsage: [
    'Usage:',
    '/she help [command] — show global or per-command help',
    '/she init — initialize the shared shadow repo, SHE runtime and state file',
    '/she init update — update the current scope shadow repo',
    '/she init reset — forget the current scope shadow repo mapping',
    '/she need — compatibility alias for /she sandbox status',
    '/she sandbox [status|build] — interactive secret-free agent-sandbox package builder',
    '/she doctor — inspect SHE/OpenCode/shared-directory diagnostics',
    '/she submit <request> — create a Topic and enqueue a task',
    '/she continue <Topic> <request> — append a serial task',
    '/she list [Topic] — show Topics / Tasks',
    '/she status <Topic|Task> — query status',
    '/she report <Task> — return the report file',
    '/she return <Task> — copy results to she_returns/<task-id>/ without touching project source',
    '/she accept <Task> — apply/stage results in the project (no commit)',
    '/she stop <Task> — interrupt the running task and pause its Topic',
    '/she resume <Topic> — resume the Topic queue',
    '/she topic rename <old> <new> [--force] — rename a Topic label',
    '/she topic remove <Topic> [--purge] — archive/remove a Topic',
  ].join('\n'),
  sheHelpTopic: sheHelpEn,
  sheDisabled: 'Secretary is disabled: ask an admin to run /she init, or set secretaryEnabled: true in the plugin config.',
  sheInitUnavailable: 'This runtime does not provide the R58 /she init controller.',
  sheNeedTitle: 'SHE sandbox readiness',
  sheNeedItem: (status, label, detail) => `${status} ${label}: ${detail}`,
  sheNeedReady: 'she-sandbox is ready. Next: /she init.',
  sheNeedNext: 'Missing prerequisites: run /she sandbox status for host/attach gaps, then /she sandbox build for the package.',
  sheSandboxStatusTitle: 'Sandbox execution-plane preflight',
  sheSandboxReady: 'Current-user Docker is reachable; continue with sandbox configuration.',
  sheSandboxNotReady: 'Current-user Docker is unavailable or rootless is unconfirmed: use a dedicated rootless account and review the root bootstrap package.',
  sheSandboxWizardTitle: step => ({ target: 'Sandbox · target account', agent: 'Sandbox · agent', tools: 'Sandbox · tools', confirm: 'Sandbox · confirm' } as Record<string, string>)[step] ?? 'Sandbox builder',
  sheSandboxWizardSummary: (name, target, agent, tools, network) => `Name: \`${name}\`\nTarget: ${target}\nAgent: ${agent}\nTools: ${tools}\nNetwork: ${network}`,
  sheSandboxTargetNote: 'Dedicated rootless account is recommended. Current-user mode is only for an accessible local Docker and accepted same-account risk; arbitrary system users are not enumerated.',
  sheSandboxAgentNote: 'OpenCode is pinned. Hermes/dsh require an explicit image; official image names are not guessed. Image existence does not imply protocol compatibility.',
  sheSandboxToolsNote: 'Select one or more bundles. User tools live under /home/agent; OS packages are baked at image build. Docker CLI/socket are never installed or mounted.',
  sheSandboxConfirmNote: 'Generate only emits a secret-free package: no sudo and no container creation. The target user must review and execute it outside Feishu.',
  sheSandboxBack: '⬅️ Back',
  sheSandboxNext: 'Next ➡️',
  sheSandboxBuild: '📦 Generate package',
  sheSandboxCancel: 'Cancel',
  sheSandboxToolLabel: (label, selected) => `${selected ? '✅' : '⬜'} ${label}`,
  sheSandboxImageRequired: label => `${label} requires an explicit image reference. Send: /she sandbox build --agent custom --image <image>. This version never guesses or silently falls back to a blank sandbox.`,
  sheSandboxTargetUnavailable: 'Current-user Docker preflight failed; current-user cannot be selected. Use a dedicated rootless account to generate the root bootstrap package.',
  sheSandboxTargetWarning: 'Current-user Docker preflight was not fully successful; package generation can continue, but run host-preflight.sh as the target user before creating the sandbox.',
  sheSandboxCardUpdateFailed: 'Could not refresh the card. The wizard state advanced, but the Feishu card may be stale; send /she sandbox again or inspect service logs.',
  sheSandboxPackageDone: (name, archivePath) => `Generated sandbox package: ${name}\nArchive: ${archivePath}`,
  sheSandboxUsageGuide: (name, requiresRootBootstrap, targetUser) => {
    const steps = [
      'Download and extract the tar.gz, then chmod +x *.sh',
      './host-preflight.sh',
      'sha256sum -c CHECKSUMS',
      ...(requiresRootBootstrap
        ? [
            'sudo ./bootstrap-host.sh --dry-run',
            'sudo ./bootstrap-host.sh',
            `Switch to target user ${targetUser} and run ./create-sandbox.sh from the package directory`,
          ]
        : ['./create-sandbox.sh']),
      './verify-sandbox.sh and confirm SANDBOX_VERIFY_OK',
      'When done, run ./destroy-sandbox.sh; data is retained unless --purge is passed',
    ]
    return [
      `Package ${name} has been sent, but no container has been created yet.`,
      '',
      'Next steps:',
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'SHE never runs sudo, container creation, or Docker lifecycle actions automatically. Review plan.json, Dockerfile and scripts first.',
    ].join('\n')
  },
  sheSandboxUnavailable: 'This runtime does not provide the build-sandbox hook.',
  sheNeedAliasHint: 'Compatibility: /she need now maps to /she sandbox status; prefer /she sandbox.',
  sheNeedPackageDeprecated: '/she need package is merged into /she sandbox; generating the default OpenCode package now. Prefer /she sandbox build.',
  sheInitOk: (shadowRepo, runtimeRoot, version) => `SHE initialized (OpenCode ${version}).\nShadow repo: ${shadowRepo}\nRuntime: ${runtimeRoot}\nNext: use /she submit.`,
  sheInitUpdateOk: (shadowRepo, head) => `Shadow repo updated: ${shadowRepo}\nHEAD: ${head}`,
  sheInitResetOk: shadowRepo => `Cleared the current scope's shadow repo mapping (directory retained): ${shadowRepo}\nYou can run /she init again.`,
  sheReturned: (label, returnDir, changed, added, outputs) => `Task ${label} results copied to: ${returnDir}\nchanged ${changed}, added ${added}, outputs ${outputs}. Project source was not modified or staged.`,
  sheAccepted: (label, staged, copied, appliedPatch) => `Task ${label} accepted: ${appliedPatch ? 'patch applied' : 'no patch'}, copied ${copied} new files, staged ${staged} paths. No commit/push.`,
  sheDoctorTitle: 'SHE diagnostics',
  sheDoctorSource: (source, stateFile, statePresent) => `Source: ${source}; state file: ${stateFile} (${statePresent})`,
  sheDoctorHealth: (ok, detail) => `OpenCode: ${ok ? 'healthy' : 'unhealthy'}${detail === '' ? '' : ` (${detail})`}`,
  sheDoctorRuntime: (runtimeRoot, worktreeRoot, reposRoot) => `Runtime: ${runtimeRoot}\nWorktree: ${worktreeRoot}\nRepos: ${reposRoot}`,
  sheDoctorScope: shadowRepo => `Current-scope shadow repo: ${shadowRepo ?? 'not mapped'}`,
  sheNoPermission: 'This sender may not use /she (must be an approver / the chat driver).',
  sheSubmitted: (label, status) => `Submitted task ${label} (${status}). Check it with /she status ${label}.`,
  sheContinued: (label, status) => `Appended task ${label} (${status}).`,
  sheInvalid: reason => `Invalid command arguments (${reason}); send /she help for usage.`,
  sheListEmpty: 'No Topics in this chat yet. Use /she submit <request> to create one.',
  sheTopicListLine: (label, status, excerpt, summary) => `${label}  [${status}]  ${excerpt}  ${summary}`,
  sheTaskListLine: (label, status, excerpt) => `${label}  [${status}]  ${excerpt}`,
  sheTaskSummary: (total, running, queued, done) => `${total} task(s): ${running} running, ${queued} queued, ${done} done`,
  sheStatusTitle: 'Secretary task status',
  sheStatusTopic: (label, status, excerpt) => `Topic ${label} · ${status} · ${excerpt}`,
  sheStatusTask: (label, status, excerpt) => `Task ${label} · ${status} · ${excerpt}`,
  sheStatusSession: sessionId => `OpenCode session: ${sessionId}`,
  sheStatusReport: path => `Report: ${path}`,
  sheStatusAttachments: count => `Attachments: ${count}`,
  sheNotFound: reference => `Not found: ${reference}.`,
  sheReportMissing: label => `Task ${label} has no registered report yet (still running or report missing).`,
  sheReportReady: (label, size) => `Report for ${label} (${size}):`,
  sheStopped: label => `Interrupted ${label}; its Topic is paused.`,
  sheResumed: label => `Resumed the queue for Topic ${label}.`,
  sheRenamed: (oldLabel, newLabel) => `Topic label renamed from ${oldLabel} to ${newLabel}.`,
  sheRemoved: (label, purged) => purged ? `Topic ${label} was purged.` : `Topic ${label} was archived and hidden; artifacts are retained.`,
  sheError: (code, detail) => `Secretary command failed (${code}): ${detail}`,
  wsMenuTitle: '🗂 Workspaces (tap to switch)',
  wsMenuEmpty: 'No registered workspaces yet (besides the default). Add one via /ws new or /ws add.',
  wsMenuNote: 'Tap to switch · /ws list for text · /ws new to create',
  modelMenuTitle: '🧠 Models (tap to switch)',
  modelMenuPlaceholder: 'Select a model…',
  modelMenuExpiredNote: 'Tap to switch the session model (applies next turn)',
  menuPrevLabel: '‹ Prev',
  menuNextLabel: 'Next ›',
  menuPageOf: (page, total) => `Page ${page} / ${total}`,
  menuExpired: 'This menu has expired — send the command again.',
  menuGone: 'This card is no longer active — run the command again to get a fresh one.',
  menuWrongChat: 'This menu only works in its original chat',
  menuWsSettledTitle: '✅ Workspace switched',
  menuModelSettledTitle: '✅ Model switched',
  menuSessionSettledTitle: '✅ Session restored',
  menuBrowseSettledTitle: '✅ Workspace picked',
  sessionMenuTitle: '💬 Sessions (tap to restore)',
  sessionMenuNote: 'Tap to restore; a running task is stopped first',
  browseNoRoots: 'workspaceRoots is not configured, so directory browsing is unavailable; add it in the deployment settings (e.g. workspaceRoots: [your projects root]) or use /ws add <path> instead.',
  browseEmpty: '(no subfolders here)',
  browseConfirm: '✅ Use this folder',
  browseParent: '⬆️ Up one level',
  browseNote: 'Type /ws new <name> to create a folder at the browsed location and switch into it',
  wsMkdirDone: (name, path) => `Workspace "${name}" created (${path}) and switched to.`,
  wsMkdirInvalid: name => `Cannot create "${name}": the name must not contain path separators and must not be empty.`,
  wsMkdirUsage: 'Usage: /ws new (browse and pick) · /ws new <name> (create a folder at the browsed location)',
  modelCatalogHint: '💡 modelCatalog is not configured — add it in the deployment settings to get the tappable list (entries are provider/model).',
  modelAddDelUsage: 'Usage: /model add <provider>/<model> · /model del|remove <provider>/<model> (edits the picker list; deletions persist immediately)',
  modelAdded: entry => `Added ${entry} to the picker list.`,
  modelAddExists: entry => `${entry} is already in the picker list.`,
  modelCatalogFull: cap => `The picker list is full (${cap} entries); run /model del to free a slot.`,
  modelDelMissing: entry => `${entry} is not in the picker list.`,
  modelDeleted: entry => `Removed ${entry} from the picker list.`,
  modelRemoveLast: 'Keep at least one entry in the picker list.',
  modelAddCurButton: '➕ Add the current model to the list',
}

const table: Record<Locale, Strings> = { 'zh-CN': zhCN, 'en-US': enUS }

/**
 * Resolve the effective locale. `auto` without a reader hint defaults to
 * zh-CN (the primary audience); any explicit zh-flavoured hint keeps zh-CN
 * and any other hint selects en-US.
 * @param configured - the deployment's locale knob.
 * @param readerHint - optional hint about the reader's client language.
 * @returns the locale whose copy gets rendered.
 */
export function resolveLocale(configured: Config['locale'], readerHint?: string): Locale {
  if (configured === 'zh-CN' || configured === 'en-US') return configured
  if (readerHint === undefined || readerHint === '') return 'zh-CN'
  return readerHint.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Copy for one locale. */
export function strings(locale: Locale): Strings {
  return table[locale]
}
