# Hindsight memory adapter

This adapter implements the shared `MemoryAdapter` contract at `src/core/contracts.ts` and does not create a runtime or agent loop.

## Boundary

- Official Node/TypeScript client: [`@vectorize-io/hindsight-client`](https://hindsight.vectorize.io/sdks/nodejs). This implementation uses an injected `HindsightClient` interface so tests do not need a service or credentials; `HindsightRestClient` is the REST transport.
- REST routes used: `POST /v1/default/banks/{bank_id}/memories/recall`, `/reflect`, and `/memories` with `async: true`.
- `AdapterContext.projectId` is the trusted isolation boundary. `bankForProject(projectId, requestedBankId)` must resolve to a bank dedicated to that project; never infer project scope from `sessionId`, API credentials, or caller-controlled bank IDs alone.
- Hindsight is MIT licensed; see the [upstream LICENSE](https://github.com/vectorize-io/hindsight/blob/main/LICENSE).

## Configuration

`HindsightRestClient` requires `baseUrl`; `apiKey` is optional and must be supplied by host configuration, never hard-coded. `timeoutMs` defaults to 10 seconds. `HindsightMemoryAdapter` requires a `bankForProject` mapper and accepts an optional `redact` hook for retain payloads.

`recall` and `reflect` are read-only and emit completion/failure audit events. `retain` always requests approval before calling the remote service; denial has zero remote side effects. Approved retain is sent asynchronously with the caller's idempotency key. Only safe counts, project-scoped bank identifiers, and error codes go into audit metadata; memory text and credentials are not logged.

## Forget capability

The required `forget({ bankId, memoryIds, idempotencyKey }, context)` method currently fails closed with `UNSUPPORTED`, and this adapter reports `capabilities.forget: false`. Forget targeting is limited to the caller-supplied explicit `memoryIds`; it is never widened to a bank, session, or other ID set. The verified Hindsight API supports per-memory `PATCH` to `state: "invalidated"` (reversible soft-retire), while the reviewed official docs do not confirm a permanent per-memory `DELETE` endpoint. No request is sent to Hindsight (and no bank mapping is needed); the adapter never clears a bank, deletes unrelated IDs, clears only derived observations, or claims permanent erasure. The mock contract tests assert both `UNSUPPORTED` and zero client calls. Enable the capability only after an exact-ID permanent deletion API is confirmed and tested.
