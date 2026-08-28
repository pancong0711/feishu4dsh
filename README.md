# feishu4dsh · DeepSeek Harness 飞书 / Lark 通道插件

把 **DeepSeek Harness（dsh）** 接进飞书：在聊天里给 Agent 派任务、看执行过程、批准或拒绝工具调用；提问与授权确认直接在飞书卡片上点按钮处理。

## 定位

- **面向个人用户**：一个 dsh 实例 + 一个飞书自建应用（单机器人），服务主人自己的多项目工作台——不是 one-person-company 式「多机器人分工协作」的编排方案；
- **话题即项目**：以飞书群聊/私聊的话题（thread）为项目边界，每个话题独立 Agent 会话与工作区，`/cd` 切换、`/new` 重开、重启可恢复；
- **为什么做这个插件**：我们的日常是「在飞书里驱动 Agent 干活」——此前用 Hermes Agent 的飞书插件，交互顺手、体验对味；而早期的 dsh 飞书通道与这套使用习惯差距较大，问题修复链路也长。于是以 Hermes 飞书插件的体验为对标，把 dsh 接进飞书：早期借鉴社区 lark-bot 通道代码的经验，随后以独立 dsh 插件库用 TypeScript / Cordis 重写——传输层模块化 + 对接层可移植，开发过程本身也由 dsh 会话协作推进。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
- **把 dsh web 的体验带进飞书**：dsh 自带的 Web 控制台很好用——会话的模式、模型、推理强度、轮次与 Token 统计一目了然。本插件把这些能力逐步搬进聊天命令（`/status` `/mode` `/model` `/model effort`），不开电脑也能在飞书里看到同样多的信息、调到同样的开关。

## 快速开始

前置：Node.js `^22.19 || >=24`、已装 dsh、一个飞书自建应用（[docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md)）。

```sh
# 本地目录挂载（开发推荐）或发布到 npm 后按包名安装
dsh plugin --profile web add /path/to/feishu4dsh

export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
dsh web            # 控制台出现 `feishu4dsh: connected as <机器人>` 即成功
```

默认 **WebSocket 长连接**，无需公网/回调 URL。在飞书私聊机器人或在群里 @它即可。

## 进程管理（systemd 推荐）

仓库部署环境已配置 user 级 systemd unit：

```text
~/.config/systemd/user/dsh-feishu4dsh.service
```

常用命令：

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-feishu4dsh.service
systemctl --user restart dsh-feishu4dsh.service
systemctl --user status dsh-feishu4dsh.service
journalctl --user -u dsh-feishu4dsh.service -f
```

- 服务由 systemd 托管，崩溃后自动重启（`Restart=always`）；
- 日志进入 journald，用 `journalctl --user -u dsh-feishu4dsh.service` 查看；
- 如果之前用 `nohup` 手工启动过，请先停掉手工进程再启用 systemd，避免双开。

## 主要能力

| 能力 | 说明 |
|---|---|
| 双传输 | WebSocket（默认，带重连）/ Webhook |
| 多消息 | 文本、图片（可选送视觉）、文件/音视频（落入工作区收件箱） |
| 回复 | `stream` 流式 / `card` 聚合；`showProcess` 按轮聚合显示工具调用与 Token 用量摘要 |
| 协作卡片 | 工具/出站文件审批，超时按拒绝（fail-closed） |
| 会话隔离 | 按聊天/话题/发送人三种粒度，重启可恢复，`/new` 重开 |
| **多工作区** | 会话 = scope×工作区；`/ws` 列/加/删、`/cd` 手机端切换，均持久化 |
| 授权 | 应用可用范围 + 发送人/群白名单 + 审批人名单（只收窄） |
| 命令 | `/help` `/new` `/mode` `/stop` `/status` `/ws` `/cd` `/model`（含 `/model effort`） |
| 文件 | 入站进 `.feishu4dsh/inbox/`；`send_file` 回传，群聊逐次审批 |
| i18n | `locale: auto` 跟随读者语言，默认中文 |

命令说明与多工作区准入规则 → [docs/CONFIG.md](docs/CONFIG.md)。

## 安全边界（要点）

- **只收窄、不放行**：白名单/审批人仅收窄，无反向放行开关。
- **审批 fail-closed**：超时未点一律拒绝。
- **出站文件**：词法 + realpath 双段校验防符号链接逃逸，失败不泄露宿主绝对路径。
- **入站文件**：统一收口 `.feishu4dsh/inbox/`，文件名清洗。
- **群聊出站必审批**：无关闭项（防提示注入外泄）。
- **工作区切换准入**：仅默认 / 已注册 / `/ws add` / `workspaceRoots` 之内。

## 开发

```sh
pnpm install
pnpm typecheck    # 严格类型检查
pnpm test         # vitest 全量单测
pnpm build        # tsc 产出 lib/
```

## 文档

- 📂 [docs/README.md](docs/README.md) — 文档索引（长期记忆中心，先读它）
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 配置：[docs/CONFIG.md](docs/CONFIG.md) ｜ 飞书应用：[docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md)
- 排障（含 `has no provider/model`）：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- 📜 开发史与发布模型：[HISTORY.md](HISTORY.md)
- 发布：[docs/PUBLISHING.md](docs/PUBLISHING.md)

## 版本与兼容性

针对 **dsh `0.1.1-rc.2`**（Cordis `^4.0.1`）与飞书 SDK `^1.73.0`。当前源码与测试已在 dsh `0.1.1-rc.2` 上验证（本地与 publish 发布副本均使用该版本）。dsh 处于预览期，升级后请回归；宿主契约收敛在 `src/host.ts`，是版本适配唯一改动面。

## 路线图

原生思考过程消息 · 提问卡片（对接 `ask_user_question`）· 多机器人 @ 交接 · 斜杠命令面板同步。

## License

[MIT](LICENSE)。非官方社区项目，与 DeepSeek、字节跳动、飞书、Lark 无从属/授权/背书关系。
