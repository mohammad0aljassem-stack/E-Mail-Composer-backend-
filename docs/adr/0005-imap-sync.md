# ADR 0005 — IMAP synchronization + UIDVALIDITY

## Status: accepted (Phase 3A)

## Context

IMAP sync must be crash-safe, duplicate-free, and correct across UIDVALIDITY
changes, storing **metadata only** (never bodies).

## Decision (`src/workers/sync-executor.ts`)

- **Identity** is `(folder, uidvalidity, uid)`. Upserts are deterministic
  (`ON CONFLICT (folder_id, uidvalidity, uid)`), so repeated/duplicate jobs and
  restarts never create duplicate rows.
- **Cursor after durability.** Messages are persisted first; the folder cursor
  (`uidvalidity/uidnext/last_seen_uid/highest_modseq`) is advanced **only after**
  durable persistence. A crash between persistence and cursor update simply
  re-fetches idempotently.
- **Initial vs incremental.** Initial discovers folders/roles and syncs bounded
  batches; incremental fetches only UIDs `> last_seen_uid`. A full batch signals
  a follow-up.
- **UIDVALIDITY change** is detected explicitly (server value differs from the
  cursor). The old UID cursor is invalidated (`last_seen_uid = 0`), new UIDs are
  **never mixed into the old namespace**, an audit event is written, and a
  controlled resync is signalled. **No message row is silently deleted** —
  auditability is preserved; the resync repopulates under the new namespace.
- **IDLE** is a wake-up signal only → enqueue an incremental sync; a bounded
  periodic fallback covers missed notifications. IMAP is **never** performed in a
  browser request — a manual refresh enqueues a (deduplicated) sync job.
- **Metadata only.** Only envelope/flags/size/threading-headers are stored; no
  body or content is fetched, retained, or logged.

## Consequences

The stored `remote_uid` for a draft mirror is namespaced by its
`remote_uidvalidity`; a UIDVALIDITY change invalidates it and a controlled
re-mirror follows. See ADR 0003 for the send/Sent-copy Message-ID reconciliation
that complements sync.
