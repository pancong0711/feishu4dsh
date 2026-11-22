# 秘书子模块（SHE）

> 状态：可选能力，默认关闭。详细工作单不在公开快照内。

SHE = **S**ecretary **H**andoff **E**xecutor。它让飞书里的 `/she` 命令把用户原文按固定信封
转交给本机 OpenCode 异步执行，并持久化 Topic/Task、串行队列、状态和报告。

## 快速启用

前置条件：opencode-she 侧 OpenCode 已由独立 sandbox/运维启动；当前聊天在一个 git 仓库。

审批人在飞书执行：

```text
/she init [shadow-repo-name]
```

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
/she init [名称]
/she doctor
/she submit <原文>
/she continue <Topic> <原文>
/she list [Topic]
/she status <Topic|Task>
/she report <Task>
/she stop <Task>
/she resume <Topic>
/she topic rename <old> <new> [--force]
/she topic remove <Topic> [--purge]
/she help
```

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
