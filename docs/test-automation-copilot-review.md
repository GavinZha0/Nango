# Test Automation Copilot — 综合评审报告

Status: Review Report · Target Subsystems: Verification, Evaluation, Web Auto, Tester Agent · Date: 2026-09-05

本文档是三位评审员（主评审、CO、GLM）对「AI 辅助自动化测试功能」独立评审后的合并结论。所有问题均已对 `src/` 与 `docs/` 逐条核实代码。评审对象覆盖：三大测试模块统一（UI/断言/混合判决引擎）、`tester` agent 角色与 13 个专用工具、CopilotKit 上下文状态共享、以及测试模块的 RBAC / 可见性模型。

---

## 0. 结论概要

统一方向正确、基础扎实：断言引擎已真正收敛为单一真相源（`src/lib/assertions`），`CASE_CATEGORY_CONFIG` / `CATEGORY_TYPE_MAPPING` / `formatAssertionResultItem` 等抽取有效消除了三分支的写漂移；tester 工具通过工厂 + closure 注入 RBAC 的写法独立、干净；**工具层（tester tools）的 RBAC 实现整体正确**。测试覆盖充分（1800+ 单测全绿）。

问题集中在两个结构性层面：
1. **HTTP API 路由层的 RBAC 存在多处真漏洞**（IDOR 读写、越视执行、可见性门禁缺失），且与工具层「一套严、一套松」双轨并存。
2. **`js_expression` 断言沙箱用 `node:vm` 而非隔离沙箱**，在单节点多租户 + 共享 suite 可编辑的叠加下构成 editor → 服务器 RCE 提权面，而文档却声称「isolated-vm」沙箱。

两位评审对第 2 条的严重度存在分歧（P0 vs P2），本报告采纳更审慎的一致结论：**RCE 面真实存在，须至少修正文档措辞并评估真隔离方案**。

---

## 1. P0 — 必须立即修复

### F1. `js_expression` 断言存在 VM 逃逸 → editor 角色 RCE
- 位置：`src/lib/assertions/evaluator.server.ts:373-399`（`runInNewContext`）、`src/lib/assertions/evaluator.server.ts:31,395`。
- 事实：`node:vm` 官方明确不是安全边界。沙箱上下文里注入的 `input` / `result` / `root` / `page` 及 `runContext` 展开成员均为**宿主 realm 对象**（DB 解析的 JSON、MCP 响应、Playwright 页面句柄），会把宿主的 `Function` 构造器带进沙箱，`input.constructor.constructor("return process")()` 即可越界；250ms 超时只限同步 CPU，逃逸后可注册异步回调。可读取 `process.env`（含 `CREDENTIAL_ENCRYPTION_KEYRING`）、任意 `require`。
- 攻击面：能写断言的人是 editor + tester 的 `create/update_test_case`；editor 可编辑任意 public suite 断言（见 F5/F7 的可见性缺口），构成**跨用户注入**。
- 修复：
  1. **立即**：修正 `docs/web-auto.md:96` 与 `src/lib/testing/types.ts:51` 中「isolated-vm / sandboxed」的不实表述。
  2. **短期**：上下文只传 `JSON.parse(JSON.stringify(...))` 深拷贝的纯数据、冻结原型、剔除 `page` 等宿主句柄（注意这会牺牲部分断言能力，需评估）。
  3. **长期**：换真隔离（`isolated-vm` 或子进程 worker）。

### F2. `DELETE /api/verification-servers/[id]` 无归属检查的全量级联删除
- 位置：`src/app/api/verification-servers/[id]/route.ts:14-26`。
- 事实：仅 `withEditor`，无任何 `canDeleteResource`，直接 `db.delete(VerificationSuiteTable).where(mcpServerId = id)`，级联清空该 MCP server 下所有 suite / case / run / result。
- 影响：任意 editor 可一键摧毁任一人（含私有）MCP 验证资产，违反 AGENTS.md §3「仅原作者或 Admin 可删除」。
- 修复：先查该 `mcpServerId` 下 suites 逐个 `canDeleteResource`，否则将接口升级为 `withAdmin`。

---

## 2. P1 — 高优先级

### F3. 越权写他人私有 suite（IDOR 写）
- 位置：`src/app/api/verification-cases/route.ts:33-39`。
- 事实：`POST` 创建 case 时，若请求体带 `suiteId` 直接采用（`suiteId = reqSuiteId`），不做 `loadVisibleSuite` / `canEditResource`；只有懒创建路径才限定 `createdBy = session.user.id`。对照组：eval / web-auto 建 case 路由均有 suite 级 edit 检查；tester 工具 `create-test-cases.ts:179` 也正确做了 `canEditResource`。
- 修复：`reqSuiteId` 分支加载 suite 并 `canEditResource` 校验，与工具层对齐。

### F4. 越权读他人私有评测结果（IDOR 读）
- 位置：`src/app/api/eval-cases/[id]/latest-result/route.ts:12-27`。
- 事实：`GET` 按 id 裸 `getCaseById` 加载，handler 未解构 `session`，零权限校验。editor 遍历数字 id 即可读取他人私有 suite 的最新评测结果（含完整对话与输出）。这是 API 树中唯一「按 id 加载、无任何权限检查」的路由。
- 修复：加载 case 所属 suite，套 `canViewResource`，不可见返回 404。

### F5. `web-auto` suite PATCH 缺失 `canChangeVisibility` 门禁
- 位置：`src/app/api/web-auto-suites/[id]/route.ts:47-71`。
- 事实：PATCH schema 接受 `visibility` 与 `enabled`，但只检查 `canEditResource`。由于 editor 可互编 public 资源，任意 editor 都能把同事的 public suite 改成 private（把资源从团队里藏走）或禁用。对照组：verification / eval 均正确拆分了「内容编辑」与「可见性编辑」（`canChangeVisibility`）。
- 修复：当 body 含 `visibility`/`enabled` 时改用 `canChangeVisibility`。

### F6. 按 MCP Server 维度运行验证可「越视执行」私有 suite
- 位置：`src/app/api/verification-runs/route.ts:66-104` + `src/lib/verification/storage.ts:157-190`。
- 事实：`mcpServerId` 分支只对 server 做 `visibilitySql`（view 级）检查 + enabled 检查，随后 `startServerRun` 选中该 server 下**所有** enabled case（`where(mcpServerId = ..., enabled = true)`，无可见性过滤），包括他人私有 suite 的 case；而同一端点的 suiteId 分支要求 `canEditResource` + enabled（`route.ts:37-49`）。
- 影响：越视执行消耗资源，并可能经 run 结果/通知间接暴露私有 case 信息。
- 修复：`listEnabledCasesForServerRun` 增加可见性过滤，或 mcpServerId 分支也要求 server 级 edit 权限。

### F7. Web Auto 其余 RBAC 缺口（三处，需对照 Verification 逐路由对齐）
- `POST /api/web-auto-runs`（`web-auto-runs/route.ts:33`）：用 `canViewResource`（非 `canEditResource`），且不查 `suite.enabled`；对比 verification/eval 均要求 edit + enabled。
- `PATCH /api/web-auto-cases/[id]`（`web-auto-cases/[id]/route.ts:50,58-66`）：移动 `suiteId` 时未校验目标 suite 的存在性与编辑权限；对比 `verification-cases/[id]/route.ts:69-102` 正确校验目标存在 + RBAC + 跨 MCP 阻断。
- `DELETE /api/web-auto-cases/[id]`（`web-auto-cases/[id]/route.ts:94`）：只查 suite 的 `canDeleteResource`，**忽略 case 作者**；对比 verification / eval 的 DELETE 均允许 `caseRow.createdBy === user` 删除（`verification-cases/[id]/route.ts:159-161`、`eval-cases/[id]/route.ts:98-100`）。
- 结论：Web Auto 是三大子系统中 RBAC 最不完善的一个，建议以 Verification 为基准逐路由对齐。

### F8. tester 写/删工具审批缺位 + 写屏障仅靠 prompt 软约束
- 位置：`src/lib/db/schema.ts:928`（`toolApprovalMode` 默认 `"never"`）、`src/lib/agent-pipeline/risk-registry.ts:46-91`（tester 工具未注册 `BUILTIN_TOOL_RISK_MAP`）、`src/lib/runner/tool-approval.ts:71`（`never` 直接放行）。
- 事实：`update_test_case(enabled:true)`、`create_test_suite`、`delete_test_case` 等写/删工具在默认配置下无任何审批，也不受 ToolRiskRegistry 管控。「写屏障」（新建 `enabled:false`）仅靠 `DEFAULT_TESTER_SYSTEM_PROMPT` §5 的 prompt 软约束，agent 可 `create → update(enabled:true) → run` 一条链绕过。
- 结合已确认决策：你计划禁用 `delete_test_case` 工具（改 UI 人工操作），直接消解删除侧风险；建议同时把 `update_test_case` 的 `enabled:true` 路径注册进风险表或加审批，否则写屏障仍形同虚设。

---

## 3. P2 — 中等问题

### F9. 工具侧与 REST 侧的 run 权限语义漂移
- 事实：`run_test_case` / `run_test_suite`（tester 工具）只做 view 级检查（`run-test-case.ts:63-69`、`run-test-suite.ts:52-60`），而 REST 的 `POST .../runs` 要求 edit（`verification-runs/route.ts:37-49`）。同一个人「手动点 Run 不允许、让 agent 跑却行」。此外 tester 只读/执行类工具 execute 内无 `isEditor` 断言，安全完全依赖「tester agent 对非 editor 不可见」这一单层（`agent-visibility.ts:43` + dispatch 过滤）。
- 修复：工具入口统一显式断言 `ctx.isEditor || ctx.isAdmin`，并与 REST 侧同一谓词，实现 defense-in-depth。

### F10. 豁免审批的 run 工具缺配额与风险登记
- 事实：`run_test_case` / `run_test_suite` 在 `APPROVAL_EXEMPT_TOOLS`（`builtin.ts:487-516`）且不在 `BUILTIN_TOOL_RISK_MAP`，按 `headlessAllowed: true` 宽松落表。计划任务 / 无人值守场景下 tester agent 可无限触发套件运行（Playwright 会话 + LLM 调用成本），无按用户/套件的频次或费用上限。
- 结合已确认决策：你计划后续增加配额/节流，建议实现时对 `run_test_suite`/`run_test_case` 分桶计数，并对 `initiator === tester` 的派发设独立配额桶。

### F11. 统一化半途：access 层三套、case 删除规则三份不同
- 事实：断言引擎统一了，但 access 层仍是三份（`verification/access.ts`、`evaluation/access.ts`、web-auto 全部内联）；case 删除规则三份且不一致（verification/eval 是「case 作者或 suite 作者或 admin」，web-auto 只看 suite 作者、无视 case 作者）。错误信封还返回裸 `{error}` 而非 `ApiError`。F3/F4/F5/F6 全部落在缺共享 helper 的那几处——这是结构性后果，非偶然。
- 建议：把 `loadVisibleSuite` / `loadVisibleCase` + 内容/可见性 PATCH 拆分模式收敛为跨类别共享内核，统一到 `permissions.ts`。

### F12. `run_test_case` 工具 execute 内同步跑完整多轮 LLM
- 事实：`src/lib/testing/tools/run-test-case.ts:153` 调 `runEvalCase`，eval-runner 内部同步跑完整多轮对话 + judge 评分（`eval-runner.ts:362-409`），会长时间阻塞会话流。
- 建议：对 tool 触发的 evaluation 单 case 运行改为异步返回立即运行结果（或加超时上限），避免阻塞对话回流。

### F13. 委派执行造成的缓存失盲
- 事实：`useTestMutationSubscriber` 只监听当前活跃 agent 的 `TOOL_CALL_RESULT`（`useTestMutationSubscriber.ts:92-105`）。supervisor `delegate_to_agent` 让子 tester 创建/修改用例时，子 run 的事件不流向前端，左侧面板保持陈旧——这正是「场景 2 自主测试」的核心链路之一。
- 建议：为 delegation 子树的 mutation 事件扩展失效广播（复用 SSE 或事件总线回传子 run 的 mutation）。

### F14. 环境上下文「客户端自报、服务端照单全收」
- 事实：`src/lib/runner/extract-run-input.ts:127-146` 把 `body.state.context` 的 `activeUrl` / `activeView` / `activeResourceId` / `activeResourceData` 原样类型转换后注入系统提示词（`dispatch/builtin.ts:441-443`），服务端不校验 `sharedStateEnabled`、不校验资源归属。具体表现：① `sharedStateEnabled: false` 的 agent 仍会收到 `activeUrl`/`activeResourceId`（`useCopilotSharedState.ts:74,82-91` 门禁只覆盖 `activeResourceData`）；② 存量资源内容（用例输入、eval turns、他人 agent 的系统提示词）作为间接提示注入面进入 system message（`BuiltinAgentEditor.tsx:333-346`）。
- 定性：当前**无跨用户泄漏**（数据只能来自本人权限内的 API），但信任模型未闭合，需在文档明示「环境上下文可信域 = 客户端」，并加服务端校验（至少校验 `sharedStateEnabled` 时才注入 `activeResourceData`）。

### F15. 混合判决引擎 fail-fast 语义不一致
- 事实：evaluation 已 fail-fast（`eval-runner.ts:427-437`，确定性失败 → score=0、跳过 evaluator、judge 行标 skipped）；web-auto 未 fail-fast（`orchestrator.ts:176-215`，确定性失败后仍跑 LLM 评估，结果在 `280` 行被忽略）。commit `79617f9` 声称已实现但 web-auto 未落地。

### F16. 单 case 运行「零 DB 落库」与审计需求冲突
- 事实：三模块单 case 运行均不落 `entity_run` 也不落结果表（对 UI 同步调试是合理设计），但 tester agent 经 `run_test_case` 触发的同步执行（尤其 evaluation 的 LLM 调用）无任何留痕，`get_test_results` 也查不到——自主测试闭环里「跑过什么、花了多少」不可追溯。
- 建议：至少为 agent 触发的 run 留一条轻量记录（`entity_run` 或专属审计表）。

### F17. `writeErroredCaseResults` 写入已废弃 `verdict` 字段
- 位置：`src/lib/web-auto/storage.ts:377-402`。
- 事实：`WebAutoCaseResultTable` 已无 `verdict` 列（`schema.ts:2362-2369` 现为 `assertionResults`/`score`/`feedback`）。`writeErroredCaseResults` 传 `verdict` 且**未传 `assertionResults`**，导致崩溃恢复的 errored 行断言结果落为默认空 `[]`，丢失诊断上下文（且可能是类型/运行隐患）。
- 注：`orchestrator.ts:616 persistAndPublishError` 虽也传 `verdict`，但经 `writeWebAutoCaseResult` 的 fallback（`storage.ts:299-304`）被正确消化，无实际数据丢失，仅代码陈旧。

---

## 4. P3 — 低优先级

- **F18 文档漂移**（三处）：`docs/web-auto.md:62` 声称 `web_auto_case` 有 `script_content` 列（实际已并入 `input` jsonb，`schema.ts:2313-2332`）；`docs/web-auto.md:96` 列有 `assertions.ts` 文件（已并入 `src/lib/assertions`）；同处声称 `isolated-vm` 沙箱（实际 `node:vm`，见 F1）。
- **F19 `{{$int(min,max)}}` 无参数防御**：`variable-resolver.ts:16-24` 当 `min > max` 时 `crypto.randomInt` 抛错，且发生在 `runMcpCase` 的 `resolveInput`（`runner-mcp.ts:62`，try 之外），会直接向上抛异常，违背 `runMcpCase`「NEVER throws」契约。
- **F20 Token 估算中文失真**：`eval-runner.ts:107-112` 用 `split(/\s+/)`，中文无空格 → 词数恒 1，`metric: output_tokens` 断言对中文目标严重失真。建议字符数/4 或 tiktoken 近似。
- **F21 MCP 调用无 AbortController**：超时用 `Promise.race` 未真正取消底层请求，MCP 连接池在高并发/不稳定场景有耗尽风险。
- **F22 New Chat 清空环境上下文且不恢复**：`RightPanel.tsx:443-451` 重置时 `agent.setState({})`，而同步 effect 依赖的 `activeResourceData` 未变化不会重推——用户点「新对话」后该页面 agent 从此收不到页面上下文，直到数据再变。对「人机协作调试」是实际体验 bug。
- **F23 `get_test_results` 趋势指标缺失**：`docs/test-automation-copilot.md §4.4` 称 `last>1` 返回 pass rate/scores/duration，但 `get-test-results.ts` 中 verification/web-auto summary 不填 `durationMs`/`averageScore`。

---

## 5. 已确认的设计决策（记录，无需改动）

1. **public 资源 = 共享资源**：public 的 agent prompt 可被所有 editor 读取；public 的 agent / database / ssh / skills / mcp 统一视为共享资源，不受归属限制。
2. **`get_agent_spec` 暴露 public agent 完整系统提示词**是刻意取舍。建议：在 UI 对 agent 作者提示「prompt 将对同租户 editor 可见」，并把「prompt 不存 secret」从注释约束升级为写入校验。
3. **`delete_test_case` 工具计划禁用**，改为 UI 人工操作删除；同时应从 `DEFAULT_TESTER_SYSTEM_PROMPT` 移除「Housekeeping: delete_test_case」指引。
4. **自主 run 目前无配额/节流**，后续增加限制（见 F10 实现建议）。

---

## 6. 优先级行动清单

| 步骤 | 事项 | 来源 |
|---|---|---|
| 1 | 修正沙箱文档/注释措辞 + 评估 `isolated-vm`/子进程真隔离 | F1 |
| 2 | `verification-servers/[id]` DELETE 加归属检查（或 `withAdmin`） | F2 |
| 3 | `verification-cases` POST `suiteId` 分支加 `canEditResource` | F3 |
| 4 | `eval-cases/[id]/latest-result` 加 suite 可见性校验 | F4 |
| 5 | `web-auto-suites PATCH` 拆分 content/visibility 门禁 | F5 |
| 6 | `verification-runs` mcpServerId 分支加可见性过滤 | F6 |
| 7 | Web Auto 三路由（runs/cases PATCH/cases DELETE）对齐 Verification | F7 |
| 8 | `update_test_case(enabled:true)` + delete 纳入风险注册/审批 | F8 |
| 9 | tester 工具入口加 `isEditor` 断言 + 统一工具/REST 谓词 | F9/F11 |
| 10 | 修复 `writeErroredCaseResults` verdict 残留 | F17 |
| 11 | web-auto fail-fast、F12/F13/F14 信任边界、F16 审计 | F10-F16 |
| 12 | F18-F23 文档与低优先级小修 | F18-F23 |

---

## 附录：三方意见对照（去重后）

| 最终编号 | 主题 | 主评审 | CO | GLM |
|---|---|---|---|---|
| F1 | js_expression VM 逃逸 | S1 (P0) | M-5 (P2，定性偏乐观) | P0-1 (P0) |
| F2 | verification-servers DELETE 无 RBAC | — | C-1 (P0) | — |
| F3 | verification-cases POST 越权写 | — | M-1 | P0-2 |
| F4 | latest-result 越权读 | — | M-3 | P0-3 |
| F5 | web-auto PATCH 缺 canChangeVisibility | — | M-2a | P0-4 |
| F6 | verification-runs 越视执行 | — | — | P1-5 |
| F7 | web-auto 其余 RBAC（runs/cases） | — | M-2b/c/d | 架构判断 |
| F8 | 写屏障/审批缺位 | S2/S3 | — | 豁免审批缺配额 |
| F9 | 工具/REST run 语义漂移 | S4 | — | 中等问题 |
| F10 | run 工具缺配额风险登记 | S3 | — | 中等问题 |
| F11 | access 层三套 + 删除规则三份 | A1 | — | 架构判断 |
| F12 | run_test_case 同步阻塞 | — | — | 中等问题 |
| F13 | 委派执行缓存失盲 | — | — | 中等问题 |
| F14 | 环境上下文客户端自报无校验 | — | — | 中等问题 |
| F15 | 混合判决 fail-fast 不一致 | A2 | — | — |
| F16 | 单 case 零落库审计缺口 | — | — | 架构判断 |
| F17 | verdict 残留 writeErroredCaseResults | — | M-4 | — |
| F18 | 文档漂移 | A3 | — | — |
| F19 | $int 参数无防御 | — | L-1 | — |
| F20 | token 估算中文失真 | — | L-2 | — |
| F21 | MCP 无 AbortController | — | L-3 | — |
| F22 | New Chat 上下文不恢复 | — | — | 中等问题 |
| F23 | get_test_results 趋势指标缺失 | A5 | — | — |
| F24 | 文档 §7 pending 未实现（报告仅文字） | — | — | 架构判断 |

> 三者结论高度收敛：CO 与 GLM 各自独立发现了主评审第一轮未覆盖的 HTTP 路由层漏洞（F2/F3/F4/F5/F6/F7），GLM 额外补充了缓存失盲、信任边界、审计缺口等架构纵深问题。唯一实质分歧在 F1 的严重度定性——本报告采纳「P0，至少先修正文档并评估真隔离」的审慎结论。