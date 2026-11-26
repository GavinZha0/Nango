# Nango 长周期异步任务、任务看板与 Runtime Core 升级方案

> 状态：**待审核（Proposal）**  
> 关联文档：[docs/architecture.md](./architecture.md) · [docs/orchestrator.md](./orchestrator.md) · [docs/workflow.md](./workflow.md)

---

## 1. 背景与当前架构痛点

结合对 Nango 现有代码实现（`src/lib/runner/`、`src/lib/workflows/`、`src/lib/db/schema.ts`、`src/components/layout/RightPanel.tsx`）的核查，Nango 已经具备 `entity_run` / `entity_run_event` 黑板表、SSE 通道（`/api/runs/stream`）、`notification` 收件箱、`trace` 历史取证页面以及 DAG Workflow 引擎（`inProcessWorkflowEngine`）。

但在向**“企业级多任务协同 Agentic Workbench”**演进时，当前存在以下核心断点：

1. **异步执行停留在“内存 Promise + 发射后不管”**
   * `Runner.startAsync`（`src/lib/runner/runner.ts`）直接在调用栈内存里执行 `.subscribe()` 并挂载 `1800s` `setTimeout`。无持久化任务队列与并发控制；一旦进程重启，运行中任务会被 `recoverStrandedRuns` 统一标为 `failed`，无法断点续跑。
2. **缺少 Supervisor 唤醒闭环**
   * 后台任务完成后仅写入 `notification` 表并推送前端铃铛，**Supervisor 不会被唤醒**（即 `docs/orchestrator.md` §11 记录的 Gap），多阶段后台任务无法自动接力，必须人工复制结果回主对话。
3. **缺少细粒度实时进度旁路与活跃任务看板**
   * `PersistingAgent`（`src/lib/runner/persisting-agent.ts`）只写 `entity_run_event` 表，**未向 `EventBus` 发布进度事件**；前端无法实时看到后台任务当前正在调用哪个工具或处于第几步，也缺少集中管理活跃任务的界面。
4. **异步 HITL（挂起/授权/补充信息）未实现**
   * `entity_run.status` 虽预留了 `awaiting_input` / `paused` 枚举，但无状态快照持久化表，后台任务无法挂起释放算力并在人类审批后恢复。
5. **Supervisor 全局委托缺少 Team 边界，Workflow 尚未融入自主编排闭环**
   * 内置 `builtin_agent` 尚无 Team 实体，Supervisor 将所有可见 Agent 扁平内联进系统提示词（全局任意委托），上下文易膨胀且缺少团队协作边界；
   * `src/lib/workflows/` 已有完整的 DAG 引擎（含 `agent` / `sql` / `code` / `chart` / `tool` 节点及并发调度），但运行状态仅存内存（`ExecutionState`），且主要服务于 Artifact 刷新，**既不支持异步挂起恢复，也未打通“Supervisor 派发 Workflow”与“Agent 辅助生成/修改 Workflow”闭环**。

---

## 2. 近期与中期目标

### 2.1 近期目标（P0 – P1：打通异步任务闭环与看板）
1. **右侧面板新增 `Task` Tab（Chat / History / Task）**：每个任务卡片对应一个独立运行的 Agent / Team / Workflow 实例，展示实时进度、支持就地审批/补充输入、一键回主对话继续或确认归档；历史全量记录仍归属 `/trace`。
2. **PG 持久化任务队列**：基于 PostgreSQL `SKIP LOCKED` 替换纯内存异步执行，支持排队、并发上限、租约心跳与可恢复重启。
3. **异步 HITL 断点恢复**：支持后台任务在 `awaiting_input` 时保存快照并释放资源，用户通过 `Task` Tab 卡片授权/输入后断点续跑。
4. **Supervisor 唤醒闭环**：通过 `thread_mailbox` + 会话互斥锁，实现后台完成后的“在线空闲直推 / 忙碌排队 / 离线进 Inbox 一键继续”。

### 2.2 中期目标（P2 – P3：Team 边界与 Workflow 融合）
1. **引入内置 `Agent Team`**：支持在 Team 内定义 Leader、成员白名单与内部委托（`A → B → C` 收敛在 Team 内部流转，而非全局任意委托）。
2. **Workflow 引擎持久化与自主编排闭环**：为 `inProcessWorkflowEngine` 补齐节点级 Checkpoint 与 `awaiting_input` 节点；允许 Supervisor 直接派发 `workflow` 作为长周期后台任务，并允许 Agent 辅助生成/修改 `WorkflowTable` 定义。

---

## 3. 详细技术方案

### 3.1 PostgreSQL Schema 扩展（零外部中间件）

依托现有 PostgreSQL 18，不做 Redis/Kafka/Temporal 重运维引入，做以下最小增量扩展：

#### (1) 扩展 `entity_run` 表
* **看板与归档字段**：
  * `progress_pct` (`integer`, default `0`)：进度百分比。
  * `current_step` (`text`)：当前步骤摘要（如 `"正在调用 read_kb_page"`），供看板卡片直接渲染，无需 `JOIN entity_run_event`。
  * `acknowledged_at` (`timestamp`)：`NULL` 表示用户尚未在看板确认；非 `NULL` 表示已确认归档，从 `Task` Tab 移除（记录仍在 `/trace` 可查）。
* **PG 队列与租约字段**：
  * `attempt` (`integer`, default `0`)、`max_attempts` (`integer`, default `1`)
  * `locked_until` (`timestamp`)、`worker_id` (`text`)
  * 索引：`CREATE INDEX entity_run_queue_idx ON entity_run (created_at) WHERE status = 'queued'`。

#### (2) 新增 `run_checkpoint` 表（异步挂起与断点续跑）
* `run_id` (`uuid`, PK, FK → `entity_run.id` ON DELETE CASCADE)
* `kind` (`text`)：`'agent_turn' | 'workflow_dag'`
* `messages` (`jsonb`)：挂起时的完整消息栈（built-in）或 Workflow 各已完成节点的输出快照
* `pending_action` (`jsonb`)：挂起等待的 `toolCallId`、工具名或 A2UI 表单 Schema（含审批按钮/输入字段定义）
* `updated_at` (`timestamp`)

#### (3) 新增 `thread_mailbox` 表（Supervisor 唤醒邮箱）
* `id` (`uuid`, PK, `default uuidv7()`)
* `thread_id` (`uuid`, not null)
* `source_run_id` (`uuid`, FK → `entity_run.id` ON DELETE CASCADE)
* `status` (`text`, not null)：`'pending' | 'delivered' | 'dismissed'`
* `payload` (`jsonb`, not null)：`{ summary, status, artifactIds, entityName }`
* `created_at` (`timestamp`)

#### (4) 新增内置 Team 表（P2）：`builtin_team` & `builtin_team_member`
* `builtin_team`：`id`, `name`, `description`, `leader_agent_id` (FK → `builtin_agent.id`), `orchestration_policy` (`jsonb`, 如最大轮次/内部委托模式), `visibility`, `owner_id`
* `builtin_team_member`：`team_id`, `agent_id`, `role_in_team`, `can_delegate_to`（显式限定团队内可委托的成员子集）。

---

### 3.2 Runner Core 升级

#### (1) Enqueue 与 Worker Loop 解耦
* **`delegate_async` / `runner.start({ mode: "async" })`**：仅插入 `entity_run (status = 'queued')` 并发送 `run_started` 事件，立即返回 `runId`。
* **PG Queue Worker Loop**：进程内启动固定并发度（可配置 `runner.max_async_concurrency`，如 `5`）的 Worker，通过事务抢占：
  ```sql
  SELECT id FROM entity_run
  WHERE status = 'queued'
  ORDER BY id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  ```
  抢占后将 `status` 置为 `running`，设置 `locked_until = NOW() + interval '60s'` 并由运行中的订阅定时续租（Heartbeat）。
* **跨进程演进预留**：若未来将 Worker 拆为独立进程，通过 PostgreSQL `LISTEN / NOTIFY` 将进度与终态事件桥接至 Web 进程的 `EventBus`。

#### (2) `PersistingAgent` 实时进度旁路
* 在 `src/lib/runner/persisting-agent.ts` 写入 `entity_run_event` 时，同步对 `TOOL_CALL_START`、`TOOL_CALL_END`、`workflow_node_completed` 做节流处理（如最多 500ms 一次）：
  1. 更新 `entity_run.current_step` 与 `progress_pct`；
  2. 向 `EventBus` 发布 `RunProgressEvent { kind: "run_progress", runId, ownerId, currentStep, progressPct }`，经 `/api/runs/stream` 直推前端看板，**完全不经过 Supervisor 上下文**。

#### (3) 异步 HITL：`SuspendRunSignal` 与 `runner.resume()`
* 扩展 `src/lib/agent-pipeline/` 的拦截器：当 `mode === "async"` 且工具命中高风险审批（或调用 `request_human_input`）时，不再阻塞 Promise，而是抛出 `SuspendRunSignal(pendingAction)`：
  1. Runner 捕获信号 → 将当前消息栈与 `pendingAction` 写入 `run_checkpoint`；
  2. 更新 `entity_run.status = 'awaiting_input'`，释放 `mcpProviderPool` 借用与 Worker 槽位；
  3. 触发 `tool_approval_requested` SSE 帧及一条 `notification` 提醒用户。
* 新增 `POST /api/runs/[id]/resume`：校验 `ownerId` 与审批/输入参数 → 从 `run_checkpoint` 恢复上下文并注入用户响应 → 将 `entity_run` 重新置为 `queued` 交由 Worker 续跑。

#### (4) Continuation Dispatcher（Supervisor 唤醒闭环）
在 `entity_run` 进入终态（`succeeded` / `failed`）时，若 `initiator === "orchestrator"` 且存在 `threadId`：
1. 写入 `thread_mailbox (status = 'pending')`。
2. 尝试获取该 `threadId` 的 PG 会话互斥锁（`pg_try_advisory_xact_lock`）并检查活跃态：
   * **用户在线且当前 Thread 空闲**：以 `initiator: "system"` 发起一次 `runner.start({ mode: "sync" })`，将 Mailbox 摘要作为 `role: "system"` 内部消息注入，唤醒 Supervisor 汇报并标记 Mailbox 为 `delivered`。
   * **Thread 忙碌（用户正在对话）**：保持 `pending`；待当前对话 `finalizeRun` 结束时检查并排空 Mailbox，顺势追加汇报。
   * **用户离线**：不唤醒 LLM（节省 Token），保留 `notification` 与看板卡片上的 **`[继续对话]`** 按钮，待用户上线点击后按需唤醒。

---

### 3.3 右侧面板 `Task` Tab 看板与系统边界

#### (1) 模块职责严格三分
| 入口 | 定位 | 数据范围 | 核心动作 |
|---|---|---|---|
| **右侧 `Task` Tab** | **活跃工作台**（取代独立全屏看板） | `queued` / `running` / `awaiting_input` / `paused` + **未确认终态**（`acknowledged_at IS NULL`） | 看实时进度、取消任务、就地审批/输入、点击产物、`[继续对话]`、`[确认归档]` |
| **顶部铃铛 / `/notifications`** | **事件提醒通道** | 终态通知 + 紧急审批提醒 | 弹 Toast / 红点提醒；点击定位到 `Task` Tab 对应卡片 |
| **`/trace` & `/trace/[id]`** | **全量历史与取证** | 所有历史 `entity_run`（含已确认归档）+ `entity_run_event` | 检索历史任务、查看每步工具入参/耗时/错误栈 |

#### (2) `RightPanel.tsx` 改造约束
* 在 `src/store/sidebar.ts` 扩展 `RightTab = "chat" | "history" | "task"`。
* 在 `src/components/layout/RightPanel.tsx` 增加第三个 Tab，显示角标数字（`running + awaiting_input + unacknowledged` 数量）。
* **关键约束**：切换至 `task` Tab 时保持 `<CopilotKitProvider>` 挂载不销毁（仅隐藏 `ChatPanelBody`），确保正在流式输出的同步对话不会断连。

---

## 4. 面向未来演进：Nango 整体架构与 Runtime Core 升级盘点

为支撑你提到的**长周期异步任务、进度看板、Workflow 改进、Supervisor 编排增强与 Agent Team 支持**，整个项目四层架构需要同步进行如下系统性升级：

| 架构层 | 现有状态 | 需要改进与升级的核心项 |
|---|---|---|
| **Surface（交互层）** | `RightPanel` 仅含 `Chat`/`History`；Outcomes 与 Artifacts 已成型。 | 1. 新增 `Task` Tab 与可交互微卡片（内嵌 A2UI 审批/输入表单）；<br>2. 新增 Team 编排与成员配置 UI；<br>3. Workflow 编辑器增加与 Copilot 对话联动的“AI 生成/修改 Workflow”交互入口。 |
| **Bridge（桥接与能力层）** | 四套适配器完善；MCP 连接池、KB、Skills、DataSource 就绪。 | 1. **连接池生命周期适配挂起**：确保 `awaiting_input` 挂起时能立即归还 `McpProviderPool` 借用，避免长周期任务长期占死外部 MCP 连接；<br>2. **A2UI 标准化表单桥接**：将后台 `request_human_input` 与 Guardrails 审批统一序列化为轻量 A2UI JSON Schema。 |
| **Runtime Core（执行内核）** | 单体同步/内存异步 Runner；`inProcessWorkflowEngine` 仅支持内存 DAG；无 Team 实体。 | 1. **Runner 队列化与断点化**：`SKIP LOCKED` 队列、租约心跳、`run_checkpoint` 挂起/恢复、`thread_mailbox` 唤醒；<br>2. **Supervisor 编排增强**：支持并行扇出汇聚（Fan-out/Fan-in 批处理汇报，补齐 `docs/orchestrator.md` §6 Debate/Parallel 原语）、支持将 `workflow` 和 `team` 作为一等实体直接委派；<br>3. **Workflow 引擎升级**：将 `ExecutionState` 接入 `run_checkpoint` 支持跨节点持久化与人工审批节点（`approval_node`）；<br>4. **Team 作用域隔离**：`formatCatalogBlock` 支持按 Team 隔离可见成员，支持 Team 内部 `A → B → C` 状态接力而不污染全局上下文。 |
| **Harness（治理与闭环）** | RBAC、AES-256-GCM、Guardrails、Verification/Evaluation/Web Auto 齐全。 | 1. **Token 与成本计量**：解决 CopilotKit `BuiltInAgent` 吞掉 `usage` 字段的问题（`docs/orchestrator.md` §7），为长周期异步任务与 Team 增加单次运行预算上限（`max_tokens` / `max_steps`）；<br>2. **Agent 辅助构建 Workflow 闭环**：允许开发者角色 Agent 读取当前对话/Outcomes 产出并调用结构化工具校验生成 `WorkflowSpec`（复用 `src/lib/workflows/spec/validate.ts`），再联动 Verification 做回归验证。 |

---

## 5. 推荐实施阶段

1. **阶段一（PG 队列 + `Task` Tab 进度看板）**：扩展 `entity_run` 字段，落地 `SKIP LOCKED` Worker、`PersistingAgent` 实时进度推送，以及 `RightPanel` 的 `Task` Tab（含确认归档联动 `/trace`）。
2. **阶段二（异步 HITL + Supervisor 唤醒闭环）**：落地 `run_checkpoint` 与 `thread_mailbox`，实现后台审批卡片挂起/恢复，以及任务完成后的自动续行唤醒。
3. **阶段三（Agent Team + Workflow 闭环增强）**：落地 `builtin_team` 与团队内委托，升级 `inProcessWorkflowEngine` 支持 Checkpoint 与人工节点，并开放 Supervisor 派发 Workflow 及 Agent 辅助生成 Workflow 能力。
