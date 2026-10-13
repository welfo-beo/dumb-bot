# 模型与 Hindsight 配置及健康检查

本文说明 dumb-bot 如何依赖 Pi 的模型配置，以及 Hindsight memory 的可选配置、检查方式和缺配置提示。配置值由宿主进程提供；不要把 API Key 写入仓库、日志、审计记录或共享文档。

## 模型（Pi）

Pi 是模型认证和模型选择的唯一来源；`dumb-bot` 不读取或复制 Pi 的密钥，也不会替 Pi 选择模型。

### 配置

- 交互式 Pi provider：先启动 `pi`，使用 `/login` 完成 provider 认证，再用 `/model` 选择模型；随后启动或重启 `dumb-bot`。
- OpenAI/Anthropic/Google 兼容端点：按 Pi 的 `models.json` 格式配置 provider、API 类型及 model ID。认证密钥优先使用 Pi 支持的环境变量插值，不要把生产密钥明文放进项目配置。
- Pi 的认证文件、模型配置位置和 provider-specific 认证方式以安装的 Pi 版本文档为准。`dumb-bot` CLI 启动时若 session 没有模型，会提示先配置 Pi provider、登录并选定模型。

### 本地检查与端到端检查

在与 `dumb-bot` 相同的用户和环境中检查 Pi 是否能发现模型、是否有可用凭据：

```bash
pi --list-models
pi auth check --model <provider/model> --json
```

`auth check` 检查凭据就绪状态，不要加 `--credentials`（那会输出密钥）。如果模型未出现在列表中，检查 Pi 的 provider/model 配置和启动进程可见的环境变量；如果 `auth check` 返回未就绪，按 provider 的 Pi 登录方式配置凭据。实际生成请求才是端到端连通性检查；它会向模型服务发送数据，可能产生费用，本文任务没有执行该请求。

`src/adapters/provider/freellmapi` 是可注入 `fetch` 的 OpenAI-compatible transport adapter，并不自动替换 Pi 的模型选择或配置。

## Hindsight memory（可选）

### 配置

- 设置 `HINDSIGHT_BASE_URL` 为 Hindsight service 的绝对 `http://` 或 `https://` URL。配置中不得嵌入用户名、密码、query 或 fragment。
- 若服务启用了 API key 鉴权，再设置 `HINDSIGHT_API_KEY`。自托管服务未启用鉴权时，API key 可以不设置；不要为了满足配置而填入占位密钥。
- 可选密钥只从运行时安全环境传入，不能写入源码。dumb-bot 缺少 `HINDSIGHT_BASE_URL` 时会禁用 memory adapter 并打印上述变量名与条件；格式错误时仅输出安全的配置提示，不打印原始值或异常详情。
- 缺少 Hindsight URL 不会阻止 Pi 模型运行。Hindsight adapter 的默认请求超时为 10 秒；当前 CLI 不单独暴露 timeout 环境变量。

### 健康检查

启动时只做本地配置校验，不会探测 Hindsight 服务。当前项目核验过的 REST 契约没有确认独立健康检查路由，因此不要假设 `/health` 可用，也不要把启动成功当作服务健康证明。

需要检查实际连通性时，在 Hindsight 已配置并启动后，使用项目自己的逻辑 bank 和无敏感内容的查询发起一次 `hindsight_recall`（只读）或 `hindsight_reflect`（只读）调用。adapter 会依据可信 `projectId` 将逻辑 bank 映射到项目隔离的远端 bank。不要用 `retain` 做健康检查；写入须审批且会产生副作用。常见错误分类：`AUTHENTICATION` 表示 HTTP 401，`TIMEOUT` 表示请求超时，`NETWORK_ERROR` 表示网络请求失败，其他 HTTP 响应保留为 `HINDSIGHT_HTTP_<status>`。响应正文、密钥和记忆正文不会进入错误消息/审计摘要。

## Mock 验证

本项目的配置与脱敏验证应使用单元 fake 或本地 fake server，不使用真实账号、真实模型凭据或外部服务：

```bash
npm test
npm run typecheck
```

测试覆盖非法 URL/timeout、模型 endpoint URL 规范化、mock 认证失败，以及凭据不进入异常、audit 或 event。部署后的真实连通性验证须由运维者在目标环境单独执行，并应使用只读请求。
