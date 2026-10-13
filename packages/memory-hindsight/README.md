# `@dumb-bot/memory-hindsight`

为 `dumb-bot` 提供独立的 Hindsight 记忆适配器，不创建第二套 runtime，也不修改核心文件。唯一核心类型源为 [`src/core/contracts.ts`](../../src/core/contracts.ts)。

## 契约与项目隔离

适配器实现：

- `recall({ bankId, query, limit? }, context)`
- `reflect({ bankId, query, evidence? }, context)`
- `retain({ bankId, items, idempotencyKey }, context)`
- `forget({ bankId, memoryIds, idempotencyKey }, context)`：接口存在，但当前能力关闭，见下文。

每次调用都必须带逻辑 `bankId`，`AdapterContext.projectId` 也必须存在。适配器将二者分别做 SHA-256 摘要后组合成确定、不可逆的 Hindsight bank ID：

```text
dumb-bot-${sha256(projectId)[0:32]}-${sha256(bankId)[0:32]}
```

因此即使两个项目传入相同逻辑 `bankId`，远端 Hindsight bank 仍不同；项目 ID 和逻辑 bank ID 不以明文出现在 Hindsight 路径中。`hindsightBankIdForProject(projectId, bankId)` 导出供宿主预创建/核对 bank。适配器没有共享 bank 或默认 bank 回退。

`retain` 遵守核心只读默认策略：写入前先请求 `context.requestApproval`，拒绝时不调用 Hindsight。审批、批准/拒绝、操作成功/失败均按 `src/core/contracts.ts` 的 `RuntimeEvent` 和 `AuditRecord` 记录；审计只包含计数、错误码等摘要，不记录正文、查询、memory ID、API Key 或幂等键。retain 使用异步 operation，并以项目 bank 与 `idempotencyKey` 派生 Hindsight 支持的稳定 UUID `operation_id`。

`packages/security` 目前发出 `approval.resolved`、`capability.executed/denied` 等事件，与 core 的 `approval.granted/denied`、adapter 操作事件不是同一合同。本包仅依赖 core `AdapterContext`，不直接依赖或篡改 security 包事件；宿主若要连接两者，应在 core/host 层明确映射。

## `forget`：当前 unsupported，fail-closed

Hindsight 官方当前没有确认可按一个 memory ID **物理删除**的 API。已核实的单条 memory `PATCH` 是可恢复的 `invalidated` 状态；它只让 world/experience fact 离开 recall，数据仍保留在 Hindsight 审计存储中，且 observation 是派生数据。按 document 删除会级联删除同一文档的多条记忆，清空 bank 的影响更大。

因此适配器明确声明 `capabilities.forget === false`。调用 `forget` 会发出 core `adapter.operation.failed` 事件、写入安全审计记录并抛出 `FORGET_UNSUPPORTED`；**不会请求审批，也不会调用 PATCH、DELETE document 或清空 bank**。待 Hindsight 提供稳定、精确的单 ID 删除 API 并确认可用后再启用。此选择避免把可恢复失效冒充为删除，也避免扩大删除范围。

## 配置与使用

Node.js 20+；本包无运行时依赖，使用内置 `fetch`。如服务启用鉴权，通过宿主安全配置传入 API Key，禁止硬编码：

```js
import { HindsightMemoryAdapter } from "@dumb-bot/memory-hindsight";

const memory = new HindsightMemoryAdapter({
  baseUrl: process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888",
  apiKey: process.env.HINDSIGHT_API_KEY,
  timeoutMs: 10_000,
});

// 调用方必须提供符合 src/core/contracts.ts 的 AdapterContext，
// 并在每次调用中传入当前项目的逻辑 bankId。
```

也可注入实现 `retainBatch / recall / reflect` 的 `client`，便于宿主定制传输与测试。`redact` 是可选的最后一道内容处理钩子；核心契约仍要求调用方在交给 adapter 前完成敏感信息脱敏。

完整的环境变量、启动提示和健康检查约定见项目级 [配置与健康检查指南](../../docs/configuration-health.md)。构造器只校验 URL/timeout 等本地配置，不会在启动时连接服务；当前未确认独立 `/health` 路由。连通性应在部署环境用项目隔离 bank 执行只读 recall/reflect 检查，不能用 retain 写入做探测。

## 运行契约集成测试

测试启动本地 fake Hindsight HTTP 服务，不需要外网、Hindsight 实例或凭据：

```bash
cd packages/memory-hindsight
npm test
```

## 官方核验

截至 2026-10-13，Hindsight 官方仓库最新 release 与官方 TypeScript 客户端版本均为 `0.10.3`；客户端包 `@vectorize-io/hindsight-client` 为 MIT。本适配器直接使用公开 REST API 以保持零运行时依赖。官方 Pi 接入路径是 `npx @vectorize-io/hindsight-coding-agents install pi`；Pi 目录中的 npm 包 `pi-hindsight`（1.4.2，ISC）由第三方维护，并非 Hindsight 官方包。详见 [`docs/official-compatibility.md`](docs/official-compatibility.md)。
