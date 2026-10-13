# Official API notes used for the first core implementation

Checked on 2026-10-13 while wiring the initial project skeleton.

## Pi SDK

Sources: [Pi SDK](https://pi.dev/docs/latest/sdk), [Pi extensions](https://pi.dev/docs/latest/extensions), [Sessions and Context](https://pi.dev/docs/latest/sessions), and the installed [`@earendil-works/pi-coding-agent` 1.2.0 declarations/runtime](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

- The project pins `@earendil-works/pi-coding-agent` to `1.2.0`.
- `createAgentSession({ cwd, agentDir, sessionManager, resourceLoader })` is the SDK entry point. Pi owns the conversation tree, context, model/tool loop and persistence.
- `SessionManager.create(cwd, sessionDir?)`, `continueRecent(cwd, sessionDir?)`, `findById(cwd, id, sessionDir?)`, and `open(path, sessionDir?, cwdOverride?)` provide the new/continue/exact-resume paths.
- A supplied `DefaultResourceLoader` must be reloaded before it is supplied to `createAgentSession`; it accepts `additionalExtensionPaths`.
- Bind extension runtime after session construction with `session.bindExtensions({ mode: "print" })` for the headless CLI surface.

## Hindsight per-ID forget

Sources: [Memory API](https://hindsight.vectorize.io/developer/api/memories), [HTTP API reference](https://hindsight.vectorize.io/api-reference), [Operations](https://hindsight.vectorize.io/developer/api/operations), and [Node.js SDK](https://hindsight.vectorize.io/sdks/nodejs).

- The official per-memory endpoint list documents `GET`/`PATCH /v1/default/banks/{bank_id}/memories/{id}` and `DELETE /v1/default/banks/{bank_id}/memories/{id}/observations`; the supported single-memory `PATCH` can set `state: "invalidated"`, which is reversible and preserves the memory in an archive.
- The API reference documents clearing memories at bank scope and deleting a whole bank, while the SDK documents `deleteDocument(bankId, documentId)`. None of these establishes permanent deletion of an explicitly selected memory ID.
- Therefore `HindsightMemoryAdapter` exposes the contract method but reports `capabilities.forget: false`, emits a safe failed-operation audit/event, returns `UNSUPPORTED`, and makes no remote request. It must never widen a request into bank/document deletion. The capability can be enabled only after an official exact-ID deletion contract is verified.
- Hindsight isolation uses a bank; this project passes trusted `AdapterContext.projectId` to `bankForProject` for every memory operation.
