# feishu4dsh · DeepSeek Harness 飞书 / Lark 通道插件

把飞书/Lark 聊天接入 DeepSeek Harness（dsh）的通道插件：消息、话题、工作区、会话、模型、卡片、文件与审批都在飞书侧完成，执行交给 dsh agent。

> **边界说明**：SHE agent control plane（任务队列、agent/sandbox/broker、`/she`）已迁移到独立项目 `2611she`。本插件只负责飞书 ↔ dsh 的通道连接，不再内置 SHE。

## 定位

```text
飞书/Lark  ⇄  feishu4dsh  ⇄  dsh agent/session
```

- 通道负责：WebSocket/Webhook、消息与媒体、卡片、文件、审批、ACL、工作区、会话选择；
- dsh 负责：agent runtime、模型、工具、上下文与会话；
- SHE 负责：独立 agent control plane，不在本插件内。

## 快速开始

```sh
# 专用 profile（推荐）：首次会自动以 dsh-base 初始化 profile，再挂载本插件
dsh plugin --profile feishu4dsh add feishu4dsh
```

最小配置：

```yaml
appId: cli_xxx
appSecret: xxx
sessionScope: chat-thread
requireMention: true
```

或按 [docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md) 创建飞书自建应用，把凭据写入 dsh profile patch / 环境文件。

### 部署为 user service

```sh
mkdir -p ~/.config/feishu4dsh
# 写入 FEISHU_APP_ID=... 与 FEISHU_APP_SECRET=... 后：
chmod 600 ~/.config/feishu4dsh/feishu4dsh.env

# 只打印 unit 和命令，不修改系统
bash scripts/install-user-services.sh --dry-run

# 只读检查 unit / env / systemd 状态
bash scripts/install-user-services.sh --check

# 确认后安装并启用 dsh-feishu4dsh.service
bash scripts/install-user-services.sh --enable
```

安装器只管理 `dsh-feishu4dsh.service`，不安装 Docker/agent，不使用 sudo，也不管理任何 SHE 服务。

## 主要能力

| 能力 | 说明 |
|---|---|
| 双传输 | WebSocket（默认，带重连）/ Webhook |
| 多消息 | 文本、图片、文件/音视频（落入工作区收件箱） |
| 回复 | `stream` 流式 / `card` 聚合；过程行、Token 摘要、可折叠 reasoning |
| 协作卡片 | 工具/出站文件审批，超时按拒绝（fail-closed） |
| 结构化提问 | `ask_user` 表单卡：单选/多选/自由文本，越权与超时 fail-closed |
| 会话隔离 | chat / chat-thread / chat-sender 三种粒度，重启恢复 |
| 会话管理 | `/session` 列表、切回、重命名、归档 |
| 模式 | `standard` / `minimal`，`/mode` 切换 |
| 多工作区 | `/ws` 点选、`/ws new` 浏览器、`/cd` 切换并持久化 |
| 模型 | `/model` 切换、清单增删与点选、`/model effort` |
| 上下文压缩 | `/compact [N] [问题]` |
| 授权 | 发送人/群白名单、审批人名单（只收窄） |
| 文件 | 入站 `inbox/`；`send_file` 出站，群聊逐次审批 |
| 服务信息 | `/info` 只读展示插件版本、传输、工作区与 service/journal 命令 |
| i18n | `locale: auto` 自动跟随读者语言 |

## 安全边界（要点）

- 白名单/审批人只收窄，不放行；
- 审批超时 fail-closed；
- 出站文件做词法 + realpath 校验，防 symlink 逃逸；
- 入站文件统一进入 `<workspace>/.feishu4dsh/inbox/`；
- 群聊出站文件必须审批；
- 工作区切换只允许默认/已注册/`workspaceRoots` 内路径；
- 不在 dsh web 中驱动飞书通道创建的 `feishu-*` 会话（单写入方约定）。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## 文档

- [架构](docs/ARCHITECTURE.md)
- [配置](docs/CONFIG.md)
- [飞书应用设置](docs/FEISHU-SETUP.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [发布流程](docs/PUBLISHING.md)
- [文档索引](docs/README.md)

## 版本与兼容性

要求 dsh `>= 0.2.1-rc.2`（Cordis `^4.0.1`）与飞书 SDK `^1.73.0`。dsh 处于预览期，升级后请回归；宿主契约收敛在 `src/host.ts`。

## License

MIT
