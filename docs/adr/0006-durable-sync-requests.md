# ADR 0006 — Durable, claimable sync requests

## Status: accepted (Phase 3A hardening)

## Context

`request_mailbox_sync` used to be a fire-and-forget audit stub. The canonical
contract-hardening migration (`20260714100000`, UI `422485a`) turns it into a
durable, claimable work item: a `SECURITY DEFINER` RPC INSERTs a row into the
PRIVATE `transport.sync_requests` table (deduped per mailbox(+folder) while an
open `pending|claimed` request exists). The worker must **consume** those rows
without ever polling `transport_audit` (which is not a queue) and without
creating pg-boss jobs from SQL.

The worker holds **exactly** `SELECT` + `UPDATE` on `transport.sync_requests`
(never `INSERT`/`DELETE` — the DEFINER RPC is the only writer of new rows).

## Decision (`src/workers/sync-request-dispatcher.ts`)

A single `SyncRequestDispatcher` is the only consumer. Each dispatch pass:

1. `reapExhausted` — a STALE `claimed` row whose `attempt_count` reached
   `maxAttempts` is moved to `failed` with a bounded, content-free code.
2. `claimBatch` — a **single atomic statement**:
   `UPDATE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING ...`.
   Exactly one worker claims any one row (two-worker races resolve to one).
3. For each claimed row: if the mailbox is not syncable (missing / disabled /
   kill switch), mark the request `failed` (content-free code) and enqueue
   nothing (no IMAP connect). Otherwise enqueue a `sync_mailbox` pg-boss job with
   a **deterministic** `singletonKey = sync-req:{id}`.

### State flow

```
pending --claim--> claimed --success--> completed
                       \--terminal fail / exhausted--> failed
```

- **On claim:** `status='claimed'`, `claimed_at=now()`, `attempt_count += 1`.
  `attempt_count` increments **only** on a durable (re)claim — never per pg-boss
  retry.
- **`completed_at`** is set only by `markCompleted` (`claimed -> completed`),
  called by the `sync_mailbox` job handler **after** the sync completes.
- **`claimed_at`** is written on every claim and is intentionally **not** nulled
  on completion/failure; it is the last-claim timestamp (retained for audit).
- Whole-mailbox (`folder = NULL`) → an `initial` discovery pass; a folder-scoped
  request → an `incremental` sync of that folder. Distinct rows/ids (per
  `uq_sync_requests_open`) map to distinct deterministic keys.

### Lease + stale detection (crash recovery)

A `claimed` row whose `claimed_at` is older than the **lease**
(`SYNC_CLAIM_LEASE_MS`, default **300 s**) is STALE: the claiming worker is
presumed dead (crash-after-claim-before-enqueue, or a restart mid-flight). It
becomes reclaimable on the next pass; a **fresh** claim (recent `claimed_at`) is
never stolen.

- **Crash after claim, before enqueue:** the lease expires → the row is
  reclaimed (`attempt_count += 1`) and re-enqueued. Recovery is automatic.
- **Crash after enqueue, before ack:** the deterministic `sync-req:{id}` key
  means a re-dispatch cannot create a duplicate job — pg-boss dedups it.

### Max attempts vs `sync_mailbox.retryLimit = 5` (no multiplication)

Two **independent** layers that must not multiply into an undocumented count:

- **pg-boss `retryLimit = 5`** retries the _executed job_ for transient IMAP
  errors **within one durable claim**. These do **not** touch `attempt_count`.
- **`attempt_count` (`SYNC_MAX_ATTEMPTS`, default 5)** bounds _re-dispatch_
  (crash / lease expiry only).

In the absence of crashes a request is claimed **once** and enqueued **once**, so
the execution count is bounded by 5 (pg-boss) — **not** `maxAttempts × 5`. A
clean job failure on its final pg-boss attempt is terminal: the handler calls
`markFailed` (`-> failed`, content-free code) and the request is **not**
re-dispatched. Durable re-claim happens only when a claim went stale without a
terminal result; `reapExhausted` is the hard cap that fails a stale request once
`attempt_count` reaches `maxAttempts`.

### Safety

- Runs **only** when `MAIL_TRANSPORT_V1_ENABLED=true`. With the flag off,
  `dispatchOnce` is a no-op: it never claims, never enqueues, never connects.
- The **global** kill switch and per-**mailbox** kill switch / disabled flag are
  respected before any IMAP connect.
- `last_error` carries **only** a short bounded code — never a body, MIME,
  credential, raw provider response, attachment, or connection string.
- Restart behavior: on worker restart the dispatch interval simply resumes;
  in-flight pg-boss jobs are recovered by pg-boss; stale durable claims are
  recovered by the lease. No work is lost and none is duplicated.

## Configuration

| Env                         | Default | Meaning                                       |
| --------------------------- | ------- | --------------------------------------------- |
| `SYNC_DISPATCH_INTERVAL_MS` | 5000    | dispatcher poll interval                      |
| `SYNC_CLAIM_LEASE_MS`       | 300000  | stale-claim lease timeout                     |
| `SYNC_CLAIM_BATCH_SIZE`     | 10      | max requests claimed per pass                 |
| `SYNC_MAX_ATTEMPTS`         | 5       | hard cap on durable re-claims before `failed` |
