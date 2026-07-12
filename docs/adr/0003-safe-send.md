# ADR 0003 — Safe-send state machine

## Status: accepted (Phase 3A)

## Context

Sending must be safe under crashes, restarts, duplicate jobs and ambiguous SMTP
outcomes, while SMTP itself provides no exactly-once guarantee.

## Decision

Sending derives from the **immutable `send_intents` snapshot**, never a mutable
draft row. `src/workers/send-executor.ts` implements the state machine below;
the authoritative transition table also lives in SQL
(`public.phase3_send_attempt_transition_ok`) and in `src/domain/send-state.ts`.

```
pending_confirmation ─▶ confirmed ─▶ queued ─▶ claimed ─▶ smtp_in_progress
                                                    │            │
                                                    │            ├─▶ smtp_accepted ─▶ sent_copy_pending ─▶ completed
                                                    │            │                └────────────────────▶ completed
                                                    │            ├─▶ failed_before_delivery   (pre-DATA)
                                                    │            └─▶ needs_human_review        (ambiguous)
                                                    ├─▶ failed_before_delivery  (integrity)
                                                    └─▶ needs_human_review       (bad proof)
```

`completed`, `needs_human_review`, `cancelled` are **terminal** for the
automated path. There is **no edge back into SMTP after acceptance**, and none
from `smtp_in_progress` back to `queued`.

### Ordered guarantees

1. **Immutable source.** The snapshot (recipients, body hashes, attachment
   manifest, Message-ID, confirmation proof) is frozen at confirmation.
2. **Kill/enabled checks before claiming.** Global + per-mailbox kill switch and
   `enabled` are checked while still `confirmed`; if blocked, the attempt is
   **not consumed** (re-drivable after lifting).
3. **Atomic claim.** `transport.worker_claims` has a unique `send_attempt_id`;
   `INSERT … ON CONFLICT DO NOTHING` means at most one worker delivers.
4. **Integrity re-verification after claim** (from `claimed`, the only state
   from which `needs_human_review`/`failed_before_delivery` are legal):
   confirmation present, **confirmation proof re-derived and matched**
   (`src/domain/confirmation-proof.ts`, parity-tested against the SQL RPC),
   draft revision, recipients, body hashes, attachment manifest + sizes, and
   Message-ID all matched. A tampered proof → review; a payload mismatch →
   `failed_before_delivery`.
5. **Network outside DB transactions.** The SMTP call runs after the CAS to
   `smtp_in_progress`, never inside a long transaction.
6. **Restart safety.** Finding an attempt already `smtp_in_progress` →
   `needs_human_review` (DATA may be in flight; never auto-send).
7. **Pre-DATA failure** (`SmtpPreDataError`: connect/auth/envelope, nothing
   submitted) → `failed_before_delivery`, no retry.
8. **Ambiguous failure** (`SmtpAmbiguousError`: timeout/disconnect during-or-
   after DATA, lost response) → `needs_human_review`, Message-ID + evidence
   preserved, **never auto-enqueue another send**. Unknown errors default to
   ambiguous (the safe classification).
9. **After acceptance, Sent-copy reconciliation only.** Search the Sent folder
   by Message-ID; append only if absent. A Sent-append failure → `sent_copy_pending`
   (reconcile by search), **never** a delivery retry.

### Exactly-once INTENT vs exactly-once DELIVERY

We guarantee the **decision to send** happens at most once (immutable snapshot +
unique idempotency key + atomic claim + zero retries). We **do not** claim
exactly-once _delivery_ — SMTP cannot provide it. The Message-ID is generated
**before** enqueue, stored in the snapshot, and **reused** for SMTP, the Sent
copy, and reconciliation, so a possibly-delivered message is never duplicated by
our own machinery.

## Consequences

Human review is a first-class outcome, not an error. Operators, not the worker,
resolve genuine ambiguity (see the runbook).
