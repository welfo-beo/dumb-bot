# dumb-bot

Minimal TypeScript project built on the Pi SDK. Pi owns the only agent loop, session transcript, model/tool calls, and extension lifecycle; adapters register capabilities but do not run a second runtime.

## Setup and run

```bash
npm install
npm start
```

The CLI opens a persistent Pi session for the current directory and loads the registered i-have-adhd extension. Use `DUMB_BOT_CONTINUE=1 npm start` to continue the latest session for the current directory, or `DUMB_BOT_SESSION_ID=<exact-id> npm start` to resume one exact session. Type `/exit` to stop. Pi credentials and model selection remain managed by Pi's own configuration.

When `HINDSIGHT_BASE_URL` is configured, the CLI registers `hindsight_recall`, `hindsight_reflect`, and `hindsight_retain`; set `HINDSIGHT_API_KEY` only if the service requires it. Without the URL, memory tools are disabled with a startup hint. The current CLI binds Pi extensions in print mode, so retain has no interactive approval UI and always fails closed; do not use it as a writable memory client. Per-memory `forget` remains disabled because permanent exact-ID deletion is not confirmed by the upstream API. See [configuration and health checks](docs/configuration-health.md) before enabling a service.

## Configuration and health checks

See [配置与健康检查](docs/configuration-health.md) for Pi model setup, Hindsight environment variables, startup diagnostics, and safe health checks.

## Development checks

```bash
npm test
npm run typecheck
```

Core contracts are in `src/core/contracts.ts`; session selection and Pi SDK lifecycle are in `src/core/session.ts`; extension/adapter registration is in `src/core/registry.ts`. See `docs/CONTRACT-DRAFT.md` for module boundaries, approval/audit rules, project-isolated Hindsight banks, and the currently unresolved hard-delete semantics for `forget`.

## Third-party notices and SBOM

Third-party acknowledgements are in [`NOTICE`](NOTICE). The full dependency inventory and runtime-only inventory are available as [SPDX 2.3 SBOMs](docs/sbom.spdx.json) and [runtime SBOM](docs/sbom.runtime.spdx.json), generated from `package-lock.json`.
