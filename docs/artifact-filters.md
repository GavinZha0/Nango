# Artifact Interactive Filters & Workflow Parameterization Architecture

> **Status**: Design Reference & Architectural Blueprint for Artifact Interactive Filters in Nango.

---

## 0. Overview (概述)

本文档定义了 Nango 中 **Artifact 交互式 Filter（过滤器）与 Workflow 参数化演进架构**。

在数据分析与图表生成场景中，用户需要在 Artifact 详情页中针对图表进行动态筛选（如自定义时间段、选择特定的触发源/发起人等）。本架构通过**两步解耦机制**、**右侧 20% Resizable Filter 面板**与 **RJSF (`@rjsf/shadcn`) 动态表单生成**，实现用户在 UI 上操作 Filter 控件时，将参数精准下推至 Workflow 的 SQL/代码节点中进行确定性重新计算并渲染图表。

---

## 0.1 实施状态与路线图 Checklist (Implementation Status & Roadmap)

> **当前总体实施完成度**: **~90%** (核心链路、表单渲染、沙箱传参、会话保持、快照回写、图表自适应、Header 工具栏平铺与像素级对齐已 100% 验证通过)

### ✅ 已完成并验证项 (Completed & Verified)

- [x] **数据模型与 Spec 契合**: `CanonicalWorkflowSpec.input_schema` (JSON Schema) 定义 Filter 参数类型与默认值。
- [x] **沙箱参数注入与 Python 节点执行**:
  - 沙箱节点通过 `os.environ["__PARAMS__"]` 接收 `inputValues`；
  - 清理 Python 节点中导致 `dify-sandbox` 误判 exitCode 1 的 stderr 输出；
  - `code-output.ts` 实现确定性倒序括号匹配解析，准确提取 Python 输出的 `rows` JSON。
- [x] **图表 X 轴时间自适应缩放**: ECharts 视图根据 `start_date` / `end_date` 参数自动动态裁剪与重绘时间范围。
- [x] **RJSF 动态表单渲染 (`ArtifactFilterPanel.tsx`)**:
  - 基于 `@rjsf/shadcn` + `@rjsf/validator-ajv8` 原生渲染 JSON Schema 表单；
  - 自定义 `FilterDateWidget` 原生日期选择器组件；
  - 右侧 Resizable Panel 支持自由折叠与展开；
  - 底部控制面板提供干净标准的 `[ Apply ]` 提交按钮与 Loading 加载态。
- [x] **会话级参数记忆与切页保持 (Option C & Session SWR Preservation)**:
  - 实现 `sessionAppliedInputsMap` 内存映射，用户点击 `[ Apply ]` 后在当前 Session 中保持 Filter 选中值；
  - 切换其他 App 页面（如 `/agent`）再返回该 Artifact 时，视图与 Filter 100% 保持用户选中的参数与实时图表，且**不强制写入数据库**。
- [x] **快照保存与持久化继承 (Snapshot Saving & Spec Invalidation)**:
  - 点击 Header 的 `Save` (保存快照) 图标或 Filter 面板保存时，系统自动继承当前活跃的应用参数；
  - `saveSnapshot` 在 PostgreSQL 数据库中将更新后的图表固化到 `ArtifactTable.snapshot`，并同步持久化回写 `WorkflowTable.spec.input_schema.properties[key].value`；
  - 点击 `Snapshot` (相机) 图标进入快照模式时，精确呈现固化的快照数据与保存时的 Filter 参数。
- [x] **Header 工具栏与主界面极简优化**:
  - **按钮去重**：当 Artifact 拥有 Filter 面板时，Header 顶部自动隐藏重复的 `Refresh` 按钮，统一由 Filter 面板底部的 `[ Apply ]` 触发刷新；
  - **平铺图标与 Tooltip 提示**：Header 工具栏一字排开呈现 `Refresh` (无 Filter 时) | `Save` | `Snapshot` | `Compare` | `Rename` | `Move` | `Delete` 图标，配合 Tooltip 提示，极致节省横向空间；
  - **快照状态提示**：快照模式下呈现醒目的黄色 `Camera` Badge 提醒保存时间，不再作为双向切换按钮；
  - **Header 高度全局像素对齐**：左侧面板 Header、主视图 DetailHeader、Filter 面板 Header 均统一设置为 `h-12` (48px)，横向无缝平齐；
  - **垂直把手全屏拖拽解封**：取消顶部面板 `minSize="20%"` 硬编码限制（改为 `minSize={0}`），用户可无阻碍将 Workflow 节点图向上拖动至 Header 下方 100% 占满空间。

---

### ⏳ 待实现 / 后续扩展项 (Pending / Roadmap Items)

- [ ] **`Compare` (快照 vs 实时数据双栏/叠加比对)**:
  - Header 工具栏中的 `Compare` (比对) 图标按钮目前已暴露 UI 并解除禁用，后续计划实现 Compare Modal 视图，支持对比查看“固化快照图表”与“当前 Live 实时图表”的数据差异。
- [ ] **动态选项源接口支持 (`options_source` & `GET /api/artifacts/[id]/filters`)**:
  - `options_source` 的类型为 `sql` 时，通过后端接口执行 SELECT DISTINCT 动态查询并装填下拉框选项。
- [ ] **更多高级控件扩展 (Advanced Widgets)**:
  - 扩展双日期范围选择器（DateRangePicker）、多选标签组件（MultiSelect / TagSelect）。
- [ ] **防抖自动提交模式 (Debounced Auto-Apply)**:
  - 可选提供无按钮自动提交模式（用户修改 Filter 控件后防抖 500ms 自动触发刷新）。

---

## 1. 核心原则与“两步解耦”机制 (Two-Step Decoupling)

为了同时兼顾保存时的**高吞吐与确定性**以及后续演进时的**灵活性与代码健壮性**，架构将 Artifact 的声明周期严格划分为两步：

```
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段一：保存快照 (Save Phase — 零 Agent 参与，机械提取)                │
│                                                                        │
│ 1. 用户在 Chat 对话中点击“Save/保存”图表                               │
│ 2. 后端 save-artifact.ts 自动提取该图表的 SQL/Python/Chart 工具链       │
│ 3. 忠实记录原始 Python 代码，写入 Workflow Spec 并生成初始静态快照     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 产生初始 Artifact & Workflow
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段二：Artifact 页面增量演进 (Modify Phase — Agent 调用 modify_workflow) │
│                                                                        │
│ 1. 用户在 Artifact 页面中通过 Chatbot 提出需求：“增加时间与 Initiator 筛选”│
│ 2. Agent 响应并调用 modify_workflow 工具进行重构：                     │
│    - input_schema：声明 Filter 控件类型及动态 options_source           │
│    - SQL 节点：在 WHERE 子句中追加 @inputs.<key> 变量下推               │
│    - Code 节点：重构 Python 代码，补齐 if/else 防御分支与多选兼容逻辑  │
│ 3. 后端校验并覆盖更新 Workflow Spec                                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 产生带 Filter 与全分支代码的 Workflow Spec
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段三：确定性刷新 (Refresh Phase — 前端 Filter 面板与 Workflow 引擎)  │
│                                                                        │
│ 1. 前端根据 input_schema 动态拉取选单并渲染右侧 20% Filter 面板         │
│ 2. 用户修改 Filter 参数（如选定 Initiator），点击“刷新”                 │
│ 3. POST /api/artifacts/[id]/refresh 带着 inputs 参数运行 Workflow：    │
│    - SQL 节点做数据库高效切片                                           │
│    - Python 节点运行 Agent 重构好的分支代码                            │
│    - 图表实时无缝重绘                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 界面布局架构 (UI Layout Architecture)

在 `ArtifactDetail.tsx` 的主区域（Upper Panel）中，采用 `react-resizable-panels` 嵌套实现**左右分栏**：

- **左侧（图表/生成物主视图）**：占 80% 宽度（范围 [75%, 85%]）。
- **右侧（Filter 面板）**：与图表**等高**，分享宽度。
  - **默认宽度**：`20%` (`defaultSize={20}`)
  - **拖拽调整范围**：`[15%, 25%]` (`minSize={15}`, `maxSize={25}`)
- **自动开闭（Auto-Collapse）**：
  - 当 `workflow.spec.input_schema` 中无 Filter 属性时：Filter 面板及手柄自动完全隐藏（宽度 0），图表全屏独占 100%。
  - 当 `workflow.spec.input_schema` 声明了 Filter 属性时：自动展示右侧 20% Filter 面板，提示用户支持交互筛选。

```
┌────────────────────────────────────────────────────────────────────────────┐
│ DetailHeader (标题 / 状态 / 操作栏: 重命名、移动、删除、刷新等)            │
├────────────────────────────────────────────────────────────────────────────┤
│ ResizablePanelGroup (orientation="vertical")                               │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 上层 Upper Panel (orientation="horizontal")                         │  │
│  │  ┌─────────────────────────────┬─┬────────────────────────────────┐  │  │
│  │  │                             │ │ Filter 面板 (与图表同高)       │  │  │
│  │  │                             │ │ 默认占比 20%, 范围 [15%, 25%]  │  │  │
│  │  │                             │ │ ┌────────────────────────────┐ │  │  │
│  │  │                             │ │ │ 🎛️ 筛选参数         [重置] │ │  │  │
│  │  │   图表 / 生成物主视图       │拖│ │ ──────────────────────────── │ │  │  │
│  │  │   (<EChartsRenderer />)    │拽│ │ RJSF 动态表单组件            │ │  │  │
│  │  │   占比 80% [75%, 85%]       │手│ │ - 起止时间 (DateRange)       │ │  │  │
│  │  │                             │柄│ │ - 发起人 Initiator           │ │  │  │
│  │  │                             │ │ │   (MultiSelect/Select)       │ │  │  │
│  │  │                             │ │ ├────────────────────────────┤ │  │  │
│  │  │                             │ │ │ [ 🔄 应用并刷新 ]           │ │  │  │
│  │  │                             │ │ └────────────────────────────┘ │  │  │
│  │  └─────────────────────────────┴─┴────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ═════════════════════════ 垂直拖拽手柄 ═══════════════════════════════════  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 下层 Lower Panel (Workflow Graph 拓扑节点图)                         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 开发测试参照范例：实体执行记录每日趋势

### 3.1 范例背景
以 Workflow **“实体执行记录每日趋势111”** 为前期开发与联调验证的基准范例。包含两组核心 Filter 参数：
1. **时间范围 Filter**：`start_date` 与 `end_date`（起止时间）。
2. **发起人 Filter (`initiator`)**：来自 `entity_run` 表的 `initiator` 字段，支持两种获取方式：
   - 方式 A：固定值枚举（如 `["user", "evaluator", "schedule"]`）。
   - 方式 B：从数据库动态查询唯一值 (`SELECT DISTINCT initiator FROM entity_run`)。

### 3.2 范例 Workflow Spec 规范声明 (`input_schema`)

```json
{
  "name": "实体执行记录每日趋势（最近30天）",
  "input_schema": {
    "type": "object",
    "properties": {
      "start_date": {
        "type": "string",
        "format": "date",
        "title": "开始日期",
        "description": "筛选起始日期 (YYYY-MM-DD)",
        "default": "2026-07-17"
      },
      "end_date": {
        "type": "string",
        "format": "date",
        "title": "结束日期",
        "description": "筛选结束日期 (YYYY-MM-DD)",
        "default": "2026-08-16"
      },
      "initiators": {
        "type": "array",
        "widget": "multi-select",
        "title": "发起人 (Initiator)",
        "description": "按运行触发源进行筛选",
        "default": [],
        
        // 动态选项源定义 (方式 B：从 DB 查唯一值)
        "options_source": {
          "type": "sql",
          "data_source_id": "52cdae3b-338c-41b1-a7d4-f40d73e6d806",
          "sql_text": "SELECT DISTINCT initiator AS label, initiator AS value FROM entity_run WHERE initiator IS NOT NULL ORDER BY label"
        }
      }
    }
  },
  "nodes": [
    {
      "id": 0,
      "type": "sql",
      "inputs": {
        "data_source_name": "nango-db",
        "dataset_name": "entity_run_daily_counts",
        "sql_text": "SELECT DATE(created_at) as date, COUNT(*) as count FROM entity_run WHERE created_at >= '@inputs.start_date' AND created_at <= '@inputs.end_date' AND (@inputs.initiators_is_empty = TRUE OR initiator IN (@inputs.initiators)) GROUP BY DATE(created_at) ORDER BY date DESC"
      },
      "depends_on": []
    },
    {
      "id": 1,
      "type": "code",
      "inputs": {
        "language": "python",
        "params": {
          "start_date": "@inputs.start_date",
          "end_date": "@inputs.end_date"
        },
        "datasets": ["@nodes.0.dataset_name"],
        "code_text": "import json\nimport pandas as pd\nimport duckdb\n\ndf = duckdb.read_parquet('./tmp/data/entity_run_daily_counts/**/*.parquet').df()\ndf['date'] = pd.to_datetime(df['date'])\ndf['count'] = df['count'].astype(int)\n\nstart_date = pd.to_datetime(params.get('start_date'))\nend_date = pd.to_datetime(params.get('end_date'))\n\ndate_range = pd.date_range(start=start_date, end=end_date, freq='D')\nfull_df = pd.DataFrame({'date': date_range})\nfull_df = full_df.merge(df, on='date', how='left').fillna({'count': 0})\nfull_df['count'] = full_df['count'].astype(int)\nfull_df['date_str'] = full_df['date'].dt.strftime('%Y-%m-%d')\n\nresult_rows = full_df[['date_str', 'count']].rename(columns={'date_str': 'date'}).to_dict('records')\nprint(json.dumps({'rows': result_rows, 'message': '成功'}))"
      },
      "depends_on": [0]
    },
    {
      "id": 2,
      "type": "chart",
      "inputs": {
        "renderer": "echarts",
        "dataset": "@nodes.1.rows",
        "config": { ... }
      },
      "depends_on": [1]
    }
  ]
}
```

---

## 4. 表单生成选型：RJSF (`@rjsf/shadcn`)

Filter 面板内的表单完全采用项目中已有的 **RJSF (`@rjsf/shadcn`)** 配合 `@rjsf/validator-ajv8` 生成：

1. **RJSF 优点**：原生基于 JSON Schema 生成表单，与 `spec.input_schema` 无缝契合，自动校验，且 UI 样式与 Nango 主题（Shadcn/ui）完全统一。
2. **UI 自定义扩展 (`uiSchema`)**：
   - 映射 `start_date` / `end_date` 到 Shadcn 日期选择器。
   - 映射 `initiators` 到 Shadcn 多选框 / 下拉选框。
3. **过滤重置与刷新**：
   - 面板底部固定 Action Bar：“**应用并刷新**” (触发 `POST /refresh`) 和 “**重置**” (还原默认值)。

---

## 5. 交互与接口流

1. **选项拉取 (`GET /api/artifacts/[id]/filters`)**：
   前端根据 `input_schema` 中 `initiators.options_source` 的定义，先调用该接口执行 SQL，返回可选项：`[{label: "user", value: "user"}, {label: "evaluator", value: "evaluator"}, {label: "schedule", value: "schedule"}]`。
2. **表单渲染**：RJSF 将选单灌入表单展示。
3. **提交重播 (`POST /api/artifacts/[id]/refresh`)**：
   用户选择时间与 `initiator` 点击应用，前端将 `{ start_date, end_date, initiators }` 发送给后端重播 Workflow，折线图实时无缝更新！
