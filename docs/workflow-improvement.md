# Workflow v2：面向生成物的轻量数据 DAG

> 状态：**最终目标方案，主体尚未实现**。本文替代此前的 Spec v2 / Phase 0–4 改进方案，不代表当前代码已符合这些契约。分阶段实施计划见 §12（M0–M4），当前已落地的前置工作与文件级改造落点见 §13。
>
> 产品未上线，旧 Artifact、Workflow 和相关测试数据可以清空；不建设旧 Spec 兼容层。本次文档更新不执行清库、不修改运行代码。实施时使用 Drizzle 生成迁移并同时维护 SQL 与 meta，不能手改历史快照。
>
> **审查修订（待原作者确认）**：本版根据对当前代码的审查做了修订，修订项见 §1.8，正文中以 **[RV-n]** 标注；被替换的原文以删除线保留。RV 修订与原文冲突时，以 RV 文本为提议决定。

## 1. 定位、理念、原则与取舍

本节说明“为什么这样设计”。后续各节的规则都可以追溯到这里的定位、理念和原则；遇到看起来过严或过简的规则时，先回到本节。

### 1.1 定位

Nango 为个人或小团队内部共享协作提供数据分析工作空间。Workflow 是 Artifact 背后的可重复执行的数据生产方式，不是通用自动化平台，也不是另一个 Agent 平台。

当前业务重点是数据分析。典型流程是：

1. 从一个或多个数据源提取数据，在数据库内完成基本的过滤、聚合；
2. 把数据交给 sandbox 中运行的分析代码。代码由 Agent 根据用户的分析需求生成，用于异常检测、趋势预测、根因分析等，可能分多步完成；发现异常时，可能还要获取额外数据做进一步分析；
3. 根据分析结果生成图表；
4. 最终形成报告：仪表板、HTML 报告或 Slides。

当前的基本目标是“分析后生成可刷新的 Chart”，**Chart 优先**。用 Chart 在 Artifact 中组合 Dashboard、在 Agent 辅助下构建复杂报告是后续计划；HTML 报告和 Slides 的数据驱动是远期扩展选项，现在不为它们做专门设计。**它们都依赖一个稳定、可组合的 Workflow 引擎，所以现阶段最重要的是把引擎和节点定义做扎实。**

Nango 保持单个长运行 Node.js 进程。数据源适配器、共享 Parquet、外部 sandbox、现有 runner 事件记录可以继续使用；不引入分布式 worker、队列平台、持久化恢复引擎或 serverless 部署。

初期链路（M1 交付）：

```text
              Filter / Workflow 参数（日期范围、地区、阈值……）
                 │                         │
                 ↓                         ↓
数据源 A ─ SQL（参数化过滤/聚合）─┐
数据源 B ─ SQL（参数化过滤/聚合）─┼→ Code（Python 分析，可接收参数）→ Chart
           ……                    ─┘
```

参数和 Filter 是初期的基本能力：同一个 Chart 换一个日期范围或地区就能刷新，是“可刷新的生成物”最常见的用法。

完整链路（逐步扩展到）：

```text
用户需求 → Agent 探索数据、编写 SQL/Python → 聊天中得到生成物
                                         ↓ 保存与提取
                                   声明式 WorkflowSpec
                                         ↓ 用户刷新
Filter 输入 → SQL 源端过滤/聚合 → 多步 Sandbox 分析 → Chart → 本次预览
                 ↑                     ↓                       ↓ 用户保存快照
                 └── 分析结果驱动补充查询 ┘                  ArtifactSnapshot
```

“分析结果驱动补充查询”是预先定义的 DAG 分支，例如异常客户 ID → 查询另一数据源的工单 → 根因统计。**执行期间不让 LLM 临时决定下一步，不动态扩展图。** 新的分析思路通过重新探索或编辑 Spec 引入。

**[RV-1] “在数据库内完成过滤、聚合”是目标，当前代码不保证。** Postgres/MySQL/MariaDB 的提取都经 DuckDB 内存实例 `ATTACH` 源库后执行 `COPY (<SQL>) TO parquet`：SQL 按 DuckDB 方言执行，GROUP BY/JOIN 在 DuckDB 本地完成，源端最多获得列裁剪和部分过滤下推（随扩展与版本不同）。大表可能被整表拉回再聚合。是否保留这条路径、还是改为直通源库执行，由 M0.2 的实测与决策确定（§6.2、§12.3）。

### 1.2 为什么要重构

v1 的问题是结构性的，补丁不能根治：

- **提取没有可信边界。** 保存时把产物之前的成功调用都当作工作流；跨轮次排序依赖每轮从零开始的 `seq`；数据血缘主要靠结果值相等来猜。
- **完整数据与预览混在一起。** `rows` 有时是全部数据，有时是截断预览；截断数据经过一次 Code 后，可能被当成完整结果画图。
- **数据流转能力不足。** 大数据只能从 SQL 流向 Code 一跳，Code 不能产出供下游使用的大表；SQL 不能使用上游的分析结果，无法表达“发现异常 → 补充查询”。
- **执行语义耦合。** 一个 `forceFresh` 同时控制缓存、运行记录、Agent 派发和快照写入；Refresh 与 Save Snapshot 的语义混杂，快照内容由浏览器提交。
- **定义分散且不一致。** 节点 schema、执行器、聊天工具参数在多处各写一份；Code 结果可以从 Markdown 表格或纯文本回退解析，退出码正常不等于数据正确。
- **节点面向“重放工具调用”，而不是“生产数据”。** agent、tool、noop 等节点让静态作品也挂上一张假图，刷新也不代表真正获取了新数据。

### 1.3 基本理念

1. **建设面向生成物的轻量数据 DAG。**
   - **面向生成物**：Workflow 存在的意义是可重复地生产某个生成物（现在是 Chart，以后是 Dashboard 和报告的数据来源），而不是记录一段聊天或重放一串工具调用。
   - **轻量**：单进程、进程内调度，不引入分布式 worker、队列、持久化恢复或资产平台。
   - **数据 DAG**：节点是数据的获取与变换步骤，边是数据依赖；它不是任务自动化平台，也不承载控制流。
2. **Agent 负责探索和编写，执行器负责重复运行。** LLM 在聊天中探索数据，写出 SQL 和 Python；保存后，执行器脱离 LLM 确定性地运行，不需要每次让 LLM 参与。需要新的分析思路时，回到聊天或编辑 Spec。
3. **给 LLM 看的数据，与在节点间流转的数据分开。** 工具只返回 schema 和少量预览，是为了避免上下文爆炸，同时给 LLM 足够信息去写分析代码。提取为 Workflow 后不再受这个限制：小数据直接传递完整结果；大数据仍通过共享 Parquet 引用传递，因为即使不涉及 LLM，大数据流转也需要数据共享。
4. **一份契约，多方使用。** WorkflowSpec 是人、Agent、提取器共同读写的契约；字段、节点和输出 schema 只定义一次，聊天工具和工作流节点复用同一业务服务。
5. **为复杂分析打基础，而不是现在就实现复杂功能。** 初期只实现简单场景“多数据源 → Code → Chart，支持参数与 Filter”，但数据契约（TableData、引用、参数绑定）从一开始就按可扩展的方式定义，使多步大数据分析、分析结果驱动的补充查询能在后续里程碑中直接加上，不必推翻重来；循环、条件分支、Agent 节点、Dashboard、HTML 报告、Slides 更晚，按需在同一套契约上扩展。**少节点、强契约**比多节点、弱契约更能支撑后续扩展。
6. **务实、渐进。** 先让最常见的场景稳定可用，再逐步支持更多场景和特性。只为当前里程碑真正需要的能力写实现；后续能力只需在契约上留出位置，不提前实现，也不为假想需求做通用化设计。

### 1.4 设计原则

| 原则 | 含义 | 主要体现 |
|---|---|---|
| 不考虑向后兼容 | 产品未上线，旧数据都是测试数据，可以清空；不建兼容层，旧契约有缺陷就直接改，历史数据不能成为重构的包袱 | §8.3、§12 M1.1 |
| 抓根本问题 | 优先解决数据契约、执行语义、提取可信度等结构问题；暂不做拖拽编辑等体验增强，也不增加不必要的节点 | §1.6、§15 |
| 务实、不过度工程化 | 先做简单场景并做稳，再渐进扩展；不为远期需求提前实现，不追求理论完备 | §1.5、§12 |
| Chart 优先 | 初期唯一的动态生成物是 Chart；HTML、Slides 先作为静态作品保存，数据驱动是后续扩展 | §1.6 |
| 正确优先于“看起来能用” | 无法确认的血缘、被截断的数据、尚未实现的能力都要明确报错或标记，不降级伪装 | §3.3、§7.2、§9.3 |
| 显式优于推断 | 数据依赖由引用声明；提取时的值匹配只能作为候选，不作为证据 | §6.1、§9.3 |
| 简单、对 Agent 友好 | 三类节点、整字段引用、没有表达式语言；Agent 容易理解和生成，也便于从聊天中提取 | §5.0、§5.3 |
| 分层与职责单一 | 定义、执行计划、运行结果、快照分离；执行器只负责计算，不决定保存 | §2 |
| 保存由用户决定 | Refresh 只获取新数据并预览；快照只在用户明确保存时写入，且保存的就是用户刚看到的结果 | §8 |
| 可验证 | 编译期静态检查、fixture 样例测试、真实环境集成测试三层验证 | §10.2、§12.8 |
| 守住安全与运行边界 | 凭证只留在服务端；sandbox 不联网、不拿凭证；保持单进程运行边界 | §1.7、§4 |
| 分阶段交付 | 每个里程碑结束时系统都可运行、可验收；后一阶段只扩展、不推翻 | §12 |

### 1.5 目标与演进路线

**初期目标（M1）：简单场景做稳。**

1. 多数据源 → Code → Chart 可以从聊天中提取、保存，并脱离 LLM 独立刷新。
2. 支持 Workflow 参数与 Filter：在 `input_schema` 中声明参数（标量、枚举、日期、多选列表），安全绑定到 SQL 值参数和 Code 参数；Artifact 上用 Filter 面板修改参数并刷新。
3. 节点定义简洁，Agent 与人工编辑同一份作者态 JSON。
4. 小数据直接传递完整 JSON；大的 SQL 结果通过 dataset 引用交给 Code。
5. 严格区分完整结果和预览，不能把截断数据包装成完整分析。
6. Refresh 按当前参数重新获取源数据，不自动保存快照；Save Snapshot 保存用户刚看到的那次结果及其参数，不重新计算。
7. 无法确认血缘时保存作品并报告诊断，不伪造可执行图。
8. 用 fixture 样例和真实执行验证转换逻辑与端到端行为。

**近期扩展（M2–M4）：更复杂的分析场景。** 多步 Code 之间传递大中间表（M2）；分析结果驱动补充查询，以及参数能力增强（M3）；更方便的编辑与提取（M4）。

**远期选项（按需，不在本计划内）：** Chart 组合成 Dashboard；HTML 报告、Slides 的数据驱动；Agent 辅助生成和提取 Workflow；条件、循环等更复杂的流程结构。

每一步都在前一步稳定后再开始；远期选项只要求现有契约不阻碍它们，不要求现在为它们设计实现。

### 1.6 首版范围

- 三种可执行节点：`sql`、`code`、`chart`。
- `code` 首版只要求 Python；JavaScript 工作流节点、通用 MCP/tool 节点和 Agent 节点后续按需扩展。现有聊天工具能力不因此整体删除，但不能自动转成不受支持的 v2 节点。
- **[RV-9] 这是有意的功能回退。** v1 已支持 MCP tool 节点（执行时从 MCP 连接池借出 provider）、agent 节点、JavaScript 代码和 `code_file`。v2 之后，基于 MCP/REST API、SSH、Agent 输出生成的图表只能保存为静态作品，提取报告须给出明确原因（§9.3 映射表）。
- 唯一的动态终端是 ECharts Chart。HTML、Slides、Image 等继续作为静态生成物保存，本计划不为它们设计数据绑定；将来需要时复用同一数据 DAG 增加终端节点，而不是按文件类型另做引擎。
- 暂不做循环、条件节点、子流程、人工审批、自由拖拽编辑、Dashboard 产品功能或 AI 辅助改图。
- 不涉及 A2A。运行内核不依赖 LLM；未来结构化 Agent 节点是单独的能力设计。

节点少不等于只能处理简单流程。SQL、Python、参数绑定和多分支 DAG 已能表达现阶段大多数分析任务。

### 1.7 共享与基本边界

共享数据缓存不按用户隔离，以适应可信团队的复用需求。继续遵守已有服务端角色/API 权限、数据源查询策略与凭证加密规则；不在本轮重新设计细粒度协作权限。

数据库连接、凭证、SQL 策略留在服务端数据源层。Sandbox 不获得数据库凭证，也不直接联网补充数据；补充查询必须表现为 SQL 节点。输入表只读，代码输出写入独立暂存区。

**[RV-2]** “Sandbox 不联网”目前**没有被配置保证**：`docker/dify-sandbox/config.yaml` 为 `enable_network: true`，现有拦截只有静态扫描里的正则（可绕过）。M1 必须把它改为 `false`，并以集成测试证明代码联网失败；在此之前本节是目标，不是现状。

### 1.8 审查修订台账（待原作者确认）

本版对照当前代码（`data-sources/duckdb-extension.server.ts`、`policy.ts`、`cache.ts`、`sandbox/adapters/service/adapter.server.ts`、`sandbox/output.ts`、`sandbox/code-ast-scan.ts`、`docker/dify-sandbox/config.yaml`、`artifacts/*`、`outcomes/runtime-tools.ts`、`db/schema.ts`、`runner/admission.ts`）审查后修订。§1–§3 的定位、理念和数据契约不变；修订集中在与代码事实不符的前提、缺失的设计和验证手段。

| ID | 修订 | 原因（代码事实） | 涉及章节 |
|---|---|---|---|
| **RV-1** | SQL 的**执行方言与参数策略**改为 M0.2 的架构决策：(a) 维持 DuckDB 方言、用 DuckDB 机制绑定；或 (b) 改用 `postgres_query()` / `mysql_query()` 直通源库、参数走值位置 literal renderer。策略解析器必须与执行方言一致；“源端过滤/聚合”需实测下推 | Postgres/MySQL/MariaDB 都经 DuckDB `ATTACH` + `COPY (<SQL>) TO parquet` 执行，SQL 实际是 DuckDB 方言，COPY 不接受绑定参数；策略却按 PG/MySQL 方言解析；经 scanner 时 GROUP BY/JOIN 在 DuckDB 本地执行 | §1.1、§6.2、§12.3、§13.1 |
| **RV-2** | Sandbox 关闭网络（`enable_network: false`）；Code 节点 timeout 上限对齐 dify `worker_timeout`（当前 60 秒） | 配置为 `enable_network: true`；`worker_timeout: 60` 是服务端硬上限，而方案默认 120 秒、chat 工具允许 300 秒 | §1.7、§4.1、§5.1、§7.3、§12 |
| **RV-3** | Sandbox 通道按实际能力设计：inline 输入由 Node 物化到共享缓存的只读 generation 目录；适配器返回**原始** stdout，由调用方各自截断；静态扫描移到共享 Code 服务，两条路径都执行并对注入名字加白名单 | dify 接口只收 `{language, code}`（`inputFiles` 被忽略）；stdout 在 `adapter.run()` 内被截到 20k 并掩码；静态扫描只在 chat 路径执行，“未定义名”名单不含 `nango`/`params`，`compile\s*\(` 误伤 `re.compile(` | §4.2、§4.3、§12.4 |
| **RV-4** | Workflow 自有 dataset 的**不可变 generation 发布提前到 M1**，并增加 generation GC | M1.5 已发布 >1000 行的 dataset，但 `commitWriteSlot` 的 rm+rename 安全替换原排在 M2.4；缓存没有任何过期清理，按 run 生成目录会无限增长 | §3.2、§4.3、§12.4、§12.5 |
| **RV-5** | 新增 §8.4 **权限与执行身份**：谁能 Apply/Refresh、Save Snapshot、编辑；刷新使用**发起人自己**的数据源授权；runId 必须属于保存者；删除 `workflow.visibility`，以 Artifact 为准 | Refresh 路由 `withSession` 任何角色可调且按查看者可见数据源执行；Snapshot 仅作者；`artifact.visibility` 与 `workflow.visibility` 两套独立字段 | §8.2、§8.3、§8.4、§12.4 |
| **RV-6** | 聊天图表 `data_ref` 采用**句柄旁路**：工具结果只回句柄与摘要，UI 按句柄向服务端取完整 option | 当前 `tool_call_result` 同时用于 UI 渲染和 LLM 历史回放，只有一个通道；放完整 option 会撑爆上下文，不放则 UI 拿不到完整数据 | §9.1、§12.4 |
| **RV-7** | Refresh/Apply **异步化**：立即返回 runId，进度走 `/api/runs/stream`，结果按 runId 读取；支持显式取消；同一用户同一 Artifact 的新 Apply 取消旧 run；进程级 Workflow 并发上限 | Refresh 在 HTTP 请求内同步执行（120 秒可能被反向代理切断）；`executeWorkflow` 的 `abortController` 从未被 abort；连续 Apply 存在旧结果晚到覆盖的竞态 | §6.3、§7.3、§8.1、§8.2、§12.4 |
| **RV-8** | RunResult 终端结果**持久化到小表** `workflow_run_result`（带过期时间），替代纯内存 Map | 32 MB / 1 MB 只能容纳约 30 个结果，共享场景下保存前易被淘汰；重启全部丢失 | §8.2、§8.3、§12.4 |
| **RV-9** | 明确被移除能力与现存结构：MCP tool / agent / JavaScript / `code_file` 节点移除是有意的功能回退；新增“chat 工具 → v2 节点”映射表（含 skills 工具）；清库与删除事务处理已存在的 `dashboard_artifact`（RESTRICT）；带 Workflow 的 Slides 按静态作品合并保存 | v1 支持 MCP tool / agent 节点；`run_skill_sql_script` 与 `extract_dataset_by_sql` 共用提取服务；Dashboard 表已存在；存在快照驱动的 Slide + Workflow | §1.6、§8.3、§9.3、§12.4、§15 |
| **RV-10** | M0 每一步增加 go/no-go 标准与失败时的退路 | 原 M0 只要求“写出书面结论” | §12.3 |
| **RV-11** | 验证补充：录制事件 fixture 语料作为提取器确定性回归；资源声明的内存基线测试；compose 集成测试环境与 CI；安全、并发、取消验收；“无 LLM 调用”的断言方式；工具描述/prompt 更新列为 M1 任务 | 原验收依赖真实 LLM 与真实环境，缺少确定性回归与可测的资源/安全/并发标准 | §10.2、§12.4、§12.8 |

## 2. 四个对象与架构分层

| 对象 | 内容与责任 | 是否持久化 |
|---|---|---|
| `WorkflowSpec` | 人和 Agent 可读写的声明式定义：节点、绑定、输入 schema、输出映射 | `workflow.spec` |
| `ExecutionPlan` | 已解析资源、数据绑定、依赖、执行范围和运行期验证器 | 仅单次编译/运行内存 |
| `RunResult` | 一次执行的输入、Spec hash、状态、输出、时间和诊断 | 运行记录持久化；完整可渲染结果短期保存在服务端结果存储 |
| `ArtifactSnapshot` | 用户明确保存的某次成功结果，或聊天/人工静态作品 | Artifact 持久化 |

```text
Chat 提取器 / 简单编辑器
          ↓
   WorkflowSpec + 输入定义
          ↓ compile / lint
       ExecutionPlan
          ↓ execute(resolvedInputs, RunContext)
  SQL Service / Sandbox Service / Chart Assembler
          ↓
        RunResult
          ↓ Artifact 服务决定展示或保存
     预览 / ArtifactSnapshot
```

### 2.1 模块职责

- **Spec/Compiler**：结构校验、引用解析、类型检查、资源解析、闭包计算、SQL 模板编译。不能调用 LLM，不能为校验自动执行用户 SQL/Python。
- **NodeRegistry**：节点输入/输出契约、引用规则、执行器、诊断与重试属性的定义中心。
- **Executor**：只负责图执行、节点状态、取消、超时和结果，不写 Artifact 快照。
- **Data layer**：表数据存取、完整性、schema、内联预算、Parquet 发布与读取；复用现有数据源/缓存能力，不建设通用资产平台。
- **Artifact service**：作品读取、Workflow 绑定、刷新结果交接、显式保存快照、删除生命周期。
- **Chat tool projection**：调用同一业务服务，但只向 LLM 返回 schema、少量预览与引用标识。

`reason` 可以用于运行审计，`freshness` 用于数据获取；`persistSnapshot` 不进入纯执行器。不要再用一个 `forceFresh` 同时决定缓存、记录事件、Agent 派发和快照保存。

## 3. 统一数据契约

### 3.1 服务执行结果与 LLM 工具返回不是同一份数据

底层服务先产生完整的规范结果，再按消费者投影：

| 消费者 | 得到什么 |
|---|---|
| Chat LLM | 表引用、schema、行数、少量 preview、简短诊断 |
| Workflow executor | 完整小结果，或指向完整大结果的受控表引用 |
| Chart | 预算内的完整行集，禁止把 preview 当数据 |
| 运行事件 | 有界摘要、来源、计数、耗时、错误，不是完整结果备份 |
| Artifact | 已验证的终端可渲染结果 |

SQL/Code 节点直接调用共享服务，不再调用经过 LLM 预览限流的聊天工具。增大 Workflow 的 inline 预算不会增大 LLM 上下文。

### 3.2 TableData：同一逻辑接口，两种物理表示

`TableData` 是运行期受控值，作者态 Spec 不写文件路径、dataset ID 或实际行数据。

| 字段 | 语义 |
|---|---|
| `kind` | 固定为 `table` |
| `schema` | 统一列定义：名称、规范类型、nullable；空结果也保留 schema |
| `row_count` | 此次完整计算结果的行数 |
| `complete` | 首版可发布给下游的 TableData 必须为 `true` |
| `storage` | `inline` 或 `dataset` |
| `rows` | 仅 inline 分支存在，包含全部行 |
| `dataset_id` | 仅 dataset 分支存在，由数据层签发并解析为完整 Parquet |
| `provenance` | 生产 run/node/invocation、数据源提取时间或上游来源 |

`inline` 与 `dataset` 是严格互斥的结构分支。所有权威元数据由服务端/受控发布流程生成，不能靠脚本在 JSON 中声称 `complete: true`。

- **小结果**：行数和序列化字节均在预算内时，直接传完整 JSON；不强制为每一步落盘。
- **大结果**：保持或物化为 Parquet，传 dataset 引用；不要先把全量数据读入 Node.js 再判断是否过大。**[RV-4]** Workflow 产出的 dataset 从 M1 起写入不可变 generation 目录，不复用 Chat 的友好名称 slot（§4.3）。
- SQL 已通过流式提取写成 Parquet时，可以保留该文件，同时为小结果提供完整 inline 投影；不需要为了“必须 inline”改写所有适配器。
- 下游按 `TableData` 类型消费，不按“只允许 SQL 生产 dataset”判断。因此 SQL → Code → Code 使用相同输入接口。
- Code 可以有一个表输出 `data` 和一个有界结构化输出 `values`。更多命名表输出以后再扩展，不在首版引入复杂端口系统。

### 3.3 PreviewData 与完整性传播

`PreviewData` 是展示投影，不是可执行端口。包含 `rows`、`returned_rows`、`total_rows`、`truncated`、schema 摘要；Chart、Code 的表输入和 SQL 参数绑定不得引用它。

必须满足：

1. 数据源硬行数/字节上限触发时，提取失败，不发布被截断的 TableData。用户 SQL 显式 `LIMIT` 的结果可视为该查询的完整结果，两者不能混淆。
2. Chat 返回前 5 行不影响其 dataset 所代表的完整结果；提取 Workflow 时应绑定完整表，而非复制这 5 行。
3. `SQL preview → Code 求和 → Chart` 不能通过一次 Code 输出就被“洗成完整”。预览在运行期不可绑定，从源头阻断这条路径。
4. Code 输出只接受完整结果，不能静默截断 stdout、丢弃尾部行后继续成功；过大则发布 dataset，或明确失败。
5. Code 对完整输入做过滤、聚合或明确的 top-N 后，产出的全部结果可以是完整表。完整性证明的是没有被传输/预算机制静默截断，**不是证明分析算法或统计方法正确**；后者由样例测试验证。
6. 未确认来源的 LLM 手工数据、Markdown 表格或从日志中猜出的 JSON，不能冒充规范的执行结果。

### 3.4 统一 schema 与预算

SQL 与 Code 使用同一 `TableSchema`。不要继续混用 SQL 的 `{ columns: [...] }` 与 Code 的“首行推断字典”。首版类型只覆盖 string、boolean、integer、number、date、datetime，并明确 null 和空表的规则。超出 JS 安全整数范围的大整数和精确 decimal 首版按字符串传递并在 schema 中标注，不静默转换成失真的 number；完整的精确数值类型体系等有实际需要再加。

默认预算沿用或集中配置：

| 对象 | 默认界限 | 超限行为 |
|---|---|---|
| LLM 表预览 | 默认 5 行，最多 200 行 / 50 KB | 只缩小预览，明确 truncated，完整表不受影响 |
| Workflow inline 表 | 1000 行 / 1 MB | 改走 dataset，不缩小结果 |
| Code `values` | 64 KB，并受各字段 schema 的 maxItems/maxLength 限制 | 失败；不能截断用于后续查询的 ID 列表 |
| Chart 最终 option | 1 MB，且每个数据集都完整 | 超限失败，提示 SQL/Code 聚合 |
| Workflow 单个事件 | 64 KB 最终序列化上限 | 保留固定诊断字段和摘要；所有事件类型统一兜底 |

这些是不同预算，不能由 `row_limit` 一个字段统管。Code → Code、Code → SQL 的内联值也受预算控制，不能只检查 Chart 前一条边。

提取器的内存能力也必须按 provider 验证：当前部分适配路径会先在 Node.js 中缓冲原始结果。此类路径必须有实际生效的源端/驱动行数与字节限制，或改为流式提取；不能因最终写成 Parquet 就宣称全链路没有大结果堆内存开销。首版可明确限制这些 provider 的规模，不要求同时重写所有驱动。**[RV-11]** 已确认的此类路径：Vertica 适配器把全量结果读入 Node 堆后转 NDJSON 再写 Parquet，M1 必须对它设置实际生效的规模上限。DuckDB 路径的 `maxRows` 检查发生在 COPY 写完之后（不会截断，但大结果仍会先完整落盘）。这些声明以 §12.8 的内存基线测试验证。

## 4. Sandbox 与表数据存取边界

### 4.1 必须正视当前能力

当前 `ServiceSandboxAdapter` 主要发送代码、读取 stdout/stderr；共享数据挂载只读。`CodeOutputEnvelope.files` 不是可供另一节点重新打开的正式文件发布接口。现有 stdout 还经过显示用途的截断/掩码。

因此“Code 输出大型中间表供下一 Code 使用”**尚未由现有接口支持**。仅添加 `dataset_id` 类型不能完成这项能力。

**[RV-2/RV-3] 当前 sandbox 的实际约束**（设计必须以此为准）：

| 约束 | 事实 | 对本方案的影响 |
|---|---|---|
| 请求体 | dify 接口只接收 `{language, code}`；`SandboxInput.inputFiles` 在 service 适配器中被忽略（仅取第一个 `.py`/`.js` 当代码） | 进入 sandbox 的通道只有“代码字符串”和“共享缓存只读挂载”两条 |
| stdout | `adapter.run()` 内部就调用 `processStdout`：先做宿主路径掩码，再中段截断到 `sandbox.stdout_max_chars`（默认 20 000 字符） | 结构化结果帧在到达调用方之前已被破坏，必须改适配器接口 |
| 网络 | `config.yaml` 为 `enable_network: true` | 违反 §1.7，M1 改为 `false` |
| 服务端超时 | `worker_timeout: 60`；`max_workers: 10` | Code 节点有效 timeout 上限是 60 秒；并发 Code 执行受 10 个 worker 限制 |
| 静态扫描 | `scanCodeStatic` 只在 chat 的 `run_code_in_sandbox` 中执行；“未定义名”检查只认内置名单；`\bcompile\s*\(` 会误伤 `re.compile(` | 共享 Code 服务必须统一执行扫描，并把注入的 `nango`、`params` 加入白名单，修正误报 |

### 4.2 目标接口

Python 脚本获得固定的运行期绑定：

- `params`：此节点已解析且验证的有界参数。
- `nango.read_table(alias)`：返回完整输入表的 DataFrame，适合可放入 sandbox 内存的分析。
- `nango.dataset_path(alias)`：返回 sandbox 可读的 Parquet 路径，供 DuckDB 懒读/聚合；inline 输入需要时由适配器物化为临时输入文件。
- `nango.emit(data=..., values=..., message=...)`：恰好提交一次规范结果；`data` 可省略，`values` 默认空对象。

以上是**待实现的受控 wrapper/helper 契约**，不是宣称当前已经安装 `nango` Python 包。无需新增依赖平台；使用现有 pandas/pyarrow/DuckDB 能力实现即可。

**[RV-3] 实现方式（按 sandbox 实际通道）**：

- `nango` helper 以**代码前导（preamble）**注入，与现有 `params` 注入同一位置，由适配器只注入一次；不依赖镜像内安装的包。前导行数固定，诊断中的行号按偏移换算回用户代码行。
- **inline 输入不经代码字符串传递**：Node 在节点开始前把 inline 表写成 Parquet，放进共享缓存下本次 run 的只读 generation 目录（§4.3），`nango.read_table` / `nango.dataset_path` 读该文件。这样 1 MB 级的 inline 表不会撑大请求体，Chat 与 Workflow 走同一读取路径。
- 适配器返回**原始** stdout/stderr；显示截断和路径掩码移到调用方（Chat 投影、事件摘要）各自执行。M1 的结构化结果帧从原始 stdout 中解析。
- 静态扫描从 chat 工具移到共享 Code 服务，Chat 与 Workflow 都在执行前扫描；`nango`、`params`、`DATA_DIR` 加入已定义名单；`compile\s*\(` 规则收窄为不匹配 `re.compile(` 等属性调用。扫描是防误用的辅助手段，网络隔离由 `enable_network: false` 保证。

脚本按 alias 访问表，例如 `nango.read_table("sales")`，不写 Chat slot 名称或宿主路径。Code 不直接获得 Workflow 的全部输入；需要的 Filter 通过 `inputs.params` 显式绑定，这样 Chat 与 Workflow 使用同一段代码。

### 4.3 输出文件交接必须实际实现

基线方案：保留只读数据挂载，增加独立的固定挂载输出暂存根目录；每个 run/node/attempt 使用服务端分配的工作子目录。Sandbox helper 在该目录写入结构化结果 manifest 和必要的 Parquet，服务端在代码完成后导入并发布为 TableData。

- 输入缓存目录始终只读；不能为方便输出把整个共享缓存改为可写。
- 小表写入完整、有界的结构化结果；大表由 Python 直接写 Parquet，不经过全量 stdout JSON 或 Node.js 堆。
- 服务端校验 manifest、输出所属工作目录、文件实际存在、Parquet schema/行数和大小，再发布句柄；任意路径文本不能成为 dataset。
- `stdout/stderr` 是可截断的诊断日志；结构化结果通道独立，不能在解析机器结果之前执行显示截断或路径字符串替换。
- 超时、非零退出、缺失 manifest、半写文件或 schema 错误均不发布输出。重试使用新的 attempt 目录，失败目录可清理。
- 每次代码执行仍是独立进程；不依赖上次 Python 变量、工作目录残留或长期 notebook session。

分阶段落地（§12）：M1 中 Code 只产出 inline 结果，结构化结果经 stdout 中带边界标记的单个 JSON 帧传回，且必须在任何显示截断、掩码之前解析（**[RV-3]** 前提是适配器改为返回原始 stdout），受 inline 预算约束；M2 按 M0.1 的验证结论改为输出目录 + manifest，并开放 dataset 输出。两阶段的 `nango.emit` 调用方式不变，脚本无需修改。

该交接依赖实际 sandbox 容器路径/挂载配置，需要集成验证。如果所用部署不能提供受控的共享输出目录，适配器必须提供等效的文件导出能力；未实现前明确报 `DATASET_OUTPUT_UNSUPPORTED`，不能声称大数据多步链路已交付。

目录命名、缓存优化可以逐步打磨，但一次运行拿到的 dataset 在其消费者完成前不能被覆盖成另一份内容。最小实现使用不可变的物理 generation ID；Chat 的友好名称只是 alias。不存在按用户隔离的要求。

**[RV-4] Generation 发布与回收从 M1 开始。** M1 已有 SQL dataset 输出（超过 inline 预算）和 inline 输入物化，它们都写入 `<cache_root>/wf/<runId>/<nodeId>/<attempt>/`，只写一次、不重命名覆盖，因此不受 `commitWriteSlot` “先 rm 再 rename” 的影响；Chat 的友好名称 slot 改造仍留在 M2.4。当前缓存没有任何过期清理，所以同时引入 GC：

- 一个 generation 在“所属 run 仍在执行”或“仍被未过期的 `workflow_run_result` 引用”时不可删除。
- 其余 generation 超过 `workflow.dataset.gc_after_minutes`（默认 60）后删除；进程启动时先清理上次进程遗留的全部 run 目录（它们不可能再被读取）。
- GC 失败只记日志，不影响运行；磁盘占用上限由配置项给出，超限时新 run 以 `DATASET_STORAGE_FULL` 失败，而不是删除正在使用的数据。

## 5. WorkflowSpec v2 与三个节点

### 5.0 设计理由：让 Agent 易读、易写、易修

Spec 的第一读者和作者之一是 Agent（当前的 Chat 提取器输出、后续的 Agent 辅助生成/修复），其次才是人。以下规则都服务于“LLM 一次生成即可通过校验，出错时能按诊断定点修复”：

1. **JSON 是唯一契约。** JSON 是 LLM 最稳定的结构化输出形式；服务端可在运行前完整校验。图位置、面板状态等 UI 布局不进入 Spec。
2. **只向后引用。** 节点通过 `@nodes.<id>.<port>` 引用已经写过的上游节点，不使用 Node-RED 式的 `wires` 前向连线。LLM 逐 token 生成时无需预判尚未写出的节点；编译器根据引用推导拓扑顺序并拒绝环。
3. **严格的标签联合。** `type` 决定 `inputs` 的固定形状，Zod `.strict()` 解析，未知字段即报错，防止字段名漂移和“看起来合理”的臆造参数。
4. **引用只能整字段使用，没有表达式语言。** 不提供插值、算术、函数和下标，LLM 没有可以编造的语法。复杂选择与变换一律写成 Code 节点。
5. **少而正交的节点。** 三个节点分别对应“源端取数”“沙箱分析”“确定性装配”，Agent 只需记住三种形状；新能力优先通过参数和端口扩展，而不是增加近似的节点类型。
6. **稳定、可读的 ID 与端口名。** `sql_1`、`detect` 这类 ID 与固定端口 `data`、`values`、`option` 让引用自解释；删除节点不重新编号，已有引用不会悄悄改变指向。
7. **诊断面向修复。** lint 一次返回全部问题，每条带 JSON Pointer `path`、`code` 和 `hint`，Agent 或人可以一轮修完，而不是“改一处、报下一处”。
8. **Chat 与 Workflow 写同一段代码。** SQL 文本和 Python 代码在两种上下文中不需要改写（参数经 `params`、表经 alias 访问），提取时只需把字面值替换为引用。

### 5.1 作者态形式

Spec 保持短小的 JSON，Zod 严格解析，未知字段拒绝。保存作者态，不保存编译器生成的资源对象或实际数据。

| 顶层字段 | 契约 |
|---|---|
| `version` | 固定为 `2`；这是本次重写后的唯一格式 |
| `name`, `description?` | 显示信息 |
| `input_schema?` | Workflow 参数定义；无 `value` 字段 |
| `nodes` | 至少一个节点；ID 唯一 |
| `outputs` | 名称 → 合法节点输出引用；至少一个 |
| `execution?` | 默认并发 3、总 timeout 120 秒；有服务端硬上限 |

节点公共字段为 `id`、`type`、`inputs`，可选 `description`、`after`、`timeout_seconds`、`retries`。`code` 额外允许 `values_schema`，用于声明其结构化标量/列表输出。

`timeout_seconds` 为正整数，未设置时使用该节点类型的服务端默认值，并始终受本次 run 剩余 deadline 限制。**[RV-2]** Code 节点的有效上限还受 sandbox 服务端 `worker_timeout` 约束（当前 60 秒）：编译期拒绝超过该值的 `timeout_seconds`（`CODE_TIMEOUT_EXCEEDS_SANDBOX`），而不是让节点在远端被静默杀掉；需要更长分析时由管理员同时调大 `worker_timeout` 与对应配置。`retries` 形式为 `{ attempts, delay_seconds }`：attempts 表示首次尝试之后的最大重试次数，默认 0；delay_seconds 非负，固定间隔。指数退避等策略等确有需要再加。并发、次数、延迟和 timeout 均受配置中的硬上限约束；Spec 不能放宽运行环境限制。

- `id` 是稳定字符串，匹配 `^[a-z][a-z0-9_]{0,31}$`。
- 自动提取可生成 `sql_1`、`code_1`、`chart_1`，删除节点不重新编号。
- `nodes` 数组顺序仅服务阅读；不是执行顺序。Agent 推荐按拓扑顺序书写，但合法的前向引用不因数组排列被拒绝。
- 数据依赖从绑定推导；`after` 只表达额外的顺序依赖，不传数据。两者共同参与周期检测与执行闭包。
- 暂不提供 `on_failure=continue` 的模糊语义：所选输出闭包内任一必需节点失败，整次运行失败；其他输出分支不执行。

### 5.2 NodeRegistry

一个 NodeDefinition 集中定义：作者态 schema、运行期输入/输出 schema、可绑定字段、语义端口类型、执行器、资源解析器、错误与可重试属性、最小编辑器字段元数据。

共享 Zod 字段生成表单/说明；不能再由 registry、executor、工具输出类型各写一套不一致的 schema。编译检查“有这个输出且类型可用”；执行时在解析引用后检查实际输入，并验证实际输出。

#### 字段共享：工具参数与节点输入同源，但不是同一个对象

Chat 工具与 Workflow 节点调用同一业务服务，但边界不同：工具参数总是可立即执行的字面值，并带有 LLM 预览预算；节点输入可以携带引用，由引擎决定 inline 预算。因此两者**不共用一个 schema 对象**，而是由同一组字段片段组装，任何一边都不复制另一边的定义：

```ts
// src/lib/workflows/fields.ts（目标位置）：唯一的字段定义与说明文字
export const dataSourceNameField = z.string().min(1).describe("数据源名称，固定配置");
export const sqlTextField = z.string().min(1).describe("只读 SQL；值参数写作 @params.<name>");
export const pythonCodeField = z.string().min(1).describe("Python 代码；用 nango.read_table(alias) 读表，nango.emit(...) 提交结果");
export const paramsField = z.record(z.string(), z.unknown()).describe("有界 JSON 参数，代码中通过 params 读取");

// Chat 工具：字面值 + LLM 预览预算
const ExtractDatasetArgs = z.object({
  data_source_name: dataSourceNameField,
  sql_text: sqlTextField,
  params: paramsField.optional(),
  dataset_name: z.string().min(1),
  row_limit: z.number().int().min(0).max(200).default(5),
  force_refresh: z.boolean().default(false),
});

// Workflow 节点：可携带引用；无 row_limit、slot 名称或缓存开关
const SqlNodeInputs = z.object({
  data_source_name: dataSourceNameField,
  sql_text: sqlTextField,
  params: z.record(z.string(), bindable(z.unknown())).optional(),
}).strict();
```

- `bindable(schema)` 表示“字面值满足该 schema，或是一条在 §6.1 位置表中允许的整字段引用”；它是编译器可识别的标记，不是运行时的字符串插值。
- `.describe()` 文本同时用于工具描述、节点注册表说明和 Inspector 字段提示，保证 Agent 在 Chat 和编排两种上下文中看到同一份语义。
- 只在 Chat 侧存在的字段（`row_limit`、`dataset_name`、`force_refresh`）不进入节点；提取器不得复制它们（尤其不能把 Chat 的 `row_limit: 5` 带入节点）。
- 节点的输出 schema（`TableData`、`values`、`option`）同样只在注册表定义一次，Chat 工具的规范结果复用它，再由投影层生成 LLM 预览。
- 当前 `src/lib/data-sources/runtime-tools.ts` 的 `ExtractDatasetArgs` 与 `src/lib/sandbox/runtime-tools.ts` 的 `RunInSandboxArgs` 各自内联定义字段，节点注册表又另写一份；M1 把它们收敛到共享字段文件。

### 5.3 节点契约

| 节点 | `inputs` | 规范运行输出 |
|---|---|---|
| `sql` | `data_source_name`、`sql_text`、`params?` | `{ data: TableData }` |
| `code` | `language: "python"`、`code_text`、`tables?` alias→表引用、`params?` | `{ data: TableData 或 null, values: object, message?: string }` |
| `chart` | `renderer: "echarts"`、`config`、`dataset` 表引用或非空引用数组 | `{ option: object }` |

#### SQL

`data_source_name` 是固定配置，不允许 Filter 动态切换源。源适配器控制 SQL 方言、连接、策略、参数绑定与提取；节点不获取或转交凭证。

`params` 的值可以是常量、Workflow 输入或上游 `values` 字段。它不包含全量表或预览。SQL 节点无 Chat `row_limit`、slot 命名或返回 LLM 预览的配置。

#### Code

- `tables` 的值只接受 TableData 引用，无论生产者是 SQL 还是另一 Code。
- `params` 只接收有界 JSON；表、预览、文件路径不得经该字段绕过数据层。
- `values_schema` 是 `values` 对象的 JSON Schema，使用 §6.3 的标量/有界数组规则并允许有名的嵌套对象；首版不支持递归 `$ref` 或任意组合 schema。下游要引用其中字段时必须有明确 schema；Chat 提取可从规范结果生成候选 schema，但不能为未知/空数组臆测元素类型。
- 无 `values_schema` 时 `values` 只能为空对象；纯表变换不必额外写输出 schema。
- `data` 是固定表端口，可为 null。下游 Chart/Code 的必需表输入若解析为 null，明确报 `MISSING_TABLE_OUTPUT`。
- 退出码 0 不等于成功：还需规范结果存在、值通过 schema、表发布成功。不从 Markdown、日志片段或打印表格中猜结果。
- 用户代码执行的是已保存的分析程序；运行期间不调用 LLM 写代码、补代码或解释输入。

#### Chart

Chart 只做 `完整表 + 固定 ECharts 模板 → option` 的确定性装配。它不重调聊天生成工具，不发数据源请求，不调用 Agent。

`config` 不包含实际 `dataset.source`、`series[*].data`，也不解析引用字符串。数据字段、维度、encode 与图表类型做可实现的检查；不能笼统要求所有图表都有坐标轴，饼图等无轴图必须有效。

从 dataset 读取行时受 Chart 总预算限制，超限失败，不抽样顶替。合法空表输出一个可渲染的空状态，不当成执行失败。多数据集的每一个输入都验证完整性，同时限制最终 option 总大小。

## 6. 引用、参数与 SQL 编译

### 6.1 绑定语法

仅完整字段值是引用时进行解析，保留其原生 JSON 类型：

| 形式 | 用途 |
|---|---|
| `@inputs.<key>` | 一个 Workflow 参数 |
| `@nodes.<id>.data` | 不透明的 TableData 端口，不允许继续访问 `.rows`/`.preview` |
| `@nodes.<id>.values.<field>[.<field>...]` | 有 schema 的 Code 结构化值；只允许对象属性路径 |
| `@nodes.<id>.option` | 终端图表输出 |
| `@context.now` | 一次 run 开始时固定的 ISO 时间字符串 |

不支持算术、模板插值、函数调用、通配符、数组下标或任意表达式。深层对象选择仅限 `values` 且必须能沿 schema 验证；可引用的参数名/属性名使用 `^[a-zA-Z_][a-zA-Z0-9_]*$`，不引入带点键名的转义路径语法。复杂选择/变换使用 Code。

在允许绑定的 JSON 字段中递归处理对象值和数组元素。`@@` 前缀转义一个字面的 `@`；代码和图表模板属于原样字面内容，不扫描内部 `@`。

| 位置 | 允许的绑定 |
|---|---|
| `sql.inputs.params` | 常量、`@inputs`、`@nodes.*.values.*`、`@context.now` |
| `code.inputs.tables.<alias>` | 仅 `@nodes.*.data` |
| `code.inputs.params` | 常量、`@inputs`、`@nodes.*.values.*`、`@context.now` |
| `chart.inputs.dataset` | 一个或多个 `@nodes.*.data` |
| `outputs.<name>` | 合法节点输出；Artifact 首版只能选择 option 类型 |
| 源名称、代码、Chart config、schema、执行策略 | 固定配置，不进行通用引用求值 |

### 6.2 SQL 参数是绑定，不是拼接

SQL 模板统一使用 `@params.<name>` 作为值占位符；对应 `inputs.params.<name>` 提供值。该语法只在 SQL 编译器内处理，和通用 `@inputs` 引用解析分离。

例如 SQL 的 `customer_id IN (@params.customer_ids)` 可以绑定 `@nodes.detect.values.customer_ids`；编译器据此推导对 detect 的依赖。这是固定 DAG 中补充查询的基础。

**[RV-1] 先确定“执行方言”，再谈绑定。** 当前 Postgres/MySQL/MariaDB 的 SQL 并不由源库驱动执行，而是在 DuckDB 中 `ATTACH` 源库后以 `COPY (<SQL>) TO parquet` 执行，`sql_text` 实际是 **DuckDB 方言**；COPY 不接受绑定参数（`duckdb-extension.server.ts` 显式拒绝 `params`）。而数据源策略用 `node-sql-parser` 按 PG/MySQL 方言解析，该库没有 DuckDB 方言。下列规则中的“方言”“AST”“native binding”统一指 M0.2 选定的执行路径：

| 选项 | `sql_text` 方言 | 参数绑定 | 源端下推 | 主要代价 |
|---|---|---|---|---|
| **(a) 保留 DuckDB ATTACH** | DuckDB | DuckDB 机制，例如预编译 `CREATE TEMP TABLE r AS SELECT … WHERE x = $1` 后 `COPY r TO …`，或 `SET VARIABLE` + `getvariable()`（M0.2 实测哪种可用） | 列裁剪与部分过滤；GROUP BY/JOIN 在 DuckDB 本地执行；参数化后过滤是否仍下推需实测 | 大表拉取量；策略解析需以 DuckDB 兼容方式处理 |
| **(b) 直通源库** | 源库方言（经 `postgres_query()` / `mysql_query()` 或原生驱动） | 查询以字符串交给源库，参数只能走规则 6 的值位置 literal renderer | 完整下推（过滤、聚合、JOIN 都在源库） | literal renderer 成为主路径，需要更严格的测试；策略按源方言解析即可一致 |

无论选哪项：**策略检查必须对最终执行的那段 SQL、用与执行方言一致的解析方式进行**；占位符替换后的 SQL 才交给策略检查；`sql_text` 的方言写入节点注册表说明与 Chat 工具描述，让 Agent 写对方言。

编译规则：

1. 使用~~provider 支持的方言~~**选定执行路径的方言**及 AST 确认占位符处于值位置；占位符在字符串、注释、标识符或不支持位置时拒绝，不做 `replace()` 式拼接。
2. 模板参数与 `inputs.params` 键一致；遗漏/多余键给出字段诊断。
3. 优先 native binding（选项 (a) 中指 DuckDB 预编译参数）。`$n` 方言可复用同一绑定；`?` 方言按每次出现展开参数列表，不能因键重复而缺少值。
4. 字符串、有限数值、boolean、显式 null 使用类型化参数；日期值按声明格式检查。
5. 数组首版只允许 `IN (@params.ids)`。非空展开为独立绑定；空数组替换整个 IN 谓词为恒假谓词，不能生成 `IN ()` 或 `IN (1=0)`。首版拒绝 `NOT IN` 的数组扩展。
6. 不支持绑定的适配器必须实现并测试 AST 值位置 literal renderer 后才能启用参数；禁止在调用点临时引号拼接。现有 DuckDB COPY/Vertica 参数限制需要真实适配，不只是改 TypeScript 类型。
7. 对最终执行 SQL 应用原有只读/表策略。

~~参数按 provider 分阶段启用：M0.2 盘点各 provider 的绑定能力，M1 先为常用、能可靠绑定的 provider 启用（目标至少覆盖 Postgres 与 MySQL/MariaDB，以 M0.2 结论为准）；其余 provider 在 M3 补齐。~~ **[RV-1]** 参数按**执行路径**分阶段启用：Postgres/MySQL/MariaDB 共用 DuckDB 路径或直通路径之一，M1 按 M0.2 选定的路径一次覆盖这三种；Vertica（独立的 `vertica-nodejs` 驱动路径）在 M3 补齐。未启用的 provider 中，SQL 模板出现 `@params` 在编译时报 `SQL_PARAMS_NOT_ENABLED`，不回退到字符串拼接。

分阶段的参数来源：M1 支持常量、`@inputs.*` 和 `@context.now`；`@nodes.*.values.*`（上游分析结果驱动的补充查询）在 M3 启用，M1 中编译报“尚未启用”。

无需支持用户编辑表名占位符或任意 SQL 标识符模板。大型 ID 集超过参数预算时报错，提示在源端聚合或读取另一完整表后在 sandbox 联合分析，不自动截断 ID 集。

### 6.3 Workflow 输入与 Filter

参数与 Filter 属于初期（M1）能力。`input_schema` 首版支持顶层 object、有名 properties、required；字段为 string、integer、number、boolean、这些标量的有界数组（多选），支持 enum、date/date-time、nullable、default、数值范围和长度限制。这些已能覆盖常见的日期范围、地区/类别多选、阈值等 Filter。嵌套输入表单、动态 options_source（从数据源查询下拉选项）和跨字段规则编辑器暂缓。

Filter 的来源：聊天提取不自动猜 Filter；用户（或以后的 Agent）在 Spec 中声明 `input_schema` 并把 SQL/Code 中的字面值改成引用。M1 通过整图 JSON 编辑完成，“一键把字面值提升为参数”的便利操作在后续里程碑提供。

- Schema 本身在编译时校验；每次运行合并并验证输入：请求值 > schema default > 必需项缺失错误。
- `null` 与缺失不同；数组 `[]` 明确表示空集合，不暗中代表“全部”。需要“不筛选”时使用声明为 nullable 的参数及对应 SQL 条件。
- 不在 Spec schema 中保存 `value`。参数定义、执行输入和快照输入各自独立。
- 对可选但无默认值的参数，绑定到必需节点字段会在运行前/节点调用前明确失败；不隐式变成空字符串。
- 下游值为运行期结果时，解析后再次按消费者 schema 验证；编译成功不替代运行期校验。

Filter UI 使用现有 RJSF。保留三份不同状态：`draftInputs`、当前成功结果的 `appliedInputs`、`snapshotInputs`。Apply 成功后才更新 appliedInputs；失败不改变已显示结果的输入来源。Reset 只重置表单为 schema 默认值，不自动运行。Header Refresh 提交当前已应用的完整参数包，不能悄悄恢复默认值。

**[RV-7] 并发与过期响应。** Apply/Refresh 是异步运行（§8.2）。同一用户在同一 Artifact 上发起新的 Apply/Refresh 时，服务端取消该用户此前仍在执行的 run；客户端只接受**最近一次提交的 runId** 的结果，任何更早 runId 的完成事件都不更新显示和 `appliedInputs`。界面在运行中显示进度与“取消”按钮；取消后保持上一次成功结果。

## 7. 编译、执行与可刷新能力

### 7.1 Compile / lint

`compile(spec, selectedOutputs, catalog)` 生成唯一的 ExecutionPlan，同时返回结构化 issues：`severity`、`code`、`path`、`nodeId`、`message`、`hint`。编辑器、提取器、样例测试使用同一入口。

步骤：

1. 严格解析作者态、输入 schema 和 Code values_schema。
2. 从允许绑定的字段解析引用，验证节点/端口/schema 路径及类型；拒绝 preview 绑定。
3. 合并数据依赖与 `after`，检查重复 ID、失效引用与周期；按图拓扑排序，不依赖数组位置。
4. 解析当前选定输出，计算包含顺序依赖的祖先闭包。
5. 为将执行的节点解析数据源与执行器，编译 SQL 模板、预算和验证器。未选择分支的资源不可用只报诊断，不导致已选输出执行失败；全图编辑仍检查结构一致性。
6. 形成计划。代码/SQL 的实际结果、行数和数据业务含义留给运行与测试判断。

全图静态结构不合法时不能发布可执行 Workflow。编辑中的不完整草稿可以留在客户端，但不能直接替换服务端已验证 Spec。

### 7.2 不把“可刷新”与“此次成功”混为一谈

- `refreshable` 表示选定输出具有明确、支持的生产路径，是从当前 Spec/提取状态导出的能力，不是一次 SQL 的行数判断。
- 绑定不明、临时路径、未支持节点等属于结构性不可执行问题；静态 Artifact 或待修复作品不给出虚假的刷新成功。
- 某次超预算、数据库断连、输入错误、代码异常属于 RunResult 失败。保留上次快照，允许修改输入后重试，不永久关闭刷新。
- 同一 Spec 的其他输出有问题，不应误伤当前选定输出；运行和能力判断使用同一个依赖闭包。

### 7.3 Executor

一次运行固定 `runId`、`specHash`、已验证 inputs 和 context.now。每个节点获得只读的已解析输入、资源依赖、取消信号和受控结果发布接口，不访问可变全局 Workflow context。

节点状态：`pending → running → succeeded / failed / canceled`；因依赖失败未启动的节点为 `skipped`。所选闭包内失败即停止启动新节点，取消仍在运行的兄弟任务；只有所有必需节点及终端输出验证成功，才返回 succeeded。

- Workflow deadline 覆盖等待、I/O、代码和重试延迟；节点 timeout 不能越过总 deadline。
- AbortSignal 贯穿 SQL、sandbox 和重试等待。不能只停止本地等待，却任由新节点启动。**[RV-7]** 取消的来源是明确的：用户点“取消”、同一用户的新 Apply/Refresh 取代旧 run、run deadline 到期、进程关闭。当前 `executeWorkflow` 创建的 `AbortController` 从未被 abort，M1 必须把上述来源接入。SQL 侧当前的 `raceWithTimeoutAndAbort` 只停止等待，取消后须关闭 DuckDB 连接以真正中止查询，并以测试确认。
- **[RV-7]** 进程级并发上限：同时执行的 Workflow run 数受 `workflow.max_concurrent_runs`（默认 4）限制，超出时排队并在事件中显示等待；所有 run 的 Code 节点并发总数不超过 sandbox `max_workers`（当前 10）。
- 若某 sandbox 后端只能中止 HTTP 等待而不能终止远程执行，必须记录这一能力限制，确保远端硬 timeout 生效，不把它宣传为即时取消，也不立即启动重叠重试。**[RV-2]** 当前 dify-sandbox 即属此类，远端硬 timeout 为 `worker_timeout`（60 秒）。
- 默认不自动重试。只对明确可重试、无已发布输出的暂时性 I/O 错误重试；schema 错误、SQL 语法、缺绑定、代码逻辑错误不重试。
- 新的 retry attempt 不能复用失败 attempt 的部分输出。
- Engine 不执行 LLM、自行修复 Spec 或访问 Artifact snapshot。

### 7.4 运行结果与事件

RunResult 至少包含 `runId`、`specHash`、选定输出、resolvedInputs、startedAt、finishedAt、status、终端 outputs、节点摘要、结构化 error。复用 `entity_run` 和 `entity_run_event` 记录，不另起工作流运行平台。

节点结束记录有界摘要：schema、行数、数据集 ID、最多 20 行预览、耗时、缓存/提取来源、错误代码。所有事件类型（包括 failed/message）最终序列化不得超过 64 KB。事件摘要不是供 Save Snapshot 恢复完整结果的存储。

执行结束前验证终端：option 结构、实际数据字段、完整性和总预算。exit code 0、对象非空、节点运行结束都不能单独代表 Artifact 输出成功。

## 8. Artifact 与 RunResult 的生命周期

### 8.1 操作语义

| 操作 | 是否执行 | 是否读旧源数据缓存 | 是否写 Artifact 快照 |
|---|---|---|---|
| GET Artifact | 否 | 不涉及 | 否 |
| 从聊天 Save | 默认否：保存已生成的作品并提取/编译 Spec | 不涉及新提取 | 写聊天作品快照，标明来源 |
| Test Workflow | 是，使用样例或显式测试输入 | 测试模式明确标识，允许缓存 | 否 |
| Refresh / Apply | 是，执行所选输出闭包；**[RV-7]** 异步，立即返回 runId | 不命中本次 run 之前的提取结果 | 否 |
| 取消运行 **[RV-7]** | 中止该 run | 不涉及 | 否；显示仍为上一次成功结果 |
| Save Snapshot | 否，提交指定成功 RunResult | 不涉及 | 是 |
| 编辑静态作品 | 不运行数据 Workflow | 不涉及 | 保存经类型校验的静态文档 |

与旧方案不同，**初次 Save 不自动重跑历史工具链**。保存首先意味着保留用户刚看到的作品；是否可执行由编译和血缘判定，是否已验证运行单独展示。需要验证时显式 Test 或 Refresh，不能让“保存”隐含一次重新分析。

聊天中的动态图表应通过规范表引用生成完整、预算内的 option；从旧式手写 preview option 保存的内容只能标为静态/聊天预览，不能声称它是已验证的完整刷新结果。

### 8.2 服务端 RunResultStore

~~Refresh 返回 `runId`、data、appliedInputs、executedAt、specHash。~~ **[RV-7]** Refresh/Apply 异步执行：

1. `POST /api/artifacts/[id]/refresh { inputs }` 校验权限与输入（§8.4、§6.3）后创建 `entity_run`，立即返回 `202 { runId }`；同一用户在该 Artifact 上仍在执行的旧 run 被取消。
2. 进度通过现有 `/api/runs/stream`（按 owner 投递）推送节点状态与终态事件，不新建推送通道。
3. `GET /api/artifacts/[id]/runs/[runId]` 返回 `{ status, data?, appliedInputs, executedAt, specHash, error? }`，客户端断线重连或刷新页面后以此对账。
4. `POST /api/artifacts/[id]/runs/[runId]/cancel` 由发起人取消。

这样 120 秒级的运行不受反向代理超时影响，取消有明确入口，也复用了项目已有的异步运行、SSE 与通知机制。

成功结果放入~~单进程、有 TTL 和总字节限制的~~服务端 RunResultStore；这是“未保存的预览”，不是 Artifact 快照。

~~首版用进程内 Map 实现即可：默认 TTL 30 分钟、总预算 32 MB，超出时淘汰最早的结果。~~ **[RV-8]** RunResultStore 用一张小表 `workflow_run_result` 实现，而不是进程内 Map：进程内 Map 在 32 MB / 每个结果最多 1 MB 的预算下只能容纳约 30 个结果，团队共享时用户点保存前结果就可能被淘汰，重启后全部丢失。表结构（迁移由 `pnpm db:generate` 生成）：

| 列 | 含义 |
|---|---|
| `run_id` | PK，等于 `entity_run.id` |
| `artifact_id` | FK → artifact，`ON DELETE CASCADE` |
| `owner_id` | 发起人；Save Snapshot 时必须等于保存者（§8.4） |
| `spec_hash`、`output_field` | 运行时的定义与选定输出 |
| `inputs` | 已解析的运行输入 |
| `output` | 终端可渲染结果（≤ 1 MB，与 Chart 预算一致） |
| `executed_at`、`expires_at` | 默认保留 24 小时（`workflow.run_result.ttl_hours`） |

每个 (artifact, owner) 只保留最近 N 条（默认 5），写入时裁剪；过期行在进程启动时与每次写入时清理。不新增队列、不做工作流恢复：进程重启时仍在执行的 run 由现有 zombie sweep 标记失败。

这里只保存所选终端输出及其验证/输入元数据，不复制整个执行上下文或所有中间表。最终可渲染输出仍受 1 MB 限制，避免结果存储成为另一份无界数据缓存。基础实现无需新数据库队列或持久化工作流恢复系统。

`POST /api/artifacts/[id]/snapshot` 对 Workflow 结果只接收 `{ "runId": "..." }`：

1. 服务端取得成功、未过期的 RunResult，检查其 Artifact、选定输出与资源操作权限。**[RV-5]** RunResult 的 `owner_id` 必须等于保存者，且保存者满足 §8.4 的 Save Snapshot 权限；不能把他人的运行结果存成快照。
2. 结果 Spec hash 必须等于当前 Workflow hash；定义变化返回冲突并提示重新运行。
3. 一次事务写入该结果的 data、inputs、runId、specHash、executedAt 和保存时间。
4. 不接受浏览器传回的 chart JSON 作为“已验证运行结果”，也不为保存重新执行 Workflow。

~~进程重启或结果被淘汰后~~结果过期或被裁剪后返回 `RESULT_EXPIRED`，用户重新刷新。不能无提示地回退为重算、旧缓存或旧快照。静态 HTML/Slides 的人工保存是另一条带类型验证的内容保存分支，不冒充 Workflow RunResult。

### 8.3 最小持久化信息

保留现有 Artifact/Workflow 表，实施时生成迁移：

- Artifact 保留 `snapshot`、`snapshot_at`；增加 `snapshot_inputs`、`snapshot_run_id`、`snapshot_spec_hash`、`snapshot_executed_at`、`snapshot_origin`、有界 `last_run_error`。
- `snapshot_origin` 区分 `chat`、`workflow_run`、`manual`。聊天保存没有 Workflow runId，也不能伪造“已运行过此 Spec”的 hash 对应关系。
- 删除服务端 `view_mode`。View 的“已保存/本次预览”是客户端状态。
- **[RV-8]** 新增 `workflow_run_result` 表（§8.2）。
- **[RV-5]** 删除 `workflow.visibility`：可执行 Workflow 与 Artifact 一对一归属，可见性以 `artifact.visibility` 为唯一来源；`runner/admission.ts` 中 workflow 分支改为按所属 Artifact 判断。
- Workflow 保存作者态 Spec、当前 specHash 和有界提取来源/诊断。无需保存另一套 canonical Spec 或完整版本历史。
- 不把运行输入写回 Spec；快照过期标识由 snapshotSpecHash 与当前 hash 比较，旧快照仍可查看。
- `workflow_id` 允许为空：静态 Artifact 独立展示，不依赖一个假 noop 图。
- 保留 `workflow_output_field`：指向 `spec.outputs` 中的一个键，决定该 Artifact 渲染哪个输出，也决定 Refresh/能力判断使用的祖先闭包。首版要求其对应输出为 `option` 类型；Spec 可以有多个输出，但一个 Artifact 只渲染一个。
- `refreshable` 不作为独立持久化列：由当前 Spec 编译结果与 `workflow_output_field` 的闭包实时导出（§7.2），避免与 Spec 不同步。

本轮按“一个可执行 Workflow 归属一个 Artifact”处理，明确唯一关系：`artifact.workflow_id` 加唯一约束（允许 NULL）。用户只能删除 Artifact；服务端在同一事务内先删 Artifact、再删其归属 Workflow。

外键方向需要注意：当前 schema 是 `artifact.workflow_id → workflow.id ON DELETE CASCADE`，即删除 Workflow 会级联删除 Artifact，而删除 Artifact 不会删除 Workflow。M1 迁移将其改为 `ON DELETE SET NULL`，防止任何直接删除 Workflow 的路径连带删掉作品；Workflow 的清理由 Artifact 删除服务显式完成，不依赖数据库级联。

未来 Dashboard 引用 Artifact：删除 Dashboard 只删引用，引用中的 Artifact 拒绝删除并提示“正在使用”。现在仅保留这个生命周期约束，不建设 Dashboard 功能。

**[RV-9]** 这个约束**已经存在于 schema**：`dashboard` 与 `dashboard_artifact` 表已建好，`dashboard_artifact.artifact_id` 为 `ON DELETE RESTRICT`（目前没有应用代码读写）。因此 Artifact 删除事务必须先检查引用并返回“正在使用”，而不是让数据库抛出外键错误；M1.1 清库时按外键顺序先清 `dashboard_artifact`（以及空的 `dashboard`）再清 Artifact。

### 8.4 [RV-5] 权限与执行身份

§1.7 不重新设计细粒度协作权限，但共享 Artifact 的以下行为必须确定，否则 Refresh、Save Snapshot 的结果因人而异。

| 操作 | 谁可以 | 说明 |
|---|---|---|
| 查看（GET） | 能看到该 Artifact 的人 | 沿用 `artifact.visibility` 与现有 `getArtifact` 可见性检查 |
| Apply / Refresh / Test | 能看到该 Artifact 的人，含 `user` 角色 | 结果只进入发起人自己的 RunResult，不改变共享状态 |
| 取消运行 | 该 run 的发起人；admin | |
| Save Snapshot | `canEditResource`（作者、有权编辑的 editor、admin），且 RunResult 属于保存者本人 | 当前代码仅允许作者；改为统一的资源权限判断 |
| 编辑 Spec / Filter 定义 / 输出映射 | `canEditResource` | |
| 删除 Artifact（连带 Workflow） | `canDeleteResource` | 被 Dashboard 引用时拒绝 |

**执行身份：刷新使用发起人自己的数据源授权。** 运行时可用的数据源 = 发起人可见且已启用的数据源（与当前 `build-user-catalog` 的“public 或本人创建”一致）。发起人看不到某个私有数据源时，该 SQL 节点以 `DATA_SOURCE_NOT_AVAILABLE` 失败，其他人仍看到已保存的快照。选这一项而不是“借用作者授权”，是因为后者等于把作者的私有数据源开放给所有能看到 Artifact 的人，且 Filter 参数能改变查询范围。若以后需要“作者授权、他人可刷新”，作为显式的共享开关另行设计。

`entity_run.owner_id`、`workflow_run_result.owner_id` 都记录发起人；运行事件按 owner 投递，不向其他查看者推送他人的运行进度。

## 9. Chat 工具与 Workflow 提取

### 9.1 工具与节点复用服务，不复用 LLM 投影

Chat SQL/Code 工具使用 literal 参数、表引用或 alias，调用与节点相同的提取/分析服务。执行得到 TableData 和 values 后：

- LLM 只收到有界 schema/preview、data_ref 和必要的值摘要。
- 服务端保存规范的 invocation 来源与有界结果元数据；不要从已经截断、展示加工后的 tool response 文本猜原始数据。
- UI 的产物预览使用受控的完整终端数据；LLM 返回通道与浏览器渲染通道可以使用不同投影。
- Chat code 的参数和表 alias helper 与 Workflow code 完全一致，减少保存时改写 Python 的需要。

Chat chart 工具支持明确的 `data_ref`（生产调用 + data 端口/数据层句柄），不再只靠友好 slot 名称或数组值相等。无 data_ref 的静态 option 仍可保存为作品，但不能自动宣称可刷新。

**[RV-6] 句柄旁路：LLM 通道与渲染通道必须物理分开。** 当前 `generate_echarts_config` 是纯校验器，图表由前端从该工具的 `tool_call_result` 事件渲染；同一事件在后续轮次又被回放进 LLM 上下文，数据往往是 LLM 根据 5 行预览或 Code 输出自己写进 `option.dataset.source` 的。只有一个通道，无法同时满足“UI 拿完整数据”和“LLM 只看摘要”。v2 做法：

1. Chat chart 工具接收 `data_ref`（一个或多个）与不含数据的 `config`，由服务端调用与 Chart 节点**相同的装配服务**，从完整表生成 option（同样的完整性检查与 1 MB 预算）。
2. 装配结果存入小表 `chat_chart_result`（`chart_handle` PK、`thread_id`、`owner_id`、`outcome_id`、`data_refs`、`option` ≤ 1 MB、`expires_at`），清理规则同 `workflow_run_result`；同一 thread 的同一 `outcome_id` 只保留最新一条，与“同 outcome_id 覆盖”语义一致。
3. 工具结果只返回 `{ ok, outcome_id, chart_handle, title, row_count, schema 摘要 }`，这是写入事件、回放给 LLM 的全部内容。
4. 前端按 `chart_handle` 调 `GET /api/outcomes/charts/<handle>`（owner/thread 校验）取完整 option 渲染；历史会话重放时同样按句柄取，句柄过期则显示“图表数据已过期，可在保存的作品中查看”。
5. 保存作品时以 `chart_handle` 对应的 option 作为聊天快照，以 `data_ref` 作为提取的数据边。
6. 无 `data_ref` 的旧式 inline option 仍可用，但标记为静态/聊天预览（§8.1），工具描述引导 Agent 优先使用 `data_ref`。

### 9.2 来源记录

规范 invocation 记录至少包含：originRunId、toolCallId、thread 内稳定顺序、工具类型、成功状态、执行参数、输入 data_ref、输出 data_ref 与 schema、有界 values、创建 outcome 的稳定关联。

来源记录存于现有事件/来源机制的服务端结构化部分，与面向 LLM 的文本投影分开。不得复制完整大表进事件。

必须修复当前跨 run 的局部 seq 重排问题：不能把每轮从零开始的 seq 当成整个 thread 的时序。数据边优先依靠明确 producer 引用；并发调用没有可证明因果关系时不凭时间靠近建立依赖。

### 9.3 提取顺序与结果分类

1. 找到本次 outcome 的准确创建调用和已接受的后续编辑，不用“任意参数字符串等于 outcomeId”作为长期身份规则。
2. 建立候选节点，仅收录受支持的 SQL/Code/Chart 服务调用。历史 Agent 的规划文字和调用决策不是运行节点；LLM 生成的 SQL/Python 本身是固定节点配置。
3. 先解析明确数据引用与已知参数来源，再进行辅助匹配。Strategy Z+ 仅作为候选提示，不能把偶然值相等作为通用因果证明。
4. 检查每条必要输入的来源、类型与完整性，完成绑定后才反向裁剪。
5. compile/lint 候选 Spec，输出结构化提取报告，保留 nodeId 与 origin run/call 的映射。
6. 保存原作品。候选明确且合法才创建可执行 Workflow；否则保留静态作品、来源和诊断，等待修复，不执行不完整候选图。

| 结果 | 处理 |
|---|---|
| `ready` | 绑定明确、合法的可执行 Spec；首次独立运行尚需 Test/Refresh 验证 |
| `needs_review` | 有数据生产候选但缺少绑定、使用临时路径或包含不可转换步骤；报告具体字段供人工处理 |
| `static` | 没有需要重新生产的数据路径；直接保存 Artifact |

`needs_review` 不是“保存失败”，也不是“把全线程调用全部重放”。候选内容可供简单 JSON 编辑器修复；在编译合法前不替换现有有效 Workflow。

**[RV-9] Chat 工具 → v2 节点映射。** 提取器只按下表转换，表外工具一律不进入可执行图：

| Chat 工具 | v2 处理 | 说明 |
|---|---|---|
| `extract_dataset_by_sql` | `sql` 节点 | 复制 `data_source_name`、`sql_text`；丢弃 `row_limit`、`dataset_name`、`force_refresh` |
| `run_skill_sql_script` | `sql` 节点，固化当时的 SQL 文本 | 与上一行共用提取服务；来源记录写入 skill 名称、脚本路径与 `scriptSha256`，便于发现 skill 更新后定义已过时；不随 skill 文件自动变化 |
| `run_code_in_sandbox`（Python） | `code` 节点 | `datasets` 映射为 `tables` 引用；`params` 映射为 `params` |
| `run_code_in_sandbox`（JavaScript） | `needs_review` | v2 首版只有 Python |
| `run_skill_script` / `run_skill_script_on_ssh` | `needs_review` | skill 脚本可能依赖同一 skill 的其他文件或 SSH 主机；不自动内联 |
| `generate_echarts_config` 带 `data_ref` | `chart` 节点 | 见 §9.1 句柄旁路 |
| `generate_echarts_config` 无 `data_ref` | `static` | 保存为聊天预览图表 |
| `generate_html_page`、`generate_bento_slides` + `edit_bento_slides` | `static` | Slides 先把同一 outcome 的生成与多次编辑合并为最终文档再保存（沿用 `coalesce-tool-calls.ts`）；当前“快照驱动的 Slide + Workflow”组合在 v2 中不再存在 |
| MCP 工具、`run_ssh_command`、`web_search`、Agent 委派等 | 其下游图表为 `needs_review`（有数据生产路径但不可转换）或 `static` | v1 的 MCP tool / agent 节点不再存在（§1.6），报告写明“数据来自不支持的工具 X” |

同一 outcome 再次保存需要区分内容未变的幂等请求和已编辑作品的更新。使用内容/来源指纹，不再把 `(threadId, outcomeId)` 永久视作“以后不更新”；已有人为修改 Workflow 时，不用聊天重提取静默覆盖，要求明确选择更新或另存。

### 9.4 有意保留的限制

机械提取不能恢复 LLM 脑内进行、没有落成 SQL/Code 的数据变换；也不能可靠解析任意硬编码路径或猜测复杂控制流。此类情况保留作品并报告诊断。

以后可以让 Agent 辅助把候选变成 Spec，但仍需相同的编译、样例测试与用户确认。Agent 辅助提取不是当前执行器的前置依赖。

## 10. 编辑与样例测试

### 10.1 最小编辑能力

不做自由拖拽画布。保留只读依赖图、节点表单和整图 JSON 编辑；必须能完成：增加/删除 Code 节点、修改 SQL/代码、重绑表与参数、声明 Filter、调整输出映射。

以完整 Spec 的一次原子修改作为服务端真源操作；单节点 PATCH 是便利入口，内部同样读取当前 Spec、应用修改、编译整图后保存。这样“插入 Code 并把 Chart 改绑到它”不会卡在多个中间非法状态。

- 绑定控件提供常量/Workflow 输入/上游输出，但只显示该字段允许的模式与兼容类型；`tables`/`chart.dataset` 不提供任意常量模式。
- 节点 rename 同时重写引用、after 和 outputs；删除被引用节点必须一并修复引用，否则拒绝。
- 显示全部 lint issues 及字段位置，不只弹出第一个错误。
- 编辑不自动执行、不覆盖快照；Test 和 Refresh 是明确动作。
- 保存接受 baseSpecHash，拒绝覆盖已变化的定义；不建设分支/发布历史系统。
- **[RV-5]** 编辑权限按 §8.4（`canEditResource`）。

### 10.2 Fixture 测试是一等验证入口

复用执行器和节点服务依赖注入，fixture 在运行计划中替代指定源节点输出，不写入生产 Spec，不修改实际数据源。

三层验证：

1. **静态测试**：Spec、引用、输入 schema、SQL 参数编译和所选输出闭包。
2. **样例运行**：给定小型完整表/values 和 Workflow inputs，执行真实转换代码，断言结果，而不只 mock 掉被测节点。
3. **集成测试**：真实 SQL 适配器、Parquet 和 sandbox 文件交接，验证完整性、取消、预算与结果保存。

最小断言包括输出 schema、关键列值、行数、空结果、数值容差与失败代码。可以先以 Vitest fixtures 实现，无需新增一套测试管理 UI。

**[RV-11] 补充的验证手段**：

1. **提取器的确定性回归：录制事件语料。** “Chat 探索 → 保存”能否成功取决于 LLM 是否遵守新约定，真实 LLM 不能作为回归门槛。在 `tests/fixtures/workflow-extraction/` 下保存脱敏后的 `entity_run` / `entity_run_event` 序列，每条附期望的分类（`ready` / `needs_review` / `static`）和期望 Spec（或期望诊断），由 Vitest 直接驱动 `build-from-events`。语料至少覆盖：跨多轮且每轮 seq 从 0 开始；SQL 失败后修正重试（只取成功的那次）；同一 `outcome_id` 多次覆盖（只取最后一次及其已接受编辑）；并发工具调用；Chat `row_limit` 不进入节点；`run_skill_sql_script` 映射；来自 MCP/SSH 的图表归类；无法绑定的链路。真实 LLM 只做冒烟，并统计三类结果的占比作为观察指标。
2. **资源声明的可测验收。** “大表不进入 Node 堆”“不经全量 stdout”以内存基线测试验证：在集成环境提取约 100 万行，经 dataset 交给 Code 并聚合，断言 Node 进程 RSS 增量低于配置阈值、sandbox 响应体大小低于 inline 预算。Vertica 路径单独验证其规模上限确实拦截。
3. **集成测试环境。** 新增 docker compose 测试 profile：Postgres、MySQL（或 MariaDB）带种子数据，dify-sandbox 使用与生产相同的 `config.yaml`（`enable_network: false`）。新增 Vitest 集成配置与独立 CI job；依赖服务不可用时 job 必须失败，不能静默跳过。真实 LLM 冒烟沿用现有 `real-llm` Playwright 项目。
4. **“执行全程不调用 LLM”的断言方式。** 集成测试注入一个被调用即抛错的模型 provider，并断言 Workflow 运行树中不存在 agent 类型的子 run。

后续再加“测试当前节点”“运行到当前节点”和 Inspector 历史输入复用。不能把调试 fixture 结果保存为真实源数据快照；RunResult 标明 `test` 来源。

## 11. 合法作者态示例

以下 JSON 是目标 v2 契约示例，不声称当前 v1 parser 可直接运行。代码中的 `nango` helper 按 §4 实现后才可用。

| 示例 | 场景 | 可运行的里程碑 |
|---|---|---|
| 11.1 | 初期场景：两个数据源 → Code → Chart，无参数 | M1（M1 验收标准） |
| 11.2 | 单数据源 + Filter 参数 → Chart | M1（M1 验收标准） |
| 11.3 | 异常检测 → 补充查询 → 联合分析 | M3 |

### 11.1 初期场景：多数据源 → Code → Chart

```json
{
  "version": 2,
  "name": "各区域销售额与退货率",
  "nodes": [
    {
      "id": "sales",
      "type": "sql",
      "inputs": {
        "data_source_name": "sales_pg",
        "sql_text": "SELECT region, SUM(amount) AS sales FROM orders WHERE created_at >= DATE '2026-01-01' GROUP BY region"
      }
    },
    {
      "id": "returns",
      "type": "sql",
      "inputs": {
        "data_source_name": "erp_mysql",
        "sql_text": "SELECT region, SUM(amount) AS returned FROM returns WHERE created_at >= '2026-01-01' GROUP BY region"
      }
    },
    {
      "id": "analyze",
      "type": "code",
      "inputs": {
        "language": "python",
        "tables": { "sales": "@nodes.sales.data", "returns": "@nodes.returns.data" },
        "code_text": "s = nango.read_table('sales')\nr = nango.read_table('returns')\ndf = s.merge(r, on='region', how='left').fillna({'returned': 0})\ndf['return_rate'] = (df['returned'] / df['sales']).round(4)\nnango.emit(data=df[['region', 'sales', 'return_rate']])"
      }
    },
    {
      "id": "chart",
      "type": "chart",
      "inputs": {
        "renderer": "echarts",
        "dataset": "@nodes.analyze.data",
        "config": {
          "xAxis": { "type": "category" },
          "yAxis": [{ "type": "value" }, { "type": "value" }],
          "series": [
            { "type": "bar", "encode": { "x": "region", "y": "sales" } },
            { "type": "line", "yAxisIndex": 1, "encode": { "x": "region", "y": "return_rate" } }
          ]
        }
      }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" }
}
```

这是初期最常见的形态，也是 M1 的验收场景：每个数据源在库内完成过滤和聚合，Code 合并多张表并做分析，Chart 只负责装配。为突出数据流，这里把日期写成字面值；加上 Filter 的写法见 11.2，两者可以组合。两条 SQL 结果在 inline 预算内时直接传完整 JSON；超过预算时，Code 通过 dataset 读取，脚本不需要修改。

### 11.2 小结果：源端聚合后直接画图

```json
{
  "version": 2,
  "name": "每日销售额",
  "input_schema": {
    "type": "object",
    "properties": {
      "start_date": { "type": "string", "format": "date", "default": "2026-01-01" }
    },
    "required": ["start_date"],
    "additionalProperties": false
  },
  "nodes": [
    {
      "id": "sales",
      "type": "sql",
      "inputs": {
        "data_source_name": "sales_pg",
        "sql_text": "SELECT day, SUM(amount) AS total FROM sales WHERE day >= @params.start_date GROUP BY day ORDER BY day",
        "params": { "start_date": "@inputs.start_date" }
      }
    },
    {
      "id": "chart",
      "type": "chart",
      "inputs": {
        "renderer": "echarts",
        "dataset": "@nodes.sales.data",
        "config": {
          "xAxis": { "type": "category" },
          "yAxis": { "type": "value" },
          "series": [{ "type": "line", "encode": { "x": "day", "y": "total" } }]
        }
      }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" }
}
```

LLM 可只看到 5 行 preview，Workflow/Chart 消费的是完整 sales.data。结果因日期范围扩大而超出图表预算时，此次 run 失败，用户缩小范围后仍可刷新。

### 11.3 异常检测 → 补充查询 → 联合分析

```json
{
  "version": 2,
  "name": "异常客户与工单关联分析",
  "input_schema": {
    "type": "object",
    "properties": {
      "start_date": { "type": "string", "format": "date", "default": "2026-01-01" },
      "threshold": { "type": "number", "minimum": 0, "default": 10000 }
    },
    "required": ["start_date", "threshold"],
    "additionalProperties": false
  },
  "nodes": [
    {
      "id": "sales",
      "type": "sql",
      "inputs": {
        "data_source_name": "sales_pg",
        "sql_text": "SELECT customer_id, amount FROM orders WHERE created_at >= @params.start_date",
        "params": { "start_date": "@inputs.start_date" }
      }
    },
    {
      "id": "detect",
      "type": "code",
      "inputs": {
        "language": "python",
        "tables": { "sales": "@nodes.sales.data" },
        "params": { "threshold": "@inputs.threshold" },
        "code_text": "df = nango.read_table('sales')\ntotals = df.groupby('customer_id', as_index=False)['amount'].sum()\nsuspects = totals[totals['amount'] > params['threshold']].copy()\nsuspects['customer_id'] = suspects['customer_id'].astype(str)\nnango.emit(data=suspects, values={'customer_ids': suspects['customer_id'].tolist()})"
      },
      "values_schema": {
        "type": "object",
        "properties": {
          "customer_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 1000 }
        },
        "required": ["customer_ids"],
        "additionalProperties": false
      }
    },
    {
      "id": "tickets",
      "type": "sql",
      "inputs": {
        "data_source_name": "support_pg",
        "sql_text": "SELECT customer_id, COUNT(*) AS tickets FROM tickets WHERE customer_id IN (@params.ids) GROUP BY customer_id",
        "params": { "ids": "@nodes.detect.values.customer_ids" }
      }
    },
    {
      "id": "explain",
      "type": "code",
      "inputs": {
        "language": "python",
        "tables": { "suspects": "@nodes.detect.data", "tickets": "@nodes.tickets.data" },
        "code_text": "left = nango.read_table('suspects')\nright = nango.read_table('tickets')\nright['customer_id'] = right['customer_id'].astype(str)\nresult = left.merge(right, on='customer_id', how='left').fillna({'tickets': 0})\nnango.emit(data=result)"
      }
    },
    {
      "id": "chart",
      "type": "chart",
      "inputs": {
        "renderer": "echarts",
        "dataset": "@nodes.explain.data",
        "config": {
          "xAxis": { "type": "category" },
          "yAxis": [{ "type": "value" }, { "type": "value" }],
          "series": [
            { "type": "bar", "encode": { "x": "customer_id", "y": "amount" } },
            { "type": "line", "yAxisIndex": 1, "encode": { "x": "customer_id", "y": "tickets" } }
          ]
        }
      }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" },
  "execution": { "max_parallelism": 3, "timeout_seconds": 120 }
}
```

示例是固定的诊断路径，不是自动证明根因。异常 ID 为空时，补充 SQL 编译为恒假过滤并返回带 schema 的空结果，后续节点仍能产生合法空图。ID 列表超限则明确失败，不悄悄只查部分客户。大型 sales 应使用 sandbox 的 DuckDB/Parquet 路径完成源外聚合，是否可装入 DataFrame受 sandbox 资源预算约束。

## 12. 分阶段实施计划

### 12.1 实施原则

- **每个里程碑结束时系统可运行、可验收。** 后一阶段只扩展能力，不推翻前一阶段已定稿的契约（Spec 形状、TableData、RunResult、快照语义在 M1 定稿）。
- **不保留旧数据兼容中间态。** M1 第一步即清空旧 Workflow/Artifact 测试数据，之后只存在 v2。
- **能力未完成时明确报错，不降级冒充。** 例如 `DATASET_OUTPUT_UNSUPPORTED`、`SQL_PARAMS_NOT_ENABLED`；不以截断、抽样、静默回退代替尚未实现的能力。
- **测试与功能同步编写。** fixture 测试从 M1 起随每个节点和契约一起提交，不集中放在最后。
- **只按真实路径验收。** mock 单测、类型检查通过不代表交付；涉及数据库、Parquet、sandbox 的步骤必须有真实集成验证，并在文档中注明覆盖范围。
- **高风险先验证。** ~~各数据源参数能力~~ **[RV-1]** SQL 执行方言与参数策略决定 M1 的参数实现方式，Sandbox 输出交接决定 M2 的实现方式，先用 M0 小规模验证，并按 §12.3 的 go/no-go 表决定退路，避免实施到后期才发现不可行。

### 12.2 里程碑总览

| 里程碑 | 目标 | 前置 | 完成后用户可见效果 |
|---|---|---|---|
| **M0 风险验证** | Sandbox 可写输出目录与配置、SQL 执行方言与参数策略（**[RV-1]**）、provider 缓冲能力 | 无 | 无；产出书面结论与 go/no-go 判定，确定 M1 参数与 M2 数据交接的实现路线 |
| **M1 执行内核、生命周期与 Filter** | Spec v2、注册表、编译、执行器、TableData（Code 仅 inline 输出）、RunResult、按 runId 保存快照、基础提取、fixture 测试；Workflow 参数、SQL 值参数、三态 Filter | M0.2 完成后才开始参数步骤（其余步骤不阻塞） | 多数据源 → Code → Chart 可从聊天保存、按 Filter 刷新取新数据、保存快照；执行全程不调用 LLM |
| **M2 多步大数据** | Sandbox 输出暂存、manifest、Parquet 发布、Chat slot 的缓存安全替换（Workflow 自有 dataset 的 generation 已在 M1，**[RV-4]**） | M0.1、M1 | SQL → Code → Code → Chart 的大中间表可交接 |
| **M3 补充查询与参数增强** | `values` 驱动 SQL、Vertica 的参数支持（**[RV-1]**）、字面值一键提升为参数 | M1（与 M2 可并行） | “异常检测 → 补充查询 → 联合分析” |
| **M4 编辑与提取完善** | 类型化绑定控件、重命名、局部试运行、重复保存与过期标识 | M1–M3 | 插入/改绑节点、调试单节点更顺畅 |

M2 与 M3 互不依赖，可按资源并行；两者都只扩展 M1 的契约。

### 12.3 M0：风险验证

| 步骤 | 任务 | 完成标准 |
|---|---|---|
| 0.1 Sandbox 输出交接 | 在实际 `docker-compose.yaml` / `docker/dify-sandbox/` 部署中验证：能否挂载独立的可写输出根目录、输入缓存仍只读；Python 写入的 Parquet 能否被 Node 读回；stdout 的实际大小限制与截断位置；远程执行能否被真正终止。**[RV-2/RV-3]** 另验证：`enable_network: false` 下现有依赖（duckdb/pandas/pyarrow）与 skills 脚本正常；`worker_timeout` 的实际行为与可调范围；Node 写入共享缓存的 Parquet 能否被 sandbox 只读读取（inline 输入物化路径）；dify 响应中 stdout 的大小上限 | 书面结论写入 `docs/sandbox.md`：采用的挂载方式，或不可行时的替代方案（例如适配器提供文件导出接口）。结论决定 §4.3 的落地形式 |
| 0.2 ~~数据源能力盘点~~ SQL 执行方言与参数策略 **[RV-1]** | 对 Postgres 与 MySQL 两条主路径分别实测：(a) DuckDB ATTACH 路径下参数绑定的可行写法（预编译临时表 + COPY，或 `SET VARIABLE` + `getvariable()`）；参数化前后过滤是否下推到源库（用 EXPLAIN 或源端查询日志确认）；典型分析查询的源端拉取行数/字节与耗时。(b) `postgres_query()` / `mysql_query()` 直通路径的可用性与值位置 literal renderer 的覆盖范围。并确认：策略解析器对选定方言的兼容性；Vertica 路径的缓冲与规模上限 | 写入 `docs/data-sources.md`：选定的执行路径与 `sql_text` 方言、参数绑定写法、下推实测数据、策略解析方案、需要限制规模的 provider 清单 |

**[RV-10] go/no-go 与退路：**

| 步骤 | 通过条件（go） | 不通过时的退路 |
|---|---|---|
| 0.1 | 可写输出目录 + 只读输入可同时成立，Node 能读回 sandbox 写的 Parquet；`enable_network: false` 不破坏现有依赖 | M2 改为“由适配器/sidecar 提供文件导出接口”；若仍不可行，M2 降级为“多步之间只传 inline 表”，并在文档与 UI 中明确大中间表不支持（`DATASET_OUTPUT_UNSUPPORTED` 保留）。网络关闭若破坏某些 skills，列出受影响 skill，由其改为通过 SQL/工具获取数据，不重新打开网络 |
| 0.2 | 选定路径能在不拼接字符串的前提下绑定标量、日期、`IN` 列表，且策略解析与执行方言一致；关键查询的过滤与聚合位置符合预期，或拉取量在可接受范围内 | 若 (a) 无可靠绑定写法且 (b) 的 literal renderer 无法覆盖：M1 只交付无 SQL 参数的 Filter（参数只进入 Code 节点），SQL 参数推迟到 M3；若下推不足导致大表拉取不可接受：首版对 ATTACH 路径设置拉取规模上限，并优先实现 (b) |

### 12.4 M1：执行内核、生命周期与 Filter

M1 的边界：

- Code 输入可以是 inline 表或 SQL 产生的 dataset，**输出只能是 inline**，超过 inline 预算时返回 `DATASET_OUTPUT_UNSUPPORTED`。
- 参数来源支持常量、`@inputs.*`、`@context.now`；`@nodes.*.values.*` 绑定到 SQL 参数在 M3 启用，M1 编译时报“尚未启用”。
- SQL 值参数只在 M0.2 选定的~~provider~~执行路径上启用（覆盖 Postgres/MySQL/MariaDB），Vertica 报 `SQL_PARAMS_NOT_ENABLED`。
- Filter 只做静态表单（RJSF + `input_schema`）；动态下拉选项不在 M1。
- **[RV-2]** Sandbox 必须以 `enable_network: false` 运行；Code 节点 timeout 不超过 `worker_timeout`。

| 步骤 | 任务 | 前置 | 完成标准 |
|---|---|---|---|
| 1.0 Sandbox 配置与适配器接口 **[RV-2/RV-3]** | `enable_network: false`；Code timeout 上限对齐 `worker_timeout`；适配器返回原始 stdout/stderr，截断与掩码移到调用方；静态扫描移入共享 Code 服务，白名单加入 `nango`/`params`/`DATA_DIR`，修正 `re.compile(` 误报 | M0.1 | 代码联网失败（集成测试）；超长 stdout 中的结果帧完整可解析；Chat 显示仍被截断；Workflow 路径同样执行扫描 |
| 1.1 数据清理与迁移 | 按真实外键清空 Artifact/Workflow 测试数据并恢复必要的分类目录；`pnpm db:generate` 生成迁移：增加 `snapshot_inputs`、`snapshot_run_id`、`snapshot_spec_hash`、`snapshot_executed_at`、`snapshot_origin`、`last_run_error`，删除 `view_mode`，`workflow_id` 加唯一约束并改为 `ON DELETE SET NULL`（§8.3）；**[RV-5/RV-8/RV-9]** 新增 `workflow_run_result`、`chat_chart_result`，删除 `workflow.visibility`；清库时先清 `dashboard_artifact` / `dashboard` | 无 | 迁移 SQL 与 meta 同时提交；空库可启动；直接删除 Workflow 不会连带删除 Artifact；被 Dashboard 引用的 Artifact 删除返回“正在使用” |
| 1.2 共享字段与 Spec v2 | 新建共享字段文件（§5.2）；重写 Spec schema：`version: 2`、字符串 ID、三类节点、`.strict()`；按 §6.1 位置表解析引用 | 1.1 | 示例 11.1–11.3 解析通过；未知字段、不允许位置的引用、引用不存在的节点、环都返回带 JSON Pointer 的 issue |
| 1.3 NodeRegistry 与数据契约 | 统一 NodeDefinition（§5.2）；定义 TableSchema、TableData、PreviewData；数据层提供 inline 发布与已有 SQL Parquet 的读取接口 | 1.2 | PreviewData 绑定为表输入是编译错误；没有 `values_schema` 的 `values` 字段不能被引用 |
| 1.4 compile / lint | `compile(spec, selectedOutputs, catalog)` → ExecutionPlan + 全部 issues；祖先闭包；资源解析；替代现有 canonicalize/validate | 1.3 | 一次返回全部 issue；未选分支的资源缺失不影响选中输出；不执行用户 SQL/Python |
| 1.5 SQL 节点与共享提取服务 | 从 `extract_dataset_by_sql` 抽出共享提取服务；节点使用 Workflow inline 预算；超过 inline 时发布 dataset；硬上限触发即失败；对 M0.2 中先在 Node 内缓冲的 provider 设置实际生效的规模限制；**[RV-4]** Workflow dataset 写入不可变 generation 目录并实现 GC（§4.3）；**[RV-7]** 取消时关闭 DuckDB 连接中止查询 | 1.3 | 350 行结果在节点中是完整 inline，Chat 仍只看到预览；超过 1000 行时得到 dataset 而不是截断的 rows；Chat 复用同名 slot 时正在读取的节点不受影响；GC 不删除被引用的 generation |
| 1.6 Code 节点与 Python helper | 参数只在适配器中注入一次，不靠正则判断变量声明；实现 `nango.read_table / dataset_path / emit`；M1 结构化结果通过 stdout 中带边界标记的单个 JSON 帧传回，在任何显示截断、掩码处理之前解析；Chat `run_code_in_sandbox` 使用同一 helper；**[RV-3]** helper 以前导注入，inline 输入由 Node 物化为共享缓存 generation 中的 Parquet | 1.0、1.3 | 同一段代码在 Chat 与节点中结果一致；退出码 0 但未 `emit` 则失败；Markdown 表格或日志不能成为结果；注释或字符串中的 `params` 不影响注入 |
| 1.7 Chart 节点 | 完整表 + 模板的确定性装配；完整性检查、预算检查、空表、多数据集；Chat chart 工具支持 `data_ref`；**[RV-6]** 句柄旁路：`chat_chart_result`、`GET /api/outcomes/charts/<handle>`、前端按句柄渲染 | 1.3 | 饼图等无轴图合法；空表输出空状态图；超预算明确失败；**[RV-6]** 带 `data_ref` 的聊天图表在事件与 LLM 回放中只含句柄与摘要，UI 渲染的是完整表装配结果 |
| 1.8 执行器与 RunResult | 字符串 ID 调度、闭包执行、deadline 与 AbortSignal、重试分类、节点状态；RunResult 写入 `entity_run` / `entity_run_event`；所有事件类型统一 64 KB 兜底；**[RV-7]** 接入取消来源、进程级并发上限、Code 并发不超过 sandbox `max_workers` | 1.4–1.7 | 取消后不再启动新节点；失败事件中的超长 message 也被限制在上限内；失败 attempt 不发布输出 |
| 1.9 Artifact 生命周期 | GET 不执行；Refresh 强制取新数据、不写快照；RunResultStore；`POST /snapshot { runId }`；specHash 冲突与 `RESULT_EXPIRED`；静态 Artifact 无 Workflow；删除事务；**[RV-7]** 异步 Refresh（202 + runId、`/api/runs/stream`、按 runId 查询、取消端点、新 Apply 取消旧 run）；**[RV-8]** `workflow_run_result` 存储与清理；**[RV-5]** §8.4 权限矩阵与执行身份 | 1.8 | §12.8 中的生命周期、权限、并发与取消项全部通过 |
| 1.10 基础提取 | `build-from-events` 输出 v2；结构化 provenance；修复跨 run 的 seq 排序；`data_ref` 优先，Strategy Z+ 只作候选；先绑定再裁剪；`ready / needs_review / static` 分类；保存不重跑；**[RV-9]** 按 §9.3 映射表转换；**[RV-11]** 录制事件语料回归 | 1.4、1.7 | 跨轮次对话的提取顺序正确；未能绑定的 Chart 归为 `needs_review`；Chat 的 `row_limit` 不进入节点；**[RV-11]** 录制语料全部按期望分类与输出 |
| 1.11 最小编辑与 fixture 框架 | 整图 PATCH 走 compile 并校验 `baseSpecHash`；节点 PATCH 内部同样编译整图；只读依赖图、JSON 编辑、issue 定位显示；Vitest fixture runner 可替换指定源节点输出 | 1.4、1.8 | 非法编辑返回全部 issue；示例 11.1 有 fixture 测试 |
| 1.12 Workflow 输入 | 校验 §6.3 的 `input_schema` 子集；每次运行解析输入（请求值 > 默认值 > 缺失报错）；`@inputs.*` 绑定到 `code.inputs.params`；RunResult 与快照记录所用输入 | 1.4、1.8 | 未知、类型错误、缺失的输入在任何 I/O 之前被服务端拒绝；null 与 `[]` 语义符合 §6.3 |
| 1.13 SQL 值参数编译 | 实现 §6.2：值位置检查、native binding、标量与日期、`IN (@params.x)` 列表展开、空数组恒假；仅对 M0.2 选定的~~provider~~执行路径启用；事件中记录编译后的 SQL 与绑定值（仅管理员可见）；**[RV-1]** 策略检查作用于替换后的最终 SQL，解析方言与执行方言一致 | 1.5、1.12、M0.2 | 每个启用的~~provider~~执行路径用真实数据库覆盖 null、空数组、重复参数、引号/注释中的误用、类型错误；任何路径都没有字符串拼接 |
| 1.14 三态 Filter UI | 基于 RJSF 的 Filter 面板；`draftInputs / appliedInputs / snapshotInputs` 分离；Apply 调用 Refresh；Save Snapshot 保存 appliedInputs 对应的 runId；Reset 只重置表单；**[RV-7]** 运行进度、取消按钮、只接受最新 runId 的结果 | 1.9、1.12 | Apply 失败时已显示结果与其输入不变；保存的快照与当时显示的结果、参数一致；连续两次 Apply 只显示后一次的结果 |
| 1.15 Agent 引导与集成环境 **[RV-11]** | 更新 `extract_dataset_by_sql`、`run_code_in_sandbox`、`generate_echarts_config` 的工具描述与相关 prompt：SQL 方言、`nango.read_table/emit`、`data_ref`；搭建 §10.2 的 compose 集成环境与 CI job | 1.0、1.6、1.7 | 真实 LLM 冒烟中 Agent 使用新约定；集成 job 在依赖不可用时失败 |

**M1 验收：**

- 示例 11.1（两个数据源 → Code → Chart）完成“Chat 探索 → 保存 → Refresh → Save Snapshot”全流程；至少一条 SQL 结果超过 inline 预算、由 Code 通过 dataset 读取。
- 示例 11.2 通过 Filter 修改日期后刷新，结果随参数变化，保存的快照记录对应参数。
- 使用真实数据源和 sandbox；执行过程中没有 LLM 调用（按 §10.2 第 4 条断言）。
- **[RV-11]** 录制事件语料回归全部通过；内存基线测试通过；sandbox 联网测试失败（即被阻断）。

### 12.5 M2：多步大数据

| 步骤 | 任务 | 完成标准 |
|---|---|---|
| 2.1 输出暂存与 manifest | 按 M0.1 结论实现每个 run/node/attempt 独立的输出目录；定义 manifest schema；`nango.emit` 改为写 manifest，替代 M1 的 stdout 结果帧 | 结构化结果不再依赖 stdout；stdout 仅作诊断日志 |
| 2.2 发布与校验 | 服务端校验 manifest、路径归属、Parquet 实际存在、schema、行数与大小，然后发布 TableData（dataset）；使用不可变 generation ID；失败 attempt 不发布并清理 | 伪造路径、半写文件、schema 不符都不能成为 dataset |
| 2.3 Code dataset 输出 | `nango.emit(data=df)` 超出 inline 预算时由 helper 直接写 Parquet；`nango.dataset_path` 对 inline 输入物化临时文件；已验证的部署移除 `DATASET_OUTPUT_UNSUPPORTED` | 大表不经过全量 stdout，也不进入 Node 堆 |
| 2.4 缓存安全替换 | 将 `cache.ts` 中 `commitWriteSlot` 的 `rm` + `rename` 改为基于 generation 的发布；SQL 刷新与 Chat slot 重分配不覆盖正在被读取的数据。**[RV-4]** Workflow 自有 dataset 已在 M1.5 使用 generation，本步只处理 Chat 友好名称 slot | 并发刷新不破坏正在读取的节点 |

**M2 验收：** 真实 sandbox 中运行 SQL → Code 清洗 → Code 聚合 → Chart，中间表超出 inline 预算，通过 Parquet 交接完成。

### 12.6 M3：补充查询与参数增强

基础参数与 Filter 已在 M1 交付；M3 只扩展参数的来源和覆盖面。

| 步骤 | 任务 | 完成标准 |
|---|---|---|
| 3.1 `values` 驱动 SQL | 启用 `@nodes.*.values.*` → `sql.inputs.params`；复用 M1 的参数编译器；IN 展开、空数组恒假、超出参数预算明确失败 | 示例 11.3 在异常集合非空、为空、超限三种情况下行为正确 |
| 3.2 其余 provider 参数 | 为 M1 未启用的 provider（~~如 Vertica、DuckDB `COPY` 路径~~ **[RV-1]** 即 Vertica；Postgres/MySQL/MariaDB 已在 M1 随选定执行路径启用）实现并测试参数绑定或值位置 literal renderer | 每个新启用的 provider 通过与 M1 相同的参数测试集 |
| 3.3 字面值提升为参数 | Inspector 中选中 SQL/Code 里的字面值，一键生成 `input_schema` 字段并改写为引用；按 SQL 语法树的值位置改写，不做全局字符串替换；提取仍不自动创建 Filter | 改写后 SQL 语义不变，并通过编译 |

**M3 验收：** 示例 11.3 端到端运行。

### 12.7 M4：编辑与提取完善

| 步骤 | 任务 | 完成标准 |
|---|---|---|
| 4.1 类型化绑定控件 | 常量 / Workflow 输入 / 上游兼容输出三种模式，按字段只显示允许的模式和兼容类型 | `tables`、`chart.dataset` 不提供常量模式 |
| 4.2 重命名与删除 | rename 同时重写引用、`after` 和 `outputs`；删除被引用节点时拒绝，或在同一次提交中修复引用 | 插入 Code 并改绑 Chart 一次提交成功 |
| 4.3 局部试运行 | “测试当前节点”“运行到当前节点”；RunResult 标记为 `test`，不能被保存为快照 | 调试结果不污染快照 |
| 4.4 重复保存 | 基于内容与来源指纹区分幂等保存和更新；人工修改过的 Workflow 不被重新提取静默覆盖 | 需要用户明确选择更新或另存 |
| 4.5 快照过期标识 | 当 `snapshot_spec_hash` 与当前 hash 不一致时提示快照基于旧定义 | 旧快照仍可查看 |

后续可选（不在 M0–M4 内）：Agent 辅助提取与改图、动态 Filter 选项、HTML/Slides 数据绑定、Dashboard。

### 12.8 必测行为

每项标注首次必须通过的里程碑：

- [ ] **M1** 示例 11.1 完整运行；LLM 预览预算与 Workflow inline 预算互不影响。
- [ ] **M1** 两个数据源、分叉与汇合；选择一个 output 只执行其祖先闭包。
- [ ] **M1** 任何 PreviewData 都不能绑定为完整计算输入；超预算不静默截断。
- [ ] **M1** 空表保留 schema；null、日期、decimal/大整数和字段类型变化有确定行为。
- [ ] **M1** Python 退出码 0 但缺失或损坏结果仍然失败；不存在凭 Markdown 或日志猜出成功数据的路径。
- [ ] **M1** deadline 覆盖重试与 I/O；取消后没有新节点启动，失败 attempt 不发布半成品。
- [ ] **M1** Refresh 后快照内容、inputs、保存时间完全不变；按 runId 保存得到用户刚看到的结果。
- [ ] **M1** 刷新失败保留旧预览、旧快照及对应输入；过期或 Spec 不同的 runId 不能被静默保存。
- [ ] **M1** GET、编辑和静态作品读取不执行 Workflow。
- [ ] **M1** 跨轮次、并发调用的提取时序正确；未绑定的链路不被宣布为可刷新。
- [ ] **M1** 运行事件的成功、失败等所有形态都有最终字节上限。
- [ ] **M1** 注释或字符串中出现 `params` 不影响参数注入。
- [ ] **M1** 示例 11.2 通过 Filter 修改参数后刷新，结果随参数变化；Apply 失败不改变已显示结果；快照记录的参数与结果一致。
- [ ] **M1** SQL 参数覆盖 null、空数组、重复参数、引号/注释误用，以及每个启用 provider 的实际执行行为；任何路径都没有字符串拼接。
- [ ] **M1** 未知、类型错误、缺失的输入在任何 I/O 之前被服务端拒绝。
- [ ] **M1 [RV-1]** 策略检查作用于参数替换后的最终 SQL，解析方言与执行方言一致；选定执行路径的过滤/聚合位置与 M0.2 结论一致（有下推实测记录）。
- [ ] **M1 [RV-2]** Sandbox 中的代码尝试联网（socket、HTTP）失败；`timeout_seconds` 超过 `worker_timeout` 在编译期被拒绝。
- [ ] **M1 [RV-3]** 超过 20 000 字符的 stdout 中结构化结果帧完整解析；Chat 显示仍被截断；`nango`、`params` 不被静态扫描误报，`re.compile(` 不被误拦；Workflow 路径同样执行扫描。
- [ ] **M1 [RV-4]** Chat 用同名 slot 重新提取时，正在读取 Workflow dataset 的节点结果不变；GC 不删除运行中或被未过期 RunResult 引用的 generation；进程重启后遗留 run 目录被清理。
- [ ] **M1 [RV-5]** `user` 角色可 Apply 但不能 Save Snapshot；他人 runId 不能被保存；发起人看不到的私有数据源使对应节点以 `DATA_SOURCE_NOT_AVAILABLE` 失败；运行进度不推送给其他查看者。
- [ ] **M1 [RV-6]** 带 `data_ref` 的聊天图表：事件与 LLM 回放只含句柄与摘要；UI 渲染完整表装配结果；句柄过期时有明确提示。
- [ ] **M1 [RV-7]** 两个用户同时刷新同一 Artifact 互不干扰；同一用户连续两次 Apply，第一次被取消且只显示第二次结果；点“取消”或客户端断开后不再启动新节点，远端执行在 `worker_timeout` 内结束；超出并发上限的 run 排队。
- [ ] **M1 [RV-8]** 进程重启后，未过期的 runId 仍可被保存为快照；超过保留条数或过期的 runId 返回 `RESULT_EXPIRED`。
- [ ] **M1 [RV-9]** 被 Dashboard 引用的 Artifact 删除返回“正在使用”；§9.3 映射表中每类工具的提取结果符合预期。
- [ ] **M1 [RV-11]** 录制事件语料回归全部通过；约 100 万行的提取与 Code 交接中 Node RSS 增量低于阈值；Vertica 规模上限生效；集成 job 在依赖不可用时失败；注入抛错的模型 provider 后 Workflow 运行仍成功。
- [ ] **M2** SQL → Code 清洗 → Code 聚合的中间表超出 inline 预算时，真正通过 Parquet 交接，没有全量 stdout 回传。
- [ ] **M2** 真实 sandbox 验证输入只读、输出暂存可读回、发布后下一节点可以消费；不能只测 mock 的请求体。
- [ ] **M3** 示例 11.3 在异常集合非空和为空时都能运行；上游 values 正确绑定到后续 SQL。
- [ ] **M3** 新启用参数的 provider 通过与 M1 相同的参数测试集。
- [ ] **M4** 插入中间 Code、重绑 Chart、修改参数可以一次提交并通过整图校验；无关分支不影响选中输出的能力判断。
- [ ] **M4** 同一 outcome 重复保存和编辑后再次保存行为正确。

清空旧数据时按真实外键关系处理 Artifact 树和已有引用，恢复必要的分类目录；不建设“解绑 Workflow、保留全部旧 Artifact”的兼容迁移路径。运行历史保留或清理的范围单独确定，不能顺带删除其他业务数据。

验证命令沿用 `pnpm test`、`pnpm check-types`、`pnpm lint`、`pnpm build`；新增集成测试注明所需的数据库与 sandbox。**[RV-11]** 集成测试使用 §10.2 第 3 条的 compose 测试 profile 与独立 CI job，依赖不可用时失败。

## 13. 当前代码基线与改造落点

以下是当前事实，不是对 v2 完成度的声明。

### 13.1 已有基础

此前加入的裁剪保护、缓存 sourceId 检查、快照 config 修正、参数传递和事件摘要可以按实际价值复用，但不因此把其中的临时 API 保留为 v2 契约。已确认的问题在 M1 中作为回归测试：正则判断参数声明会被注释误导、失败事件绕过 64 KB 上限、跨 run 的 seq 重排。

当前与本方案直接相关的事实：

- `artifact.workflow_id` 外键为 `ON DELETE CASCADE`（删除 Workflow 级联删除 Artifact），且没有唯一约束；`view_mode` 仍控制 GET 是否执行（§8.3、M1.1 处理）。
- `ExtractDatasetArgs`（`src/lib/data-sources/runtime-tools.ts`）与 `RunInSandboxArgs`（`src/lib/sandbox/runtime-tools.ts`）各自内联字段定义，节点注册表又另写一份（§5.2、M1.2 处理）。
- `commitWriteSlot`（`src/lib/data-sources/cache.ts`）先 `rm` 再 `rename`，正在读取的消费者可能读到不存在的目录（~~M2.4 处理~~ **[RV-4]** Workflow 自有 dataset 在 M1.5 绕开，Chat slot 在 M2.4 处理）。
- 当前 sandbox 适配器只交换代码与 stdout/stderr，没有正式的输出文件发布接口（§4.1、M0.1/M2 处理）。
- **[RV-1]** Postgres/MySQL/MariaDB 的提取经 DuckDB `ATTACH` + `COPY (<SQL>) TO parquet` 执行（`duckdb-extension.server.ts`），SQL 为 DuckDB 方言且不接受绑定参数；数据源策略按 PG/MySQL 方言用 `node-sql-parser` 解析（`policy.ts`）。Vertica 走 `vertica-nodejs`，全量结果先读入 Node 堆。DuckDB 的超时/取消只是 `raceWithTimeoutAndAbort` 停止等待（§6.2、M0.2、M1.5 处理）。
- **[RV-2/RV-3]** dify-sandbox 配置为 `enable_network: true`、`worker_timeout: 60`、`max_workers: 10`；请求体只有 `{language, code}`；stdout 在适配器内被掩码并截到 20 000 字符；静态扫描只在 chat 工具中执行（§4.1、M1.0 处理）。
- **[RV-4]** 缓存没有过期清理；`commitWriteSlot` 先 rm 再 rename（§4.3、M1.5 处理 Workflow 自有 dataset，M2.4 处理 Chat slot）。
- **[RV-5]** Refresh 路由为 `withSession`（任何角色）且按查看者可见的数据源执行；Save Snapshot 仅限作者；`artifact.visibility` 与 `workflow.visibility` 并存（§8.4、M1.9 处理）。
- **[RV-6]** `generate_echarts_config` 是纯校验器，图表数据由 LLM 写入 `option.dataset.source`，前端从 `tool_call_result` 渲染，同一事件回放进 LLM 上下文（§9.1、M1.7 处理）。
- **[RV-7]** Refresh 在 HTTP 请求内同步执行；`executeWorkflow` 的 `AbortController` 从未被 abort（§8.2、M1.8/M1.9 处理）。
- **[RV-9]** `dashboard` / `dashboard_artifact` 表已存在（`artifact_id` 为 `ON DELETE RESTRICT`），尚无应用代码使用；v1 支持 MCP tool / agent / JavaScript / `code_file` 节点；存在快照驱动的 Slide + Workflow 组合（§1.6、§8.3、§9.3、M1.1/M1.10 处理）。

### 13.2 文件级改造落点

| 契约 | 主要文件 | 里程碑 |
|---|---|---|
| 共享字段 | 新增 `src/lib/workflows/fields.ts`；`src/lib/data-sources/runtime-tools.ts`、`src/lib/sandbox/runtime-tools.ts`、`src/lib/outcomes/runtime-tools.ts`（chart 工具） | M1 |
| Spec、引用、编译 | `src/lib/workflows/spec/schema.ts`、`refs.ts`、`hash.ts`；`canonicalize.ts` → `compile.ts`；`validate.ts` → lint | M1 |
| 注册表与节点 | `src/lib/workflows/nodes/registry.ts`、`sql-node.ts`、`code-node.ts`、`chart-node.ts`、`schema-validator.ts`、`with-retries.ts`；移除 `agent-node.ts`、`tool-node.ts` | M1 |
| 执行器 | `src/lib/workflows/engine/scheduler.ts`、`in-process.ts`、`execution-context.ts`（去掉嵌入式插值）、`cache.ts`；`src/lib/workflows/error.ts` | M1 |
| 数据层与提取服务 | `src/lib/data-sources/runtime-tools.ts`（抽出共享服务）、`cache.ts`、`cache-root.ts`、`limits.ts`、`policy.ts`、`lookup.ts`、各 provider 的 `*/extract.server.ts` 与 `adapter.ts` | M1（预算、generation 发布与 GC、选定执行路径的参数）、M2（Chat slot 安全替换）、M3（Vertica 参数） |
| Sandbox | `src/lib/sandbox/adapters/service/adapter.server.ts`；`src/lib/sandbox/code-output.ts`、`output.ts`、`path-mapper.ts`、`runtime-tools.ts`；`docker/dify-sandbox/`（`config.yaml`：`enable_network`、`worker_timeout`）、`docker-compose.yaml`；`static-scan.ts`、`code-ast-scan.ts`（移入共享服务、白名单） | M0、M1（网络与超时配置、原始 stdout、helper 前导、结果帧、扫描）、M2（输出目录） |
| 提取 | `src/lib/workflows/build-from-events.ts`、`src/lib/artifacts/coalesce-tool-calls.ts`、`save-artifact.ts`、`save-deps.server.ts`；provenance 来源 `src/lib/copilot/event-reconstruction.ts` | M1、M4 |
| 生命周期与运行记录 | `src/lib/artifacts/get-artifact.ts`、`refresh-artifact.ts`、`save-snapshot.ts`、`execute-workflow.ts`、`bundle.ts`、`service.ts`、`update-artifact.ts`、`workflow-run-recorder.ts`；新增 `run-result-store.ts`（**[RV-8]** 基于 `workflow_run_result` 表）；`src/lib/runner/admission.ts`（**[RV-5]** workflow 分支改按 Artifact 可见性） | M1 |
| API（均位于 `src/app/api/artifacts/` 下） | `[id]/route.ts`、`[id]/refresh/route.ts`、`[id]/snapshot/route.ts`、`[id]/nodes/[nodeId]/route.ts`、`save/route.ts`；**[RV-7]** 新增 `[id]/runs/[runId]/route.ts`、`[id]/runs/[runId]/cancel/route.ts` | M1、M4 |
| 聊天图表句柄 **[RV-6]** | `src/lib/outcomes/runtime-tools.ts`、`schema.ts`；新增 `src/app/api/outcomes/charts/[handle]/route.ts`；前端 `ChartPreviewCard` 改为按句柄取 option | M1 |
| Schema 与迁移 | `src/lib/db/schema.ts`（`ArtifactTable`、`WorkflowTable`；**[RV-5/RV-8/RV-6]** 新增 `workflow_run_result`、`chat_chart_result`，删除 `workflow.visibility`）、`src/lib/db/migrations/`（生成的 SQL + meta） | M1 |
| UI | `src/components/main-panels/ArtifactDetail.tsx`、`ArtifactFilterPanel.tsx`；`src/components/workflow-graph/`（`WorkflowGraph.tsx`、`inspector/*`） | M1（已保存/本次结果分离、issue 显示、Filter 面板）、M3（字面值提升为参数）、M4（绑定控件） |
| 文档 | `docs/workflow.md`、`docs/artifact-filters.md`、`docs/data-sources.md`、`docs/sandbox.md`、`AGENTS.md` | 每个里程碑同步更新 |

`docs/workflow.md`、`docs/artifact-filters.md`、`docs/data-sources.md`、`docs/sandbox.md` 目前包含旧行为或过时描述。每个里程碑完成时同步更新对应文档，M1 完成后由 `docs/workflow.md` 作为 v2 已实现行为的权威参考；在此之前以代码确认当前能力、以本文界定重构目标，不混写“现状”和“已设计”。

## 14. 外部经验：借鉴机制，不引入平台

| 项目 | 本方案采用 | 不采用 |
|---|---|---|
| Windmill | 显式参数来源、JSON Schema 输入、单节点/选定输出试运行思路 | 任意 JS 绑定表达式、worker 集群、审批/循环产品体系 |
| ZEN Engine | 输入/输出 schema 和可检查执行轨迹 | 规则语言、决策表；不把 schema 有效等同于完整或正确分析 |
| Flowcraft | 可序列化定义、节点注册表、结构化 lint/运行错误、取消契约 | 任意可变共享 context、第二个运行时、分布式恢复 |
| Node-RED | 单一职责节点、类型化编辑控件、错误定位 | 可变消息总线、隐式 flow/global 状态 |
| dbt | 显式依赖、编译 SQL 预览、样例逻辑测试与真实数据检查分离 | Jinja 参数拼接、仓库物化/增量模型平台 |
| Dagster | 计算与数据存取分离、数据/顺序依赖分离、按输出选执行范围 | daemon、分区回填、完整资产目录和版本管理 |

参考来源：

- [Windmill Flow Architecture](https://www.windmill.dev/docs/flows/architecture)
- [Windmill Flow Testing](https://www.windmill.dev/docs/flows/test_flows)
- [Windmill Shared Directory](https://www.windmill.dev/docs/core_concepts/persistent_storage/states_resources_shared_directory)
- [ZEN / GoRules Node Types](https://docs.gorules.io/developers/jdm/node-types)
- [Flowcraft Declarative Workflows](https://flowcraft.js.org/guide/declarative)
- [Flowcraft Static Analysis](https://flowcraft.js.org/guide/static-analysis)
- [Node-RED Node Design](https://github.com/node-red/node-red.github.io/blob/main/docs/creating-nodes/index.md)
- [dbt Unit Tests](https://github.com/dbt-labs/docs.getdbt.com/blob/current/website/docs/docs/build/unit-tests.md)
- [Dagster I/O Managers](https://docs.dagster.io/api/dagster/io-managers)

这些项目为显式定义、执行和验证提供经验，不能替 Nango 证明任意聊天历史都能被机械还原为可信 Workflow。

## 15. 本轮不做的事情

Dataset 高级缓存策略、复杂权限、Dashboard 发布共享、动态 Filter 选项、HTML/Slides 数据绑定、结构化 Agent 输出、AI 辅助提取/改图、循环/条件/子流程、完整版本历史均后续按业务需要增加。

**[RV-9] 有意的功能回退：** v1 的 MCP tool 节点、agent 节点、JavaScript 代码节点与 `code_file` 不迁移到 v2。基于 MCP/REST API、SSH、Agent 输出或 skill 脚本生成的图表在 v2 中保存为静态作品或 `needs_review`（§9.3），不再可刷新；需要时以新的节点类型在同一契约上扩展。**[RV-5]** “以作者授权让他人刷新”的共享开关不在本轮（§8.4）。

预先定义的“发现异常 → 额外 SQL → 根因分析”已经能由当前三个节点和参数绑定表达；如果运行中需要发明新的分析计划，则回到 Chat/编辑阶段，不让轻量执行器承担 Agent 推理职责。
