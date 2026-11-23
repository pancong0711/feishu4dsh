# 秘书子模块（SHE）

> 状态：可选能力，默认关闭。详细工作单不在公开快照内。

SHE = **S**ecretary **H**andoff **E**xecutor。它让飞书里的 `/she` 命令把用户原文按固定信封
转交给本机 OpenCode 异步执行，并持久化 Topic/Task、串行队列、状态和报告。

## 快速启用

前置条件：opencode-she 侧 OpenCode 已由独立 sandbox/运维启动；当前聊天在一个 git 仓库。

审批人在飞书执行：

```text
/she init
```

Shadow repo 自动命名为 `<源仓库 basename>-shadow-repo`。同一 scope 只初始化一次；
更新用 `/she init update`，更换源仓库先 `/she init reset`。

`/she init` 会准备共享 shadow repo、SHE runtime/worktree、ACL 和 0600 状态文件，并
在当前进程内启动 SHE。普通用户不需要编辑 URL/password/model/root 配置。

启动优先级：

```text
secretaryEnabled: true（手工配置）
  > 自动恢复 ~/.local/state/feishu4dsh/she-bootstrap.json
  > 未启用
```

状态文件只保存路径与模型标识，不保存 provider 凭据或 HttpApi 密码。

## 命令

```text
/she init
/she init update
/she init reset
/she need
/she need package
/she need verify
/she doctor
/she submit <原文>
/she continue <Topic> <原文>
/she list [Topic]
/she status <Topic|Task>
/she report <Task>
/she return <Task>
/she accept <Task>
/she stop <Task>
/she resume <Topic>
/she topic rename <old> <new> [--force]
/she topic remove <Topic> [--purge]
/she help
/she help <命令>
/<命令> --help
```

帮助形式等价：`/she help init`、`/she init --help`、`/she init -h`、`/she init help`。

### she-sandbox 交付

`/she need` 只读检查执行面缺口；`/she need package` 生成不含密钥的 she-sandbox
交付包（host bootstrap、非 root 安装、verify、Dockerfile、descriptor 协议）；
`/she need verify` 验证 descriptor、health 与 runtime。频道侧用户名从运行时获取，
不硬编码；`opencode-she` 是默认沙箱用户。

### 结果回收

`/she return <Task>` 只复制到 `<project>/she_returns/<task-id>/`，不改源码：
报告、patch、changed/new files、outputs 与 manifest 均按固定协议生成。

`/she accept <Task>` 先 `git apply --check`，再应用 patch、复制新文件，并只 stage
manifest 中的 affectedPaths；不 commit/push。它不是单纯的 `git add`。

### `/she submit` 提示词怎么写

不需要长篇背景。建议写清：目标、范围、验收、禁止事项。报告路径由 SHE 自动生成，
用户不要自行指定，以免写出协议约定之外的文件。

```text
/she submit 目标：阅读 README.md 并总结当前插件用途。
范围：只读 README.md，不修改源码。
验收：报告不超过 200 字，引用关键能力点。
禁止：不要 commit/push，不要安装依赖，不要访问 worktree 外文件。
```

路径、验收和禁止事项比背景描述更重要；不建议把大量文件内容直接粘进消息。

## 行为与安全

- SHE 不管理 Docker、不访问 Docker socket；容器/provider 凭据由 opencode-she 侧负责；
- 同一 Topic 严格串行；失败、中断、报告缺失或执行器不可达会暂停 Topic；
- 每个 Topic 使用独立 OpenCode session 与 git worktree；
- 数据库只保存请求 hash、20 字摘录与执行器引用；排队原文仅临时 spool，提交后删除；
- 报告由 OpenCode 写到约定路径，SHE 只校验存在/大小并原样回传；
- 不自动 commit/push/merge/deploy；群聊报告文件仍走飞书审批；
- OpenCode 只建议绑定 loopback，密码不得写入日志、数据库、状态文件或飞书消息。

### OpenCode 权限边界

SHE 通过 OpenCode session 的 `permissions` 字段传规则，不会修改全局配置，也不会
污染其他 session。实测中 read 工具的外部读取和 shell commit 可被规则拒绝，但
`external_directory` 不约束 shell。因此 permission ruleset 只适合防误操作，不是
OS 沙箱；真正的硬边界是独立用户 + 容器/namespace mount + 仅挂载必要共享目录。
