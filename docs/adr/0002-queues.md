# ADR 0002 — pg-boss queue families and policies

## Status: accepted (Phase 3A)

## Context

Four job families with very different retry/idempotency needs. SMTP delivery in
particular must **never** be blindly retried.

## Decision (`src/queues/queue-config.ts`)

All families use the pg-boss `short` policy so a `singletonKey` **deduplicates a
duplicate enqueue** (verified empirically for pg-boss 12; the default `standard`
policy does not dedup). Per-workspace fair concurrency uses pg-boss **job
groups** (`group.id = workspaceId`), not a global singleton.

| Queue            | retryLimit | backoff                                    | singletonKey (dedup)                     |
| ---------------- | ---------- | ------------------------------------------ | ---------------------------------------- |
| `sync_mailbox`   | 5          | bounded exponential (`retryDelayMax` 300s) | `sync:{mailbox}:{folder}`                |
| `draft_mirror`   | 3          | bounded exponential                        | `draft:{draftId}:{revision}`             |
| `send_message`   | **0**      | none                                       | `send:{sendIntentId}`                    |
| `apply_mutation` | 5          | bounded exponential                        | `mutate:{mailbox}:{folder}:{uid}:{kind}` |

### Why `send_message` has `retryLimit === 0`

SMTP is **not exactly-once delivery**. A transport-level retry of a message that
may already have been delivered would double-send. Instead:

- The _intent_ is exactly-once (immutable `send_intents` + unique idempotency
  key + atomic claim).
- There is **no queue retry and no generic retry wrapper**. A failed send lands
  in an explicit terminal state (`failed_before_delivery` or `needs_human_review`)
  and is **never re-enqueued automatically**.

Asserted by `test/unit/queue-config.test.ts` and, against real pg-boss metadata,
by `test/integration/schema-and-queues.test.ts`.

## Consequences

Idempotency is enforced at two layers: pg-boss `singletonKey` dedup for the
enqueue, and DB constraints (`send_intents.idempotency_key` unique, atomic
`worker_claims`) for execution.
