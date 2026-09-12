# 测试套件变量与凭据系统 (Suite Variables & Credentials System)

本文档是 Nango 测试子系统（Web-Auto、Verification、Evaluation）变量与集成凭据绑定系统的正式技术架构与使用规范指南。

---

## 1. 系统概述与核心原则

### 1.1 系统定位

在自动化测试、契约验证和大模型评测场景中，测试用例往往需要引用一组跨用例共享的基础配置（例如目标地址、端口、超时时间、项目标识）或测试专用身份凭证（例如被测系统的测试账号、API 密钥）。

测试套件变量系统（Suite Variables System）为三大子系统提供了统一定义、安全存储、跨用例复用以及细粒度安全隔离的能力。

### 1.2 核心设计原则

1. **统一的套件级参数管理**：三大测试套件（Web-Auto、Verification、Evaluation）在 Suite 级别统一定义变量字典，供套件下所有用例统一继承。
2. **按场景最小权限原则（Least Privilege）**：
   - 网页自动化测试（Web-Auto）由于需要模拟用户登录与表单交互，开放凭据变量（Credential Variable）。
   - 工具契约验证（Verification）与评测（Evaluation）仅开放普通字面量变量（Literal Variable），物理阻断敏感凭据。
3. **生产秘钥物理隔离（Hard Isolation）**：
   - 变量系统严格限制仅允许引用 `serviceType: "integration"` 且 `provider: "testing"` 的专用测试凭据。
   - 生产环境大模型 API Key（`llm`）、Agent 平台凭据（`agent`）以及 SSH/MCP 基础设施凭据在测试变量层完全不可见、不可选、不可解析。
4. **即时脱敏 (Earliest Sanitization)**：
   - 自动化脚本执行产出返回后，系统第一时间在最靠近数据源头处执行降序敏感词替换。
   - 确保后续断言判决、大模型智能评测（LLM Evaluator Prompt）、历史归档持久化以及 SSE 前端实时推送中绝对不残留明文凭据。
5. **断言层天然绝缘**：
   - 断言引擎从根本上不接收凭据变量，仅传入纯字面量变量（`literalVariables`），阻断断言比对明细或差异报错中泄露密码的路径。
6. **无抛错契约 (Never-Throws & Fail-Closed)**：
   - 凭据禁用、未找到或非合规引用时，执行层严格返回结构化 `{ source: "config", message: "..." }` 错误并阻断后续执行，严禁抛出未捕获异常。

---

## 2. 作用范围与能力矩阵

| 子系统 | 变量管理界面 (UI) | 普通字面量 (Literal)<br>`BASE_URL` 等 | 敏感凭据 (Credential)<br>`ADMIN_PASS` 等 | 注入与使用方式 | 安全与隔离策略 |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **Web-Auto** | 双 Tab<br>`allowCredentials: true` | ✅ 支持 | ✅ 支持<br>(仅限 `integration` + `testing`) | 1. 脚本中：`variables.KEY`<br>2. 断言中：`{{variables.KEY}}` | • IIFE 闭包冻结注入沙箱<br>• 执行产出即时 Earliest 脱敏<br>• 断言仅吃 `literalVariables` |
| **Verification** | 双 Tab<br>`allowCredentials: false` | ✅ 支持 | ❌ 严格禁用<br>(UI 不可选，后端报 config 错) | 用例输入中：`{{variables.KEY}}` | • 跨用例单次启动解析<br>• 阻断任何凭据配置 |
| **Evaluation** | 双 Tab<br>`allowCredentials: false` | ✅ 支持 | ❌ 严格禁用<br>(UI 不可选，后端报 config 错) | 规则与断言中：`{{variables.KEY}}` | • 启动时解析并平铺注入<br>• 阻断任何凭据配置 |

---

## 3. 数据模型与管理方式

### 3.1 变量数据模型

**定义文件**: `src/lib/testing/types.ts`

```typescript
export type SuiteVariableType = "literal" | "credential";

export type SuiteVariableDefinition =
  | {
      type: "literal";
      value: string | number | boolean;
      description?: string;
    }
  | {
      type: "credential";
      credentialId: string; // 关联的凭据 UUID
      field: string;        // 引用的凭据具体字段名 (如 password, token)
      description?: string;
    };

/**
 * Suite 变量存储字典
 * key: 变量名，必须满足正则 /^[a-zA-Z_][a-zA-Z0-9_]*$/
 */
export type SuiteVariablesMap = Record<
  string,
  SuiteVariableDefinition | Record<string, unknown> | string | number | boolean | null
>;
```

### 3.2 凭据选择器接口规范

为避免在配置变量时向前台泄露凭据明文，系统提供了只读字段名摘要的轻量接口：

- **路由**: `GET /api/credentials?purpose=suite-variable`
- **权限**: `withEditor`（仅 editor / admin 可访问）
- **查询范围**: `serviceType = "integration"` 且 `provider = "testing"` 且 `enabled = true`
- **返回结构**:
  ```typescript
  export interface CredentialSelectorItem {
    id: string;      // 凭据 ID
    name: string;    // 凭据显示名称
    provider: string;// 固定为 "testing"
    type: string;    // 凭据类型 (basic_auth, api_key 等)
    fields: string[];// 仅解密出可用字段名数组 (例如 ["username", "password"])，绝不返回真实明文值
  }
  ```

### 3.3 UI 交互规范 (`SuiteVariablesEditor.tsx`)

1. **统一尺寸与头部整合**：
   - 三大 Suite 对话框（`WebAutoSuiteDialog`, `VerificationSuiteDialog`, `EvalSuiteDialog`）统一采用固定 600px 视口高度。
   - Tab 切换器与新建变量 `+` 按钮集中置于 `DialogHeader` 右侧，最大化利用垂直编辑空间。
2. **草稿态保护与删除确认**：
   - 编辑器内部维持稳定 ID 的行模型（`VariableRowModel`）。
   - 用户可自由退格清空变量名重新输入，中间清空过程绝不误删该项。
   - 只有显式点击右侧“垃圾桶”按钮才会移除该项。
   - 当变量名为空或格式不合法时，输入框仅高亮红框，不占用额外行高，避免界面抖动。
3. **保存容错 (Fail-Safe)**：
   - 保存时，系统自动过滤掉未命名或变量名为空的无效行，仅将合法变量持久化入库。
4. **智能复制机制**：
   - **Web-Auto 模块**：行右侧复制按钮默认复制为 **`variables.KEY`**，贴合脚本直接使用。
   - **Verification / Evaluation 模块**：行右侧复制按钮默认复制为 **`{{variables.KEY}}`**，贴合模板替换。

---

## 4. 执行流程与接线架构

### 4.1 运行时安全解析器 (`src/lib/testing/variable-resolver.server.ts`)

在任何用例或套件执行前，统一通过服务端解析器完成变量解密与安全过滤：

```typescript
export interface ResolveSuiteVariablesOptions {
  allowCredentials?: boolean; // 仅 Web-Auto 传入 true
}

export interface ResolvedSuiteVariablesResult {
  resolved: Record<string, unknown>;        // 完整变量 (含解密凭据，仅供 Web-Auto 闭包沙箱使用)
  literalVariables: Record<string, unknown>;// 纯字面量变量 (专供断言引擎使用)
  sensitiveValues: Set<string>;             // 敏感值明文集合 (用于后续全局脱敏掩码)
  error: { source: "config"; message: string } | null;
}
```

**核心校验逻辑**：
1. 若 `allowCredentials !== true` 且遇到 `credential` 变量，立即中断并返回 `config` 错误。
2. 校验引用的凭据是否存在、启用状态以及服务边界：
   ```typescript
   if (!cred || cred.serviceType !== "integration" || cred.provider !== "testing") {
     return {
       ...
       error: {
         source: "config",
         message: `Credential '${def.credentialId}' not found or not registered under 'integration' service with 'testing' provider.`,
       },
     };
   }
   ```
3. 校验指定 `field` 是否在凭据有效字段中，提取对应值。
4. 所有 `credential` 类型的值若为有效长文本（长度 >= 4），自动收录进 `sensitiveValues` 脱敏集合。

---

### 4.2 Web-Auto 执行链路 (`src/lib/web-auto/orchestrator.ts`)

Web-Auto 是唯一打通凭证变量的执行引擎，其执行管线遵循严格的安全环扣：

```
[Suite Variables]
       │
       ▼ (1) resolveSuiteVariables({ allowCredentials: true })
   ┌───┴────────────────────────────────────────┐
   │                                            │
   ▼                                            ▼
[literalVariables]                      [resolvedVariables] ─── (包含账号密码明文)
   │                                            │
   │                                            ▼ (2) IIFE 闭包包裹注入沙箱
   │                                     [Playwright MCP Script]
   │                                            │ 执行浏览器操作
   │                                            ▼
   │                                    [Raw Execution Output] ── (可能打印或回显了密码)
   │                                            │
   │                                            ▼ (3) ★ Earliest Sanitization ★
   │                                    [Sanitized Output] ── (所有机密彻底替换为 ******)
   │                                            │
   ├────────────────────────────────────────────┼───────────────────────────────┐
   │                                            │                               │
   ▼ (4)                                        ▼ (5)                           ▼ (6)
[Universal Assertions]                  [LLM Evaluator]                 [Case Result DB]
• 传入 literalVariables                 • 传入 Sanitized Output          • executionOutput (已脱敏)
• 绝不感知凭证变量                      • 反馈内容补跑二次脱敏          • assertionResults (已脱敏)
• 杜绝断言差异报错泄密                  • 杜绝外部大模型泄密            • feedback & error (已脱敏)
```

1. **IIFE 闭包注入**：
   Playwright 脚本由 IIFE 包裹并挂载只读变量对象：
   ```javascript
   (() => {
     const variables = Object.freeze({"baseUrl":"https://example.com","password":"..."});
     return (/* 用户的 Playwright 脚本内容 */);
   })()
   ```
2. **即时全局脱敏 (Earliest Sanitization)**：
   MCP 执行完成后立即对 `executionOutput` 与 `error` 执行脱敏：
   ```typescript
   const sanitizedOutput = redactSensitiveData(mcpResult.executionOutput, sensitiveValues);
   const sanitizedMcpError = redactErrorEnvelope(mcpResult.error, sensitiveValues);
   ```
3. **长串优先降序脱敏 (`src/lib/testing/redact.ts`)**：
   脱敏算法将 `sensitiveValues` 严格按照字符串长度**从长到短**排序后逐一替换为 `******`，杜绝因短前缀率先匹配导致长秘钥残余明文泄露的问题。

---

### 4.3 Verification 执行链路 (`src/lib/verification/run-orchestrator.ts`)

- **解析选项**：`allowCredentials: false`。
- **模板解析**：Universal Assertions 的 `resolveInput(case.input, context)` 通过 `{{variables.KEY}}` 模板完成文本宏替换。
- **接线注入**：
  ```typescript
  const resolvedInput = resolveInput(caseItem.input, {
    variables: suiteContext.variables,
    ...(runContext ?? {}),
  });

  const outcome = evaluateAssertions(raw, caseItem.assertions, {
    input: resolvedInput,
    variables: suiteContext.variables,
    runContext,
  });
  ```

---

### 4.4 Evaluation 执行链路 (`src/lib/evaluation/eval-runner.ts`)

- **解析选项**：`allowCredentials: false`。
- **平铺注入**：
  ```typescript
  const deterministicOutcome = runDeterministicChecks({
    ...checkInput,
    variables: suiteVariables, // options.variables 平铺传入
  });
  ```

---

## 5. 语法规范与使用示例

### 5.1 Web-Auto 脚本与断言示例

#### 场景：登录后校验页面标题与用户信息

**1. Suite 变量配置 (Variables Tab)**：
- `baseUrl`: `"https://my-app.example.com/login"` (Literal)
- `expectedUser`: `"ops_admin"` (Literal)
- `adminPass`: 关联凭据 `Test Account (Testing Provider)` 的 `password` 字段 (Credential)

**2. 测试脚本 (Script Tab)**：
> **注意**：脚本内部使用原生 JavaScript 访问 `variables.<key>`，**不需要**加双花括号！

```javascript
// Playwright script (直接通过 variables.KEY 访问)
async (page) => {
  const loginUrl = variables?.baseUrl ?? 'https://my-app.example.com/login';
  await page.goto(loginUrl);

  // 引用凭证变量
  if (variables?.expectedUser && variables?.adminPass) {
    await page.fill('input[name="username"]', variables.expectedUser);
    await page.fill('input[name="password"]', variables.adminPass);
    await page.click('button[type="submit"]');
  }

  await page.waitForURL('**/dashboard');

  return {
    success: true,
    currentUser: await page.locator('.user-badge').textContent(),
    pageTitle: await page.title(),
  };
}
```

**3. 断言配置 (Assertions 列表)**：
> **注意**：断言中的声明式配置使用 `{{variables.KEY}}` 模板占位符！

- **断言 1 (JSONPath)**：
  - Path: `$.currentUser`
  - Operator: `==`
  - Expected: `{{variables.expectedUser}}`
- **断言 2 (LLM Expectation)**：
  - Expectation: `"仪表盘右上角必须展示用户 {{variables.expectedUser}} 的头像，且无报错提示。"`

---

### 5.2 Verification 接口契约示例

在 Verification 用例的输入 JSON 中直接使用模板语法：

```json
{
  "endpoint": "/api/v1/projects",
  "method": "GET",
  "headers": {
    "X-Environment-ID": "{{variables.ENV_ID}}",
    "Host": "{{variables.HOST_HEADER}}"
  }
}
```

---

## 6. 安全边界与约束清单

1. **凭据 Provider 严格受限**：
   凭据管理中仅分类为 `serviceType = "integration"` 且 `provider = "testing"` 的凭证可被变量系统选用。SSH 密钥、MCP 访问令牌等基础设施凭据无法被选作变量。
2. **凭据变量不可用于普通断言直接比对**：
   断言引擎由于断言绝缘机制，无法直接访问 `variables.<credentialKey>`。禁止在断言期望值中比对密码明文。
3. **最小长度脱敏过滤**：
   长度小于 4 个字符的敏感文本不进入脱敏字典，防止极短字符串（如 `"a"`, `"123"`）在页面普通文本或断言中造成大面积破坏性误遮罩。
4. **认知边界声明**：
   本系统保证的是 Nango 内部系统链路（PostgreSQL、API 接口、SSE 事件流、Inspector 审查界面、Evaluator 评测 Prompt）中敏感数据绝无泄露；无法且不应阻止自动化脚本向用户指定的被测目标网络地址发送身份验证请求。