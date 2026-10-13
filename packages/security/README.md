# `@dumb-bot/security` (draft)

Minimal, dependency-free workspace policy and approval gate. It owns no runtime or control plane; the shared core mapper converts its local events to the canonical contracts.

## Policy

- A `WorkspaceSecurity` instance is created for one workspace boundary (normally one session/workspace pair).
- File reads are allowed by default, but both lexical paths and resolved symlink targets must remain inside the canonical workspace root.
- File writes and command execution require a fresh, explicit, one-operation approval. Omitting the approval callback, a false decision, or an approval-provider error fails closed.
- File writes reject symlink targets; parent directories must already exist. No approval is requested for a path rejected by boundary checks.
- Commands use `spawn` with `shell: false`, require approval, and run with a working directory inside the workspace. Execution has a bounded timeout and output size.
- Audit events include only the stable capability/resource identifiers and timestamps. File content, command text/arguments, stdout/stderr, and provider error text are not copied into audit events. The approval callback receives private `details` so a host can present the exact operation to the approver; it must not persist those details as audit data.

## Important boundary

This package is an authorization and path-policy layer, **not an operating-system sandbox**. Explicit approval does not confine a process. **Before exposing any workspace file read/write or shell/command capability to an agent, the host must supply and verify an OS-level process sandbox. If that sandbox is unavailable or cannot be verified, do not register or invoke those capabilities.**

At minimum, the host sandbox must run with an unprivileged identity; restrict filesystem mounts to the intended workspace (and keep unrelated host files, credentials, sockets, and home directories inaccessible); deny network access by default unless explicitly allowlisted; disable privilege escalation and unnecessary Linux capabilities; apply syscall/process isolation; bound CPU, memory, process count, disk use, execution time, and captured output; and reliably terminate the process tree. Use the platform's native isolation primitives or a suitably restricted container. Re-check the configuration for each execution environment; path checks and one-operation approval in this package are additional controls, not substitutes.

## Pi native session transcript (JSONL): redaction is unverified

The event/audit protections above apply to package-generated security events and mapped audit records; they do **not** establish that Pi's native session transcript is redacted. `src/core/session.ts` delegates persistence to Pi's native `SessionManager` and does not intercept or rewrite its JSONL transcript. Treat transcript content—including prompts, assistant output, tool calls/results, and error details—as potentially sensitive unless verified otherwise.

Current redaction tests check that secrets and operation content are omitted from custom security events and custom audit/event entries (including test-double Pi extension entries). They do **not** inspect a real Pi-generated session JSONL file or verify full-transcript redaction. Therefore, full redaction of native session JSONL has not been tested and must not be claimed. Until it is verified, restrict access and retention of session files and avoid putting secrets or other sensitive content in sessions whose transcript may be persisted. Any future claim of transcript redaction requires tests against the actual Pi-managed JSONL, including prompt, assistant, tool input/output, error, and resumed-session paths—not only the custom audit/event payloads.

## Events and core mapping

The package-local `SecurityEvent` shapes remain an implementation boundary; they are **not** a second core event contract. The current core types live at `src/core/contracts.ts`; use the core bridge before publishing package events to the shared runtime/audit stream:

| Package event | Core event |
|---|---|
| `approval.requested` | `approval.requested` |
| `approval.resolved` with `approved: true` | `approval.granted` |
| `approval.resolved` with `approved: false` | `approval.denied` |
| `capability.executed` | `adapter.operation.completed` |
| `capability.denied` / `capability.failed` | `adapter.operation.failed` with a stable error code |

`src/core/security-event-mapper.ts` is the shared mapper for the canonical `src/core/contracts.ts` types. The host maps each package event with the active `runId`, then publishes the returned `runtimeEvent` and `auditRecord`. The mapper fills `adapterId`, `operation`, `access`, `outcome`, `sessionId`, `runId`, optional `approvalId`/`metadata`, and `occurredAt`; operation failures preserve only stable error codes. Do not add package event names to the core `RuntimeEvent` union or introduce a parallel session/adapter registry.

Capabilities are `workspace.read`, `workspace.write`, and `command.execute`. Timestamps are ISO-8601 strings. Core contract and module paths are documented in `../../docs/CONTRACT-DRAFT.md`.

## Use

```js
import { WorkspaceSecurity } from "@dumb-bot/security";
import { SecurityEventMapper } from "../../src/core/security-event-mapper.ts";

const mapper = new SecurityEventMapper();
const security = await WorkspaceSecurity.create({
  workspaceRoot: "/path/to/workspace",
  emit: async (event) => {
    const mapped = mapper.map(event, { runId: context.runId });
    await context.audit(mapped.auditRecord);
    await context.emit(mapped.runtimeEvent);
  },
  requestApproval: async (prompt) => approvalUi.confirm(prompt),
});

const text = await security.readFile({ sessionId: "session-1", path: "notes.txt" });
```

Run tests with `npm test` from this directory.
