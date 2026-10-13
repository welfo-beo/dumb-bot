# dumb-bot 集成契约（草案 v0.2）

> 本文件与 `src/core/contracts.ts` 对齐；Pi 是唯一 runtime。核心 session/registry 实现不得再造一套 agent loop。adapter/extension 按下列路径集成，最终注册以核心 registry 为准。

## 模块路径

- `src/core/contracts.ts`：唯一核心 capability、审批/审计事件和 memory 方法签名。
- `src/core/session.ts`：Pi session 创建/恢复与生命周期（核心）。
- `src/core/registry.ts`：extension/adapter 注册、查询和能力声明（核心）。
- `src/extensions/adhd/`：Pi 原生 i-have-adhd extension/skill。
- `packages/memory-hindsight/`：Hindsight memory adapter 唯一实现；`src/adapters/memory/hindsight/index.ts` 仅为兼容 re-export。
- `src/extensions/hindsight/`：将同一 adapter 实例暴露为 Pi recall/reflect/retain 工具。
- `src/adapters/provider/freellmapi/`：FreeLLMAPI/OpenAI-compatible provider adapter。
- `packages/security/`：独立 workspace policy 包；它的 package event 必须映射到核心 `RuntimeEvent`，不是第二套核心事件契约。
- 测试位于相应 `test/` 子目录；不要覆盖或重排其他模块。

## 默认策略与事件

每个 adapter 默认只读（`policy.defaultAccess: "read-only"`）；任何写入/副作用都要显式审批，拒绝时零副作用。所有成功/失败操作及审批申请/结果均通过 `src/core/contracts.ts` 中的 `RuntimeEvent` 和 `AuditRecord` 记录。事件名固定为 `approval.requested`、`approval.granted`、`approval.denied`、`adapter.operation.completed`、`adapter.operation.failed`。审计 metadata 只允许安全摘要，不能含 API key、原始提示词或未脱敏 memory 内容；长任务遵守 `AbortSignal`，可重试写入使用幂等键。

`packages/security` 的事件映射：其 `approval.requested` 映射为核心同名事件；`approval.resolved(approved=true/false)` 分别映射为 `approval.granted` / `approval.denied`；`capability.executed` 映射为 `adapter.operation.completed`；`capability.denied` 映射为 `adapter.operation.failed`。宿主从当前 Pi 运行上下文补充 `runId`，安全包原始事件只作为包内输入，不新增核心事件名。

## Memory adapter 签名

具体 TypeScript 类型以 `src/core/contracts.ts` 为准：

- `recall({ bankId, query, limit? }, context) -> Promise<readonly MemoryRecord[]>`
- `reflect({ bankId, query, evidence? }, context) -> Promise<string>`
- `retain({ bankId, items, idempotencyKey }, context) -> Promise<MemoryRetainReceipt>`
- `forget({ bankId, memoryIds, idempotencyKey }, context) -> Promise<{ deleted: number }>`（方法固定存在；是否可用由 `capabilities.forget: boolean` 明确声明）

`AdapterContext.projectId` 是可信的稳定项目/workspace 标识。每个 `bankId` 必须经项目边界映射到**该项目专用的 Hindsight bank**；不能仅凭 `sessionId` 隔离，也不能允许请求选择其他项目的 bank。`recall`/`reflect` 只读；`retain` 和 `forget` 都是写操作，必须先审批，再有副作用并审计。`forget` 只能作用于 `memoryIds` 明列的对象，绝不允许退化为清空 bank；所有写请求必须使用幂等键。

### Hindsight forget 状态

截至本草案更新，Hindsight 官方 memory API 确认单条 memory 可通过 `PATCH .../memories/{id}` 设为 `invalidated`（软删除：从 recall 移除、仍保留在可恢复归档中），但未确认按 memory ID 永久删除的 HTTP endpoint。故 Hindsight adapter 的 `forget` 方法 fail-closed 并返回 `UNSUPPORTED`，同时声明 `capabilities.forget: false`，不会发送远端写请求。实现不得把清除 observations、删除整个 bank 或删除 document 冒充单条永久删除；只有核实底层支持精确 ID 删除后才可启用。

## 对接约定

Pi SDK/ExtensionAPI 只使用锁定版本的公开 API。registry 保存 session/runtime 权威状态，adapter 只负责自身服务映射；未知能力须显式失败，不得静默假设。

## File and command capability activation gate

当前 Pi Hindsight extension 只注册 `hindsight_recall`、`hindsight_reflect` 和仅在 Pi TUI 中经明确 UI 同意的 `hindsight_retain`；print/RPC/no-UI、用户拒绝、取消或缺少审批上下文时均 fail-closed。不得注册未经审批的 workspace-write 或 command/shell 工具。`packages/security` 提供应用层路径策略和逐操作审批，**不是 OS 进程沙箱**。在向 agent 暴露任何文件读取/写入或 shell/命令能力之前，宿主必须先提供并验证 OS 级隔离；缺少或无法验证隔离时，这些能力必须保持未注册、不可调用。

最低 OS 沙箱要求：使用非特权身份；文件系统只挂载所需 workspace，且不得暴露无关宿主文件、home、凭据、socket 或 secret；默认禁止网络、仅按需 allowlist；禁止提权并限制 syscall/process/capabilities；对 CPU、内存、进程数、磁盘、执行时间和输出设置上限；并确保可终止整个子进程树。每个运行环境都需重新核验。应用层边界检查与一次性显式审批仍须保留，但不能替代 OS 隔离。

审批确认界面可向用户呈现作出知情决定所必需的精确操作内容；自定义审批/运行事件与审计记录不得持久化密钥、文件正文、记忆正文、命令参数或输出。敏感操作详情只能留在可信审批回调的短暂内存路径中，不能复制到审计 metadata、自定义 Pi session event 或错误文本。

**Pi 原生 session JSONL transcript 的全量脱敏尚未验证。** `src/core/session.ts` 使用 Pi 原生 `SessionManager` 持久化/恢复 session，当前测试只覆盖自定义安全审计字段及自定义扩展条目，不读取真实 Pi JSONL 文件；不得据此声称 prompt、assistant 输出、tool 调用/结果等 transcript 内容已脱敏。验证完成前应将原生 session 文件按可能含敏感内容处理，限制访问与留存，并避免在可能持久化的 session 中放入 secret。若要宣称原生 transcript 脱敏，必须对 Pi 实际生成的 JSONL（含恢复路径）增加端到端验证。详见 [`packages/security/README.md`](../packages/security/README.md)。
