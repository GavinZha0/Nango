# Nango Shared State (Copilot 交互模式) 架构设计与实施计划

## 1. 概述 (Overview)
为了在 Nango 中同时支持“后台自主执行 (Autonomous)”与“前端交互协同 (Copilot)”两种模式，系统引入 CopilotKit 的 Shared State 机制。
此架构旨在构建一个**上下文感知、状态双向绑定、所见即所得**的体验，满足 Agent、MCP、Skill、Workflow、Schedule 等资源的交互式编辑，特别是复杂节点图（如 Workflow Artifact）的动态预览与测试需求。

## 2. 核心架构思想：状态分层与模式路由
Nango 的前端架构在现有的数据库事实驱动之上，增加一层**草稿层 (Draft Layer)**。

*   **数据库层 (Truth)**：通过现有的 Backend Tools (如 `update_schedule`, `update_workflow`) 直接修改，适用于后台静默运行的 Agent 任务。
*   **草稿层 (Shared State)**：驻留在前端内存中。在 Copilot 交互模式下，Agent 的修改指令将优先生成草稿。前端 UI 优先读取并渲染草稿层的数据供用户预览。只有当用户手动点击“验证通过并保存”时，前端才将草稿层的数据作为真实载荷提交到数据库。

## 3. 数据结构设计 (Shared State Schema)
前端定义一个严格类型的共享状态结构，桥接前端与 Agent。

```typescript
export interface NangoSharedState {
  // 1. 上下文注入 (Frontend -> Agent)
  // 前端随页面切换实时注入，告知 Agent 用户当前的视觉焦点
  context: {
    activePanel: "chat" | "skill_editor" | "workflow_editor" | "artifact_viewer" | "schedule_editor";
    activeResourceId: string | null; 
    activeResourceData: any | null;  
  };

  // 2. 草稿数据 (Agent -> Frontend)
  // Agent 根据对话生成的修改草稿，前端据此渲染高亮或预览差异
  drafts: {
    schedule?: Partial<any>;
    skill?: Partial<any>;
    workflow?: {
      nodes: any[];
      edges: any[];
    };
  };

  // 3. UI 交互指令 (Agent -> Frontend)
  // 用于触发前端的临时视觉效果或弹出面板
  uiAction?: {
    type: "HIGHLIGHT_NODE" | "OPEN_PREVIEW_MODAL" | "SHOW_DIFF";
    targetId?: string;
  };
}
```

## 4. 文件组织与模块定位
此功能定位于架构中的**“集成胶水层 (Integration Layer)”**，不建立完全独立的垂直模块，而是通过 Hook 横向切入现有的状态和组件中。

核心新增文件（2个）：
1. **`src/lib/copilot/shared-state-schema.ts`**
   * **职责**：统一定义 `NangoSharedState` 类型接口，供前后端工具链共享，确保状态同步时的类型安全。
2. **`src/hooks/useCopilotSharedState.ts`**
   * **职责**：核心网关 Hook。监听 Zustand store（如 Workspace/Sidebar），并在面板切换时调用 `agent.setState()` 注入上下文。同时解析并暴露 `agent.state.drafts` 给下游 UI 组件使用。

现有代码适配修改：
1. **Agent Prompt/Routing (`src/lib/orchestration/modes.ts` 或对应配置)**：注入路由策略（“如果 `context.activePanel` 为当前修改资源，必须生成草稿，禁用直接 DB 修改”）。
2. **UI 业务组件 (如 `WorkflowEditor.tsx`、`ScheduleEditor.tsx`)**：引入核心 Hook，读取 Draft，实现草稿覆盖原数据的预览效果，并提供“运行验证”和“保存修改”按钮。

## 5. 交互场景深度还原：Workflow Artifact
1. **场景初始化**：用户打开数据分析 Artifact (背后对应一个 Workflow)。前端触发 `useCopilotSharedState`，将 `activePanel: 'artifact'` 和当前图结构注入 Agent 状态。
2. **用户指令**：“加一个数据清洗节点去掉空值”。
3. **Agent 响应**：发现匹配上下文，走 Copilot 模式。不调 DB 工具，而是生成包含新节点的 JSON，调用状态工具更新 `drafts.workflow`。
4. **前端预览**：UI 组件检测到 Draft 存在，立刻在图上渲染出新节点（可带高亮特效）。
5. **Dry-run 验证与保存**：用户点击界面上的“运行验证”，前端带着 Draft 数据向后端发试运行请求。结果正确后，用户点击“保存”，前端发起真实 PATCH 请求落库，并清空当前 Draft。

---

## 6. 实施计划 (Implementation Plan)

本项目建议采用“三步走”渐进式接入策略：

### 阶段一：打通双向状态管道 (基础设施建设)
* **目标**：完成 Shared State 核心机制搭建，实现前端感知与上下文注入，Agent 能根据规则响应。
* **任务清单**：
  * [ ] 编写 `shared-state-schema.ts` 定义接口。
  * [ ] 编写 `useCopilotSharedState.ts` 核心 Hook，实现 Zustand 状态向 Agent 的自动同步。
  * [ ] 修改全局 Layout，挂载该 Hook，验证 Nango 能够准确识别用户当前所在的 Panel 和查看的资源 ID。
  * [ ] 修改 Supervisor Prompt，增加“资源修改策略 (Resource Modification Policy)”引导，要求 Agent 理解 `drafts` 机制。

### 阶段二：单一简单资源试点 (以 Schedule 为例)
* **目标**：跑通第一个完整的 Copilot 交互闭环。
* **任务清单**：
  * [ ] 修改 Schedule Editor 界面，引入 `useCopilotSharedState` 读取 `drafts.schedule`。
  * [ ] 支持将草稿数据预填入表单输入框。
  * [ ] 提供明确的“保存 Agent 修改”和“丢弃草稿”操作按钮。
  * [ ] 验证用户指令能否自动拉起编辑器并预填内容，最后由用户点按保存落库。

### 阶段三：复杂资源的深度支持 (Workflow / Artifact)
* **目标**：支持图形化资源的所见即所得修改与动态验证。
* **任务清单**：
  * [ ] 扩展 Workflow 编辑器/渲染器，支持 Draft 节点的可视化比对（Diff 展示）。
  * [ ] 实现前置验证 (Dry-run) 逻辑，允许在不污染数据库的情况下，向后端请求并在图表 Artifact 上显示结果。
  * [ ] 完善交互，在验证成功后，支持一键将 Draft 覆盖写入数据库。
