# 秘书子模块（SHE）

> 状态：可选能力，默认关闭。详细工作单不在公开快照内。

SHE = **S**ecretary **H**andoff **E**xecutor。它让飞书里的 `/she` 命令把用户原文按固定信封
转交给本机 OpenCode 异步执行，并持久化 Topic/Task、串行队列、状态和报告。

## 启用

```yaml
secretaryEnabled: true
secretaryRoot: /path/to/secretary-state
secretaryOpencodeUrl: http://127.0.0.1:49374
secretaryOpencodeUsername: opencode
secretaryOpencodePasswordFile: ~/.config/opencode/service.json
secretaryModelProviderID: opencode-go
secretaryModelID: deepseek-v4.1-flash
secretaryModelVariant: high
```

OpenCode 密码解析优先级：`OPENCODE_SERVICE_PASSWORD` → `secretaryOpencodePassword` →
`secretaryOpencodePasswordFile`（600 权限 JSON 的 `password` 字段）。

## 命令

```text
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

- 默认关闭；未启用时不创建数据库、不读取 OpenCode 凭据、不启动 watcher；
- 同一 Topic 严格串行；失败、中断、报告缺失或执行器不可达会暂停 Topic；
- 每个 Topic 使用独立 OpenCode session 与 git worktree；
- 数据库只保存请求 hash、20 字摘录与执行器引用；排队原文仅临时 spool，提交后删除；
- 报告由 OpenCode 写到约定路径，SHE 只校验存在/大小并原样回传；
- 不自动 commit/push/merge/deploy；群聊报告文件仍走飞书审批；
- OpenCode 只建议绑定 loopback，且密码不得写入日志、数据库或飞书消息。

### OpenCode 权限边界

SHE 通过 OpenCode session 的 `permissions` 字段传规则，**不会修改全局
`~/.config/opencode/opencode.jsonc`**，也不会污染其他 session。实测中：

- `read` 工具读取 `.env`、读取工作区外文件会被拒绝；
- `shell` 执行 `git commit` 等匹配规则可被拒绝；
- 但 `external_directory` **不约束 shell**，shell 仍可能写工作区之外。

因此 permission ruleset 只适合防误操作，不是 OS 沙箱。若要求“OpenCode 只能写
Topic worktree”，必须用独立 Unix 用户/容器/namespace：只对 worktree 授予写权限，
原仓库与 HOME 只读，网络默认关闭或仅 loopback。
