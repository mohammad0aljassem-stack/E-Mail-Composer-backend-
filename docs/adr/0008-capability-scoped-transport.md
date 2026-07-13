# ADR 0008 — Capability-scoped transport worker (Phase 3B hardening)

## Status: accepted (Phase 3B corrective hardening)

Recorded against the Phase 3B readiness review of PR #4 (GitHub's numbers for
that PR: **27 files, +1235/−45**; earlier drafts of the review circulated
incorrect 26-file/+896 figures — use GitHub's).

## Context

The Phase 3A worker exposed one combined provider (IMAP + SMTP behind a single
object), one master feature flag, a single-batch sync lifecycle that could
mark a durable request complete prematurely, a stubbed send-payload resolver,
and no IDLE support. Each of those was a readiness blocker for the controlled
IONOS exercise (docs/phase-3b-runbook.md). This ADR records the corrective
decisions as one coherent design.

## Decisions

### 1. Capability-scoped provider split (C1)

`ProviderFactory` (src/workers/ports.ts) exposes two independent
constructors: `createImapSession` → `ImapSessionProvider` (no submission
method exists on the type) and `createSubmission` → `SubmissionProvider`
(constructed ONLY by the send executor after its guards pass). Read-only and
mailbox-mutating work — sync, mutation, draft mirror, Sent-copy
reconciliation, IDLE — can therefore never contact an SMTP server **by
construction**: the type system carries the proof, the test fakes count
constructions (`submissionsCreated === 0` across every non-send scenario),
and static scans (test/unit/static-regression-scan.test.ts) pin SMTP client
construction to the factory and ban SMTP coupling in the read-only modules.

### 2. Capability flags as backend runtime controls (C2)

Every worker capability has its own strict, fail-closed flag —
`MAIL_SYNC_ENABLED`, `MAIL_IDLE_ENABLED`, `MAIL_DRAFT_MIRROR_ENABLED`,
`MAIL_MUTATIONS_ENABLED`, `MAIL_SEND_ENABLED` — masked by the master
`MAIL_TRANSPORT_V1_ENABLED` (see src/config/env.ts and
src/entrypoints/registration-plan.ts; `idle` additionally requires `sync`).
These are **deliberately NOT part of the UI schema manifest**: they gate
backend worker registration, not database shape, so they must be operable
(e.g. Gate F's sync-only matrix) without a contract change. The boundary is
enforced by `pnpm contract:verify` check **12b**, which fails if any
`MAIL_*_ENABLED` flag is missing, bypasses the strict boolean parser, or
defaults to anything but the literal `false`.

### 3. Durable multi-batch sync lifecycle (C3)

A durable `transport.sync_requests` row is completed only when a batch
reports no follow-up. The bounded in-job batch loop, the fenced
`claimed_at`-CAS lease renewal (at most one effective claimant, no schema
change), the cursor-keyed continuation jobs, and every crash window are
documented in the **state diagram in the header of
src/workers/sync-request-dispatcher.ts** (see also ADR 0006). The in-job
bound is `SYNC_MAX_BATCHES_PER_JOB`.

### 4. Build-once MIME with a pinned date (C5)

The send executor builds the outbound MIME **once**, pins the RFC 5322 Date
to the attempt's evidence timestamp, submits those exact bytes over SMTP, and
appends the **same bytes** to the Sent folder — so the wire payload and the
Sent copy are byte-identical and hash-equal (no rebuild, no drifting
`new Date()`; enforced by static scan + byte-comparison tests).

### 5. draft_versions grant follow-up (C4 — pre-Gate-G prerequisite)

The production send-payload resolver reconstructs confirmed payloads from the
immutable `public.draft_versions` snapshots, but the canonical migrations
grant `transport_worker` **no SELECT** on that table. Until an **additive
UI-owned grant migration** (`GRANT SELECT ON public.draft_versions TO
transport_worker`, via the canonical manifest workflow) lands, the resolver
fails closed (`draft_version_unreadable`) and the draft mirror skips closed.
This is recorded as a Gate C grant item and a hard Gate G prerequisite in
docs/phase-3b-runbook.md — never an ad-hoc statement from this repo.

### 6. IDLE + periodic fallback coordinator (C7)

`src/workers/idle-coordinator.ts` maintains at most one IMAP session per
enabled mailbox (watching INBOX, the dispatcher's whole-mailbox default),
capped globally (`IDLE_MAX_SESSIONS`) with round-robin-by-workspace adoption
fairness. A wake-up enqueues ONE incremental sync under the plain
mailbox+folder singleton key (bursts coalesce via pg-boss null-dedup); a
silent IDLE window enqueues the same deduped fallback sync — a bounded
periodic fallback **internal to the worker**, never external cron or CI.
Kill switches are re-checked at every checkpoint; reconnects use bounded
exponential backoff with ±50% injectable jitter; `stop()` closes every
session. Registered only when `master && sync && idle` are all true.

## Consequences

- Gate F of the runbook is technically enforceable: the sync-only env matrix
  registers exactly the sync handler + dispatcher, with SMTP unconstructible.
- Gate G gains an explicit, documented database prerequisite (decision 5).
- Rollback gains per-capability granularity (restart-required env flags) on
  top of the live per-mailbox and global kill switches.
- All logs remain content-free (ids/counts/durations; the JsonLogger redactor
  is the backstop).
