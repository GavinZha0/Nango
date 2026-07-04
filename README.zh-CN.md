<div align="center">
  <img src="public/logo.png" alt="Nango" width="120" />

  <h1>Nango</h1>

  <p><strong>面向小团队的 AI 原生协作工作空间 — 专为数据分析而构建。</strong></p>

  <p>
    与 <strong>Nango</strong> 聊天，你的 AI 队友。将一次性答案转化为
    可刷新、可共享的数据产品，让整个团队都能在此基础上构建。
  </p>

  <p>
    <img alt="Next.js"     src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" />
    <img alt="React"       src="https://img.shields.io/badge/React-19-149eca?logo=react" />
    <img alt="TypeScript"  src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript" />
    <img alt="PostgreSQL"  src="https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql" />
    <img alt="Drizzle ORM" src="https://img.shields.io/badge/Drizzle-ORM-C5F74F" />
    <img alt="Tailwind"    src="https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss" />
    <img alt="CopilotKit"  src="https://img.shields.io/badge/CopilotKit-AG--UI-7c3aed" />
    <img alt="License"     src="https://img.shields.io/badge/License-MIT-blue" />
  </p>

  <p>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/lint-and-type-check.yml"><img alt="Lint" src="https://github.com/GavinZha0/nango/actions/workflows/lint-and-type-check.yml/badge.svg?branch=main" /></a>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/e2e-tests.yml"><img alt="E2E" src="https://github.com/GavinZha0/nango/actions/workflows/e2e-tests.yml/badge.svg?branch=main" /></a>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/release-please.yml"><img alt="Release" src="https://github.com/GavinZha0/nango/actions/workflows/release-please.yml/badge.svg" /></a>
    <a href="https://github.com/GavinZha0/nango/pkgs/container/nango"><img alt="GHCR" src="https://img.shields.io/badge/ghcr.io-nango-2496ed?logo=docker&logoColor=white" /></a>
    <a href="https://github.com/GavinZha0/nango/releases"><img alt="Release version" src="https://img.shields.io/github/v/release/GavinZha0/nango?include_prereleases&sort=semver&color=green" /></a>
  </p>

  <p>
    <a href="#quick-start-docker"><strong>快速开始</strong></a> ·
    <a href="#development-setup">开发设置</a> ·
    <a href="#architecture-overview">架构概览</a> ·
    <a href="#recommended-companions">推荐组件</a> ·
    <a href="#documentation">文档</a>
  </p>
</div>

---

## 什么是 Nango（南瓜）？

Nango 是一个小团队 **AI 协作平台**。它不是一次性聊天机器人，
而是将一个 AI 代理——也称为 **Nango**——定位为坐在团队工作空间中的*同事*，
与用户交谈、接手任务，并与团队协作完成工作。产品目前的重点是**数据分析**工作流：
连接数据库、提出问题、获取图表、保存、调度、分享。

Nango 围绕**两大产品支柱**构建：

| 支柱 | 功能 | 状态 |
|---|---|---|
| **AI 引擎** — AI 队友 | 聊天驱动的代理，连接数据、运行 SQL、编写代码、调用工具、编排子代理。 | 生产就绪 |
| **制品引擎** — 团队交付物 | 将 AI 产出的内容持久化为制品树，组合成可共享的仪表板，并稍后*刷新*。 | 积极开发中 |

它们共同回答了纯聊天工具无法回答的问题：
*"我和团队明天如何继续使用我们刚刚用 AI 创建的东西？"*

> **运行时边界。** Nango 作为**单个长期运行的 Node 进程**运行
> （Docker / VM / 裸机），面向个人和小团队使用。繁重或
> 分布式代理工作委托给外部平台；Nango 保持精简，
> 始终掌握在团队手中。

---

## 支柱 1 — AI 引擎

Nango 的 AI 端。两种将智能引入工作空间的互补方式，
以及围绕它们的一切实用功能。

### 1.1 两种接入智能的方式

Nango 区分**代理平台**（你连接的成熟多代理系统）和
**LLM 提供商**（你在其上构建代理的原始模型端点）。
它们服务于不同的目的，设计上保持分离。

**连接外部代理平台** &nbsp;·&nbsp; *当前支持：*

| 平台 | 风格 |
|---|---|
| **[agno](https://github.com/agno-agi/agno)** | 基于 Python 的代理框架 |
| **[Mastra](https://mastra.ai)** | TypeScript 代理框架 |
| **[Dify](https://dify.ai)** | LLM 应用平台 |
| **OpenAI 兼容的代理平台** | FastGPT、AnythingLLM、Coze 等（每个平台专用适配器） |

列表故意保持简短。每个平台都有自己的请求形状和
会话模型，因此 Nango 为每个平台提供专用适配器，而不是
通用桥接器。每个适配器将上游 REST / SSE 流实时规范化为
**AG-UI** 协议——浏览器只能看到 AG-UI，
密钥永远不会离开服务器。欢迎通过 PR 贡献新适配器。

**在 LLM 提供商之上构建自己的代理** &nbsp;·&nbsp; *广泛覆盖提供商：*

| 类别 | 提供商 |
|---|---|
| **托管 LLM API** | OpenAI、DeepSeek、Groq、xAI、OpenRouter 以及任何 OpenAI 兼容端点 |
| **自托管 / 本地** | **Ollama**、**vLLM** 以及任何 OpenAI 兼容的本地服务器 |

这些配置为凭据，由你在 Nango UI 中创建的**内置代理**使用：
选择模型、编写系统提示词、附加工具，完成。当你拥有*原始模型端点*
（托管 API、你自己托管的模型、本地 Ollama）而不是完整的
代理平台时，这是正确的路径。

### 1.2 你可以用它构建什么

| 能力 | 详情 |
|---|---|
| **主管代理** | 每个用户可以有一个内置代理标记为*主管*——即 Nango 本身。其他代理成为其可委派的专业人员。四种编排模式涵盖同步调用、工具风格路由、对话交接和即发即弃的异步工作。 |
| **工具与扩展** | **MCP 服务器**、**技能**（可重用、自文档化能力）、**数据源**（受治理的 SQL 访问）和 **SSH** 服务器的顶级绑定，以及用于代码、图表和数据集操作的小型内置工具集。将任何 REST API 包装为 MCP 服务器以暴露给代理。 |
| **受治理的数据访问** | 数据源行 = "代理可以在此策略下读取此数据库"（只读标志、表允许/拒绝列表）。SQL 在触及缓存之前被解析和验证，然后结果作为列式文件缓存以供廉价重读。 |
| **调度与异步** | 一次性或重复调度在定时器上触发相同的代理。异步运行和计划触发会进入实时通知收件箱，以便团队看到他们离开时完成的内容。 |
| **统一聊天历史** | 内置和外部平台代理线程共享一个 Postgres 端的真实来源。刷新页面、切换代理、明天回来——你的对话仍然存在。 |
| **凭据与轮换** | 所有第三方密钥使用 AES-256-GCM 加密存储在密钥环上；活动密钥可零停机轮换。仅限管理员 CRUD。 |
| **协作角色** | 三种角色：**admin**（一切）、**editor**（AI 资源构建者）、**user**（消费者）。首次注册自动成为管理员；后续注册默认为 `user`。仅软删除；资源所有权得以保留。 |
| **可观察性与取证** | 自动密钥脱敏的结构化日志；管理员运行取证页面显示每次运行的完整调度树和事件时间线。可选 LLM 调用的 Langfuse 跟踪。 |

---

## 支柱 2 — 制品管理与重新创建

这是产品的*团队*部分：将 AI 输出转化为共享的、
鲜活的交付物。**部分实现且积极演进中。**

| 能力 | 提供什么 | 状态 |
|---|---|---|
| **制品库** | 按类型系统类别（图表、仪表板、代码、图像、HTML、PPT、报告）下的文件夹树库。行为类似于 AI 输出的文件系统。 | 已实现 |
| **从聊天保存** | 一键将对话中的任何图表、代码或报告保存到制品库，并追溯来源到聊天轮次。 | 已实现 |
| **仪表板组合** | 将多个制品组合成网格布局仪表板页面。通过可见性控制发布给团队。 | 进行中 |
| **工作流支持的刷新** | 每个可保存制品都与冻结的工作流配对——对其数据生成方式的捕获、可重放描述。刷新针对实时数据重新运行工作流：相同的制品，新的数字。 | 进行中 |
| **交互式过滤器** | 保存图表上的时间范围、维度切片、参数提示——无需回到代理。 | 计划中 |
| **丰富的渲染器** | 顶级图表渲染器、分页 PPT、报告渲染、沙盒化 HTML 嵌入。 | 计划中（当前为占位符） |
| **重新创建流程** | 在编辑器中打开任何制品，要求 AI 调整它（"更改为月度桶"），保存为新版本或分支。 | 计划中 |

单个工作流可以驱动**许多**制品（1 对 N），因此相同的
底层查询可以作为一个仪表板上的图表、另一个仪表板上的表格，
以及通过第三个导出的每周报告——全部由一个
可刷新的数据管道驱动。

---

## 与 Nango 共度一天 — 典型的数据分析流程

1. **管理员**设置数据源（Postgres / MySQL / Vertica / …），使用
   只读凭据和表允许列表。
2. **用户**询问 Nango：*"上周华东订单趋势如何？"*
3. Nango 路由任务（或自行处理），获取数据，绘制
   结果图表，并在聊天中内联显示。
4. 用户喜欢它——**保存**将图表捕获为制品并冻结
   其背后的工作流。
5. 用户将其放到**仪表板**上，点击**发布**——队友在
   稳定 URL 上看到它。
6. 仪表板自动刷新（或按计划）；团队成员可以
   应用过滤器；可以要求 Nango *修改*底层工作流
   而无需重新开始。
7. 每次运行都是持久的和可重放的，用于管理员审计和重放。

---

## 快速开始（Docker）

运行 Nango 的最快路径。仅需要 **Docker**（≥ 20.10）和
**Docker Compose** v2。

### 1. 克隆

```bash
git clone <your-fork-or-this-repo>.git
cd nango
```

### 2. 创建 `.env`

```bash
cp .env.example .env
```

在应用启动之前，你**必须**设置两个加密变量：

```bash
# 生成一个 32 字节的十六进制密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → 例如 c60f15a2dd1bdecd92bca72728ec8104c0570832e9d8827592bfa865ba35fc5a
```

将其放入 `.env`：

```dotenv
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k1
CREDENTIAL_ENCRYPTION_KEYRING=k1=<你刚刚生成的64位十六进制>

# 还要设置一个长随机会话密钥（32+ 字符）
BETTER_AUTH_SECRET=<另一个长随机字符串>
NO_HTTPS=1
```

> **更改端口**——仅设置 `APP_PORT`（默认 `9300`）。认证
> URL 自动从中派生。仅当你使用反向代理或自定义
> 域名前置 Nango 时才直接覆盖 `BETTER_AUTH_URL`
> （例如 `BETTER_AUTH_URL=https://nango.example.com`）。

> 为什么需要两个密钥？`BETTER_AUTH_SECRET` 签署用户会话；密钥环
> 加密存储在数据库中的**第三方凭据**。它们
> 故意分开，以便泄露一个不会损害另一个。

### 3. 启动所有内容

从 GitHub Container Registry 拉取发布的多架构镜像：

```bash
docker compose up -d
```

或从源代码本地构建（开发者模式）：

```bash
docker compose up -d --build
```

要升级到更新的发布镜像：

```bash
docker compose pull && docker compose up -d
```

这将启动：

| 容器 | 用途 | 端口 |
|---|---|---|
| `nango-app` | Nango Next.js 服务器（启动时自动运行 DB 迁移） | `9300` |
| `nango-db`  | PostgreSQL 18 | `5433` → `5432` |

然后打开 **http://localhost:9300**。

**第一个注册的用户自动成为管理员**。从
管理员用户管理页面，你可以将队友提升为 `editor`
（资源构建者）或保持为 `user`（消费者）。

### 4. 管理堆栈

```bash
docker compose logs -f nango-app   # 尾随应用日志
docker compose down                # 停止所有内容（数据保留）
docker compose down -v             # 停止并擦除 DB 卷
```

兼容 **Podman**：在每个命令中将 `docker` 替换为 `podman`。

---

## 开发设置

用于贡献或针对热重载开发服务器运行。

### 先决条件

| 工具 | 版本 |
|---|---|
| Node.js | **≥ 24** (LTS) |
| pnpm    | **10.32.1**（通过 `packageManager` 固定；`corepack enable` 足够） |
| Docker  | 需要用于捆绑的 Postgres **以及**代码执行工具使用的 Python 沙盒镜像 |
| PostgreSQL | 18（或使用捆绑的 `pnpm docker:db`） |

### 运行它

```bash
corepack enable          # 从 package.json 获取固定的 pnpm
pnpm install

cp .env.example .env     # 设置 CREDENTIAL_ENCRYPTION_KEYRING、
                         # CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID
                         # 和 BETTER_AUTH_SECRET — 见上面的快速开始

pnpm docker:db           # localhost:5433 上的 Postgres 18
pnpm db:migrate          # 应用架构

pnpm dev                 # http://localhost:9300 上的 Next.js with Turbopack
```

如果你指向现有的 Postgres 而不是捆绑的 Postgres，设置
`POSTGRES_URL`（或离散的 `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` 变量）。

所有其他脚本（lint、test、type-check、db 工具、沙盒镜像构建、
docker compose 助手）都在 [`package.json`](package.json) 中——运行
`pnpm run` 列出它们。

---

## 架构概览

![Nango 架构图](docs/diagrams/architecture-diagram.png)

> 来源：[`docs/diagrams/architecture-diagram.html`](docs/diagrams/architecture-diagram.html) —
> 在浏览器中打开以获取具有 PNG / PDF 导出的交互式视图。
> 完整设计说明位于 [`docs/`](docs) 下。

---

## 文档

长篇设计说明、子系统参考和架构决策
位于 [`docs/`](docs) 下。从 `docs/architecture.md` 开始获取
全系统视图，然后深入了解你关心的子系统。

---

## 贡献

欢迎贡献。在打开 PR 之前：

1. 浏览 [`docs/`](docs) 下与你接触的子系统相关的设计说明。
2. 运行 lint、type-check 和测试（见 `package.json`）。
3. 对于架构更改，生成 Drizzle 迁移并提交**两者**
   SQL 文件和快照。

---

## 许可证

[MIT](LICENSE) © Nango 贡献者。

<p align="right"><sub>Nango 故意保持小众、有主见且团队导向。我们希望它让你的 AI 感觉像一个同事，而不是自动售货机。</sub></p>
