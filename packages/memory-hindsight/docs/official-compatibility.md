# Hindsight 官方兼容性核验

- 核验时间：2026-10-13
- 适配目标：`packages/memory-hindsight`

## 结论

- Hindsight 官方仓库最新 release 为 **v0.10.3**；官方 Node.js/TypeScript SDK `@vectorize-io/hindsight-client` 当前 npm 版本为 **0.10.3**，许可证 **MIT**。上游仓库许可证同为 MIT。本适配器直接调用公开 REST API，以保持零运行时依赖。
- 官方 Pi 接入由 Hindsight coding-agent 安装器完成：
  ```bash
  npx @vectorize-io/hindsight-coding-agents install pi
  ```
  官方说明此路径安装 Pi extension entry 与 companion skill；不是 `pi install npm:@vectorize-io/hindsight-coding-agents`。Pi 目录中另有第三方包 `pi-hindsight` 1.4.2（ISC，仓库 `anh-chu/pi-hindsight`），不可误认为 Vectorize 官方包。
- Hindsight 的隔离原语是 memory bank。适配器按 `projectId + logical bankId` 生成稳定、不可逆的独立远端 bank ID，禁止共享默认 bank 回退。
- **按单个 memory ID 的物理删除能力未获官方 API 确认，因此 `forget` 必须 fail-closed。** 官方 `PATCH /memories/{id}` 将 memory 设置为 `invalidated`，仅使其不再参与 recall，数据仍保留且可恢复；官方 `DELETE /documents/{id}` 会删除整个文档及其关联记忆，范围可能大于显式 ID。二者都不符合“精确删除一个或多个 memory IDs”的物理擦除语义。
- 本次复核官方 [Memories API](https://hindsight.vectorize.io/developer/api/memories) 的单条资源端点清单：单条 memory 提供 `GET` 和 `PATCH`；`DELETE /memories/{id}/observations` 只清除派生 observations，官方明确说明 memory 本身不会被删除。官方 [Documents API](https://hindsight.vectorize.io/developer/api/documents) 的文档删除会永久移除该文档及其所有关联 memory；API reference 的 bank 删除则删除整个 bank。**当前公开 API 文档没有按一个或多个显式 memory ID 永久删除 memory 的端点。**
- 根据开发方最新决定，本适配器声明 `capabilities.forget: false`。调用 `forget` 只写安全审计、发失败事件并返回 `FORGET_UNSUPPORTED`；不请求审批、不调用远端 mutation、不降级为文档或 bank 删除。确认上游有稳定精确删除 API 后再启用。

## 本包使用的官方 REST 操作

| 操作 | HTTP 端点 | 处理方式 |
|---|---|---|
| Retain | `POST /v1/default/banks/{bank_id}/memories` | 异步 retain，传入项目隔离后的 bank 与确定性 UUID `operation_id` |
| Recall | `POST /v1/default/banks/{bank_id}/memories/recall` | 传 `query` 与 `max_tokens`，本地按 `limit` 截断 |
| Reflect | `POST /v1/default/banks/{bank_id}/reflect` | 传 `query`（宿主 evidence 拼入 query）、可选 `budget` / `max_tokens`；不传已弃用的 `context` 或未定义的 `include_facts` |
| Forget | 未启用 | 官方没有已确认的单 memory 物理删除 endpoint；能力标记为 false |

## 失败响应

- self-hosted API 默认不启用鉴权；启用内置 API key 后，使用 `Authorization: Bearer <key>`，无效 key 返回 HTTP 401。本适配器按 401 返回 `AUTHENTICATION`。
- 官方操作 reference 将输入验证错误标为 422；异步 retain 的 `operation_id` 被另一请求占用时返回 409。本适配器分别保留为 `HINDSIGHT_HTTP_422` 和 `HINDSIGHT_HTTP_409`，并附 `statusCode`，不把上游响应正文传进错误消息或审计。
- 网络失败、超时、中止和无效 JSON 分别映射为稳定的 typed error；不自动重试，避免写请求的副作用不确定。HTTP 403/429 在官方操作契约中没有专门错误定义，因此作为通用 `HINDSIGHT_HTTP_<status>` 处理，不假设 Hindsight 特有的授权或限流语义。

## 与 core / security 合同的对齐

- 正式类型源为 `src/core/contracts.ts`：`AdapterContext` 含 `projectId`，recall/reflect/retain 使用逻辑 `bankId`，forget 为可选扩展且 `capabilities.forget` 必填。本包按 `projectId + bankId` 映射远端 bank，并实现可观察的 fail-closed `forget`。
- `packages/security` 的 `approval.resolved`、`capability.executed/denied` 字段与 core 的 `approval.granted/denied` 及 adapter operation 事件不同。本包通过 core `AdapterContext` 使用正式事件与 audit 类型，不自行建立第二套审批事件。

## 官方来源

- Hindsight 仓库与许可证：<https://github.com/vectorize-io/hindsight> / <https://raw.githubusercontent.com/vectorize-io/hindsight/main/LICENSE>
- Hindsight release：<https://github.com/vectorize-io/hindsight/releases>
- 官方 TypeScript SDK：<https://hindsight.vectorize.io/sdks/nodejs>
- 官方 API quick start：<https://hindsight.vectorize.io/developer/api/quickstart>
- 官方 retain：<https://hindsight.vectorize.io/developer/api/retain>
- 官方 recall：<https://hindsight.vectorize.io/developer/api/recall>
- 官方 reflect：<https://hindsight.vectorize.io/developer/api/reflect>
- 官方 memories / invalidate：<https://hindsight.vectorize.io/developer/api/memories>
- 官方 documents / delete cascade：<https://hindsight.vectorize.io/developer/api/documents>
- 官方 Pi 安装说明：<https://github.com/vectorize-io/hindsight/blob/main/hindsight-integrations/coding-agents/README.md>
- Pi 目录中的第三方 package 信息：<https://pi.dev/packages/pi-hindsight>
- SDK registry metadata：<https://registry.npmjs.org/@vectorize-io%2fhindsight-client>
