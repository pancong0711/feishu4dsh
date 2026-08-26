# 故障排查手册（Troubleshooting）

本手册收录 feishu4dsh 在真实部署中遇到过的故障、**问题根源**与**修复方法**，供后续排查与回归参考。每一条记录尽量包含：现象 → 定位 → 根因 → 修复 → 验证。

---

## 1. 飞书回复报错：`has no provider/model`

### 1.1 现象

在飞书（含手机端）向机器人发消息，机器人回错误：

```
agent "feishu-<sessionId>" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall
```

- 会话日志（`~/.dsh/sessions/.../session.jsonl.zstd`）里每个回合都以 `turn/end` 的 `reason.kind === "error"` 结束，没有任何 `request/header` 写出（即模型请求从未发出）。
- 同一部署下，**CLI（headless）与 Web（host-apiproxy）运行正常**，唯独**飞书（feishu4dsh）**新建的会话失败。
- 曾经正常工作的旧会话（同一部署早期建立）可正常使用，而**服务重启后新建的会话**失败。

### 1.2 定位过程

1. 先确认 LLM 配置本身没问题：`~/.dsh/settings.yaml` 中 `agent-default-model`（`provider: opencode-go`）与 `llm-pi-ai.providers.opencode-go`（含 `apiKeyEnv: OPENCODE_GO_API_KEY`、模型列表）均有效。
2. 用 headless 在相同工作目录实测一次模型调用，成功（说明 LLM 配置、凭据、模型路由都健康）。
3. 对比各入口创建 Agent 时**是否显式提供 provider/model**：

| 入口 | 创建时传入 `agentOptions: {provider, model}` | setup 中 `installModelSelection` |
|---|---|---|
| **headless**（`dsh-headless`） | ✅ 读取 `agentDefaultModel.currentSelection()` 传入 | ✅ |
| **Web**（`dsh-host-apiproxy`） | ✅ 同上 | ✅ |
| **飞书**（`feishu4dsh`） | ❌ 未传 | ❌ |

4. 查看框架源码（`dsh-agent-loop/lib/index.js`）`buildRequest`：

   - 请求配置的**种子**来自 `AgentOptions.provider/model`：
     ```js
     const route = { provider: this.options.provider ?? "", model: this.options.model ?? "" }
     ```
   - 随后进入 `agent/request` 瀑布；若没有任何监听者补上 provider/model，则：
     ```js
     if (!proposedConfig.provider || !proposedConfig.model)
       throw new Error(`agent "${this.id}" has no provider/model: …`)
     ```
   - `provider/model` 的默认值只能来自两条途径之一：**① 创建 Agent 时显式传入 `agentOptions`**，或 **② setup 中 `installModelSelection(...)` 注册的瀑布监听者**（从 `agentDefaultModel.currentSelection()` 取值）。

   feishu4dsh 两条途径都缺失，因此新建的 Agent 完全没有可用的 provider/model 种子。

### 1.3 问题根源（Root Cause）

**feishu4dsh 在 `bridge.ts` 的 `ensureAgent()` 创建/恢复 Agent 时，没有把默认的 provider/model 传入 `agents.create()` / `agents.resume()`。**

- feishu4dsh 只读 `agentDefaultModel` 用于 `/status` 展示（`modelLine`），却没有在 Agent 生命周期里把它交给运行时。
- dsh 框架**不会**（当前版本）自动为任何入口注入默认模型——headless 与 Web 都会主动读取 `agentDefaultModel.currentSelection()` 并传入，而 feishu4dsh 遗漏了这一环。
- 因此这是一个 **feishu4dsh 插件缺陷**，而非部署/配置问题：即使 `settings.yaml` 完全正确，飞书新建会话仍会失败。

### 1.4 修复方法（Fix）

在 `src/bridge.ts` 中：

1. 新增 `defaultModelOf(env)`，读取 `agentDefaultModel` 服务并把当前选择作为 `HostAgentOptions` 返回（服务缺失或读取失败时安全降级为空对象）：
   ```ts
   /** The deployment's current default provider/model selection, if advertised. */
   function defaultModelOf(env: BridgeEnv): HostAgentOptions {
     const defaults = env.host.get('agentDefaultModel') as HostDefaultModel | undefined
     if (defaults === undefined) return {}
     try {
       return defaults.currentSelection()
     } catch {
       return {}
     }
   }
   ```

2. 在 `ensureAgent()` 中把返回的 `agentOptions` 同时传给 `resume` 与 `create`：
   ```ts
   const agentOptions = defaultModelOf(env)   // ← 关键补丁
   try {
     handle = await env.host.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
   } catch {
     handle = await env.host.agents.create({
       sessionId,
       meta: binding.workspacePath === '' ? undefined : { cwd: binding.workspacePath },
       agentOptions,                          // ← 关键补丁
       setup,
     })
   }
   ```

3. 在 `host.ts` 的宿主契约里补充 `agentOptions`（`HostAgentOptions`）与 `resume/create` 的可选参数——插件保持自包含，仅依赖结构型窄契约，不 import 宿主源码包。

> 说明：官方 headless 与 Web 还额外调用 `installModelSelection()`（支持会话内模型切换）。feishu4dsh 当前**没有** `/model` 切换命令，采用「显式传入 `agentOptions`」这个最贴合现状、且与 `/status` 同数据源的最小修复即可；若未来增加模型切换能力，再补充 `installModelSelection`。

### 1.5 验证（Verification）

- **构建**：`npm run build`（`tsc -b`）通过，无类型错误。
- **单测**：新增 2 项桥层测试
  - 有 `agentDefaultModel` 服务时，新建 Agent 的 `agentOptions` 应为默认 `{provider, model}`；
  - 无 `agentDefaultModel` 服务时，`agentOptions` 安全降级为 `{}` 不抛错。
  - 合计 **91/91 通过**（原 89 + 新增 2）。
- **服务回归**：`systemctl --user restart dsh-feishu4dsh` 后服务 `active (running)`，飞书长连接正常（`connected as YUNBOT-FEISHU`），启动日志无新增错误。
- **真人回归**：重启后在飞书（含手机端）发送新消息，新建会话应能正常驱动默认模型返回回复；可用 `/status` 确认模型为 `opencode-go/deepseek-v4-flash`。

---

## 附：如何复现 / 自检

- 若怀疑是同类问题，先在 CLI 用相同 `settings.yaml` 实测一次：
  ```bash
  cd <工作目录> && dsh --profile headless "hi"
  ```
  CLI 正常而飞书失败 → 大概率是 feishu4dsh 未向 Agent 传入默认模型（本手册 §1 所述）。
- 用 `dsh --profile feishu4dsh --dump-config` 可确认组合后的插件树；但注意默认 `agent-default-model` 的组合值是 `deepseek-official`，**用户层覆盖（settings.yaml 的 `agent-default-model`）在运行时由 settings 服务加载**，`--dump-config` 不反映它，需以实际运行行为为准。

---

## 2. 飞书话题会话“卡住”/长时间无回复

### 2.1 现象

- 手机飞书话题里给机器人发消息后，机器人长时间没有新消息；
- 服务本身 `active (running)`，WebSocket 连接正常；
- 会话日志里最后事件不是错误，而是 `tool/call`、`tool-workflow/agent-start`、`llm/retry-started` 等。

### 2.2 常见根因：同步长任务工具（如 `workflow`）阻塞了当前 turn

dsh 的某些工具（例如 `workflow`）会同步等待全部子任务完成才返回结果。期间：

- 主 Agent 的当前 turn 处于“等待工具结果”状态；
- feishu4dsh 只有在 `assistant/chunk` / `assistant/message` / `turn/end` 时才会向飞书输出；
- 工具执行中的中间进度不会主动推到飞书。

因此飞书侧看起来“卡住”，实际后台仍在工作。

### 2.3 如何判断

```bash
# 服务健康
systemctl --user status dsh-feishu4dsh

# 看最近会话日志是否还在推进
cd ~/.dsh/sessions
# 找到对应 session.jsonl.zstd，查看最后事件类型
zstd -dc <session>/session.jsonl.zstd | tail -5
```

如果看到：

- `tool/call` / `tool/result` 交替出现；
- `tool-workflow/agent-start` / `tool-workflow/agent-end` 数量持续增加；
- `llm/retry-started` 后仍有后续 `assistant/chunk`；

说明任务仍在执行，不是死锁。

### 2.4 处理建议

- **立即停止**：在对应飞书话题里发送 `/stop`，可中断当前 turn；
- **长期避免**：长任务应改用 dsh 后台 `subagent` / `job`，让主会话先回复“已开始”，完成后通过通知再汇报；
- **不要**因为“看起来卡住”频繁重启服务，否则会中断正在执行的长任务。

### 2.5 典型实例

- 某会话正在运行 `workflow` 工具做批量图片转录，大量视觉子 Agent 长时间运行；
- 日志显示子任务持续推进（agent-start / agent-end 交替出现）；
- 服务 CPU/内存正常，属于**长时间同步工具调用**导致的“假卡住”。

---

## 3. 切换模型/工作区“不生效”，或工作区落到用户根目录

### 3.1 先记住两条结论（R11）

1. **切换不需要 `/new`**：`/model` 在下一轮 turn 生效；`/cd` 后下一条消息即进入新工作区会话。`/new` 只清空当前工作区的**上下文**，模型 pin 与工作区绑定都不受影响。
2. **模型 pin 按「会话 × 工作区」各自记忆**：`/cd` 到别的工作区后生效的是那个会话自己的模型（pin → 该会话日志 → 部署默认）。用 `/status` 核实当前值，属设计行为而非 bug。

### 3.2 现象：`/status` 显示的工作区与 Agent 实际读写目录不一致（如落在守护进程的启动目录）

排查顺序：

```bash
# 看服务日志有无路径校验告警
journalctl --user -u dsh-feishu4dsh -n 200 | grep 'not a real directory'
```

- 告警形如 `workspace '<坏路径>' for scope ... fell back to default '…'` → `chatWorkspaces` / 新话题继承的值失效，按提示补正后重启；
- 告警形如 `... (default '…' is not real either); using the daemon working directory '…' — fix the 'workspace' setting` → **配置里的默认 `workspace` 本身失效**（目录被删/改名/手改出错/空串），Agent 已兜底到守护进程 cwd，请尽快把 `workspace` 改为真实存在的目录并重启。

R11 之后 `binding.workspacePath` 恒为真实存在的目录，`/status` 显示 ≡ Agent 实际沙盒目录；若仍见不一致，请先确认运行的是包含该修复的插件版本。

### 3.3 现象：群聊里 `/cd` 提示「无权切换工作区」

R11 起 `/cd` 与 `/ws add`、`/model` 共用审批 ACL：配置了 `approvers` 时仅名单内成员可切换。让名单内成员执行，或调整 `approvers` 配置。
