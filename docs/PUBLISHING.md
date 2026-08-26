# 发布指南：GitHub 与 npm

本文档说明如何把 **feishu4dsh** 发布到 GitHub（以及可选的 npm）。仓库已就绪：MIT LICENSE、`.gitignore`（排除 `node_modules/` `lib/` 与运行时痕迹）、CI 工作流、`dsh-plugin` 话题建议均已备好。

> 说明：发布需要你本人的 GitHub 凭据，**我无法代为推送**。下面给出可直接照做的命令；如需我先在本地初始化 git 仓库并完成首个 commit，告诉我即可。

---

## 一、发布到 GitHub

### 前置准备

```sh
git --version        # 需 git 2.26+
gh --version         # 可选：安装 GitHub CLI 可一条命令建仓
git config user.name  "你的名字"
git config user.email "你的邮箱"
```

### 方式 A：用 GitHub CLI（推荐，最省事）

```sh
cd feishu4dsh

# 1) 创建远程仓库并设为 origin（public 或 private 自行选择）
gh repo create feishu4dsh --public --source=. --remote=origin

# 2) 首次提交并推送
git add -A
git commit -m "feat: feishu4dsh — Feishu/Lark IM channel plugin for DeepSeek Harness"
git push -u origin main
```

`gh repo create ... --source=.` 会自动建仓、关联 remote 并引导首次推送，一步到位。

### 方式 B：先在网页建仓，再本地推送

1. 打开 https://github.com/new ，仓库名填 `feishu4dsh`（**不要**勾选自动生成 README/license，避免与本地冲突）。
2. 本地执行：

```sh
cd feishu4dsh
git init -b main
git add -A
git commit -m "feat: feishu4dsh — Feishu/Lark IM channel plugin for DeepSeek Harness"
git remote add origin https://github.com/<你的用户名>/feishu4dsh.git
git push -u origin main
```

### 发布后的仓库配置（提升可发现性）

| 项目 | 建议值 |
|---|---|
| 简介（About/Description） | `Feishu/Lark IM channel plugin for DeepSeek Harness (dsh)` |
| Topics（话题） | `dsh-plugin` `deepseek-harness` `dsh` `feishu` `lark` `cordis` |
| License | 已是 MIT（LICENSE 文件） |
| 默认分支 | `main` |

> 打上 **`dsh-plugin`** 话题是关键：社区的 awesome 列表与插件索引按该话题自动收录。

---

## 二、提交前的自检（建议跑一遍）

```sh
cd feishu4dsh
pnpm install
pnpm typecheck      # 严格类型检查应零错误
pnpm test           # 应 134/134 通过  (以当时版本为准)
pnpm build          # 产出 lib/

git status          # 确认无 node_modules/ lib/ .env 被误加
```

`.gitignore` 已排除 `node_modules/`、`lib/`、`*.tsbuildinfo`、`.env*`、日志与 `.feishu4dsh/` 运行时目录，正常情况下不会被提交。**切勿提交真实 App ID / App Secret。**

### 发布快照构建与检查清单（2026-08-25 二次定稿）

> 远程仓库仅发布**测试过、去敏的内容**（白名单：`src/` `tests/` `.github/` + 配置元数据 + 用户面文档）。
> 日常开发提交只留在本地全量仓库；对外发布走下面的快照流程（维护者以内部脚本执行同一清单）。

1. **确认意图**：动远程前先与所有者确认目标与边界——"落后于主线"不等于"需要修复"。
2. **构建快照树**：从全量 main 生成白名单快照，删除白名单外的内部过程/规格/日志文档；
   对保留文档做脱敏修订（真实路径 / 会话 id / 私人场景名 → 泛化表述）。
3. **凭据扫描**（应零命中）：
   ```sh
   git grep -nE "(ou|oc)_[0-9a-f]{16,}"            # 真实 open_id / chat_id
   git grep -niE "(appsecret|secret)\s*[:=]\s*['\"][^'\"]{8,}"
   git grep -nE "sk-[A-Za-z0-9]{10,}|password\s*[:=]"
   ```
4. **悬空引用扫描**：快照内不得引用未发布的内部文档名（如内部需求 / 会话记录 / 各轮次规格文档）。
5. **快照内测试**：`pnpm typecheck && pnpm test && pnpm build` 全绿；源码/测试与全量仓库对应提交逐字节一致。
6. **推送留痕**：force-push 快照覆盖 `origin/main`；全量仓库打 `published-snapshot-*` tag；本部署预览仓库 `git fetch && git reset --hard origin/main` 保持与远程一致。

> **CI 经验（2026-08-25）**：若 `pnpm install` 报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: <pkg>`，
> 是 pnpm ≥10 默认忽略依赖构建脚本所致——在 `pnpm-workspace.yaml` 的 `allowBuilds` 里把该包置为 `true` 即可
> （本仓库依赖 `@larksuiteoapi/node-sdk` → `protobufjs`）。注意：机器级 `~/.npmrc` 的 `allow-scripts` 只影响本机，
> 仓库级修复必须落在 `pnpm-workspace.yaml` / `package.json` 里随代码推送。

## 三、三个仓库：全量 / 去敏 / 远程

> 本项目按「**全量 → 去敏 → 远程**」三层组织仓库，**去敏 与 远程 始终保持一致**。理解这三层是任何协作者（人类或 Agent）动 git 前的前提。

| 仓库 | 位置 | 内容 | 角色 |
|------|------|------|------|
| **全量仓库** | 本地主仓（分支 `main`） | 全部源码 + 测试 + **内部过程/规格/日志文档** | "仓库即记忆"：内部权威来源，日常开发提交只在这里 |
| **去敏仓库** | 部署预览仓库（`publish/` 下的独立 git 仓库） | **白名单去敏快照**：`src/` `tests/` `.github/` + 配置元数据 + 用户面文档 | 发布筛选边界：一切对外内容的来源 |
| **远程仓库** | GitHub `pancong0711/feishu4dsh`（公开） | = 去敏快照（force-push 覆盖，历史只保留快照提交） | 对外发布面 |

**同步规则**

1. 全量主仓解除对 origin 的 upstream 跟踪，**不得直接 push 到远程**（防误推内部文档）；
2. 对外发布 = 从全量 main 按上文清单生成去敏快照 → **快照内全量测试通过** → force-push 覆盖 `origin/main` → 全量仓库打 `published-snapshot-*` tag 留痕 → 部署预览仓库 `git fetch && git reset --hard origin/main` 与远程保持一致；
3. 去敏仓库与远程仓库**逐字节一致**：远程的每一提交都源自去敏仓库的同一棵树；
4. 已推送到公开远程的内容**无法彻底撤回**（缓存 / fork 可能留存），因此一切敏感内容靠"永不入库 + 推前扫描"前置拦截（见上文检查清单）。

> **注意**：`package.json` 的 `repository.url` 已设置为 `https://github.com/pancong0711/feishu4dsh.git`；如迁移仓库请同步修改。

---

## 四、可选：发布到 npm

仓库 `package.json` 的 `name` 为 `feishu4dsh`、含 `files` 白名单、`exports` 与 `repository` 字段，可直接发布：

```sh
npm login
cd feishu4dsh
pnpm build
npm publish --access public
```

发布后，用户即可用 `dsh plugin --profile web add feishu4dsh` 安装。
> 若 `feishu4dsh` 被占用或想用作用域名，可改为 `@<你的scope>/feishu4dsh`，并同步更新 README 中的包名与 `package.json` 的 `name`。

---

## 五、已内置的工程化资产

| 资产 | 作用 |
|---|---|
| `.github/workflows/ci.yml` | PR/push 自动跑 typecheck + 测试 + 构建（Node 22/24 矩阵） |
| `.gitignore` | 排除依赖、构建产物、凭据与运行时痕迹 |
| `package.json` 的 `files` | npm 发布携带 `lib/ src/ docs/`、`CHANGELOG.md`、README、LICENSE |
| `package.json` 的 `repository` | 指向 GitHub 仓库，便于 npm 展示主页与提 issue |
| `CHANGELOG.md` / `docs/*.md` | 版本历史与使用/架构/发布/故障排查/经验文档 |

---

## 六、版本与标签管理

后续发布建议遵循语义化版本，并打 tag：

```sh
git tag v0.3.0
git push origin v0.3.0
# 在 GitHub Releases 里基于该 tag 撰写发布说明（可从 CHANGELOG.md 粘贴）
```

> dsh 仍处 rc 预览期，官方明示有破坏性变更：建议在 README 与 Release Notes 里注明「经 <某 dsh 版本> 验证」，方便用户对齐。
