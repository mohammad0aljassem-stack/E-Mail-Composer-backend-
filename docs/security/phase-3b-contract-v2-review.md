# Independent Security Review — Contract-v2 Worker Integration + Generation Fencing

- **Date:** 2026-07-14
- **Branch:** `fix/phase-3b-contract-v2-worker`
- **Reviewed commit (HEAD):** `039c8096108e584e0777ec904688d76aa73c6d7f`
- **Reviewer note:** Independent review (Agent 4). The reviewer did not author this code;
  probes, greps, and reasoning were written independently of the implementation and its
  test suite — the existing tests were not taken on trust. This record is content-free:
  it references control names and file paths only, and carries no code, secrets, MIME,
  credentials, hostnames, or production identifiers.

## Invariant verdicts

| #   | Invariant group                  | Verdict  | Content-free rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Snapshot-only reads              | **PASS** | Confirmed content resolves solely via `getSendSnapshot` / `getMirrorSnapshot` (`send-payload-resolver.ts`, `draft-mirror-payload-resolver.ts`, `repositories.ts`); every `draft_versions` occurrence in `src/` is a comment, no direct table read; `DraftVersionRepository`/`findDraftVersion` absent from `src/`; a missing/legacy/inconsistent snapshot raises the uniform P0002 mapped to `SnapshotUnavailableError` (`domain/errors.ts`) → `refuse("snapshot_unavailable")` → `toFailedBeforeDelivery`, zero SMTP.                                                                                                                                                                                                                                              |
| 2   | Definer-only exact-MIME artifact | **PASS** | No direct insert/update/delete on `send_mime_artifacts` in `src/`; creation only via the SECURITY DEFINER `create_or_verify` path, `getBySendAttempt` is a plain SELECT (`repositories.ts`); artifact is persisted while `claimed` and before the `claimed→smtp_in_progress` transition, which the DB guard refuses via SQLSTATE 23514 → `failed_before_delivery` with zero SMTP (`send-executor.ts`); the restart/`reconcileSentCopy` path reuses the stored bytes via `getBySendAttempt`, never calls `buildOutboundMime`, and appends over IMAP only (never `createSubmission`).                                                                                                                                                                                 |
| 3   | IMAP/SMTP endpoint split         | **PASS** | `requireSecureImapEndpoint` is referenced only by `createImapSession`, `requireSecureSmtpEndpoint` only by `createSubmission` (`provider-factory.ts`); `none`/null security fails closed with `config_invalid` before any credential read; read-only slices (sync/mutation/mirror/idle) use only `createImapSession`, and the idle coordinator is typed `Pick<…, "createImapSession">` so it cannot name the submission channel; `createSubmission` is called from exactly one send-executor site.                                                                                                                                                                                                                                                                  |
| 4   | Generation + token fencing       | **PASS** | `renewLease`, `markCompleted`, and `markFailed` are each a single atomic CAS on `status='claimed' AND attempt_count=<generation> AND claimed_at=<token>` (`repositories.ts`); singleton keys are generation-scoped (`queue-config.ts`, `queue-manager.ts`); the lifecycle sources the fencing tuple from the job payload with no `getById` re-read (the store dependency is narrowed to renew/complete/fail) and asserts ownership before every batch including the first (`sync-lifecycle.ts`, `sync-request-dispatcher.ts`); `reapExhausted` is the only unfenced terminal bound. Adversarial two-worker reasoning holds: a reclaim bumps the generation and moves the token, so the superseded claimant loses every renew/complete/fail CAS and changes nothing. |
| 5   | Preserved send-safety            | **PASS** | `send_message` queue `retryLimit === 0` with no enqueue-time override (`queue-config.ts`, `queue-manager.ts`); atomic claim + explicit CAS state machine intact and `smtp_in_progress` restart routes to `needs_human_review` (`send-executor.ts`); the logger enforces a forbidden-key redactor and value truncation (`observability/logger.ts`); no `rejectUnauthorized:false`, no `as any`, no TS-suppression in `src/` (only two justified `no-control-regex` disables in MIME sanitization); the sole production project-ref literal lives inside the sanctioned TEST-ONLY provisioning refusal guard, and provider brand names appear only in comments.                                                                                                       |

## Gates

Run independently at the reviewed HEAD (not altered):

| Gate                                                     | Result                                        |
| -------------------------------------------------------- | --------------------------------------------- |
| `pnpm typecheck`                                         | PASS (exit 0)                                 |
| `pnpm test` (unit project)                               | PASS — 22 files, 339 tests                    |
| `pnpm contract:verify` (`UI_REPO=../E-Mail-Composer-UI`) | PASS — checks 1–16 green, transportContract=2 |
| `pnpm lint`                                              | PASS (exit 0)                                 |
| `pnpm format:check`                                      | PASS (exit 0)                                 |

**DB-skip note:** The DB-backed integration suite requires `TEST_DATABASE_URL` /
`TEST_WORKER_DATABASE_URL`, which are unset in this environment, so those suites are
gated off (`HAS_DB=false`) and the unit gate does not exercise them. This is expected.
The two-worker reclaim-race integration test was read at source and would, against a live
Postgres, prove the cross-generation safety property: after a stale-lease reclaim into a
new generation, the superseded claimant's renew/complete/fail CAS all return null and the
row (status, last_error, claimed_at, generation) is unchanged while the new generation
owns and completes the request.

## Residual notes / limitations

- The generation+token fencing CAS behavior was verified by reading the SQL and by static
  reasoning; the reclaim-race property was NOT exercised against a live database here
  (no DB provisioned). The committed integration test is structured to prove it when a DB
  is present.
- Function-side (SECURITY DEFINER) re-hash / privilege boundaries live in the DB migration
  layer and the contract manifest; this review confirms the worker never bypasses them
  (no direct table writes, EXECUTE-only access pattern) but treats the definer functions
  themselves as verified by `contract:verify` rather than re-deriving their bodies.
- Review is static + gate-based; no production, Supabase, mailbox, or network resource was
  touched.

## Overall verdict

**PASS** — all five invariant groups pass and all runnable gates are green.
