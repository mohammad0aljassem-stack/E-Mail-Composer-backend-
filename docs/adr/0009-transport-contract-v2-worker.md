# ADR 0009 — Transport contract v2 worker integration

## Status: accepted (Phase 3B contract-v2 integration)

## Context

The canonical UI contract advanced to **transport contract v2** (manifest
`transportContractVersion: 2`, pinned in
`config/canonical-transport-contract.lock.json` at UI commit
`4bca2fc…`). v2 adds two private `SECURITY DEFINER` accessors and one private
artifact table to the schema the worker must integrate against:

- `transport.get_send_snapshot(uuid)` / `transport.get_mirror_snapshot(uuid,uuid,bigint)`
  — the ONLY sanctioned reads of confirmed send content.
- `transport.send_mime_artifacts` + `transport.create_or_verify_send_mime_artifact(...)`
  — durable, byte-verified persistence of the exact outbound MIME, gated so no
  SMTP byte can leave before the artifact exists.

The worker's grants are unchanged in shape: **EXECUTE** on the three v2
functions, **SELECT + UPDATE** (never INSERT/DELETE) on
`transport.send_mime_artifacts`, and **no** grant on `public.draft_versions`.

## Decision

### 1. Confirmed content is read ONLY through the snapshot functions

The send-payload resolver resolves by `send_intent_id` via
`transport.get_send_snapshot` (`src/workers/send-payload-resolver.ts`,
`src/db/repositories.ts`). The direct `public.draft_versions` read and its
`draft_version_unreadable` fail-closed branch were **removed** (the old
`DraftVersionRepository`/`findDraftVersion` is deleted). A legacy proof-v1 /
`contract_version != 2` intent, or a missing bound snapshot, raises a uniform
`P0002` that maps to a content-free `SnapshotUnavailableError` → the send fails
closed (`snapshot_unavailable`) with **zero** SMTP bytes. The worker never reads
the mutable draft. Guarded by the `static-regression-scan` "no direct
draft_versions read" scan.

### 2. Exact MIME bytes are persisted before SMTP and reused on restart

The send executor builds the outbound MIME **once** (pinned date), hashes it
(`sha256` + length), and — while the attempt is still `claimed` — calls
`transport.create_or_verify_send_mime_artifact(...)`, which re-hashes the
supplied bytes and verifies the exact size, the attempt/intent/workspace/
message-id chain, and the 25 MiB bound. The worker has **no** direct INSERT; the
DEFINER function is the only creator. The `claimed -> smtp_in_progress`
transition is refused by the DB trigger `trg_send_attempts_require_mime_before_smtp`
(SQLSTATE `23514`) unless a valid retained artifact already exists — so **SMTP
can never begin without durably persisted bytes**. The restart /
`reconcileSentCopy` path loads the stored artifact (`getBySendAttempt`), verifies
size/sha/message-id, and appends the EXACT stored `rawMime` — it never rebuilds
MIME and never re-submits over SMTP. Guarded by `static-regression-scan`
("DEFINER-only artifact table", "reconcile reuses stored bytes") and
`contract:verify` 8b/8c.

### 3. IMAP and SMTP endpoint validation are separate

`src/workers/provider-factory.ts` splits `requireSecureImapEndpoint` (used only
by `createImapSession`) from `requireSecureSmtpEndpoint` (used only by
`createSubmission`). A `none`/null security setting fails closed
(`config_invalid`); plaintext is refused; worker-only credential decryption and
buffer zeroing are preserved. This complements ADR 0008: a read-only capability
slice validates only IMAP and never constructs the SMTP client.

## Consequences

- All prior send-safety rules hold: `send_message.retryLimit = 0`; the atomic
  claim plus explicit state machine; `smtp_in_progress` restart →
  `needs_human_review`; content-free evidence only.
- No migration is authored here — the v2 schema is owned by the UI repo and
  pinned by the lock; this ADR records the **worker-side** integration only.
- Production remains unchanged: the v2 migrations live in the reviewed canonical
  chain and have **not** been applied to any production target; all Phase 2/3
  feature flags remain disabled by default.
