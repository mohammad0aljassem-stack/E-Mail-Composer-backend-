# Phase 3B — controlled-integration runbook (IONOS test mailbox)

This runbook governs the **first** contact with real IMAP/SMTP, against a
**dedicated non-production IONOS test mailbox only**. It complements
[phase-3b-checklist.md](phase-3b-checklist.md) (the exercise checklist) and
[runbook.md](runbook.md) (day-to-day operations). No step in this document may
be performed without the explicit authorization named at its gate.

**No production identifiers or secrets appear in this document.** Every
concrete value (project ref, hostnames, mailbox address, credentials) is
supplied at gate time by the authorizing operator, through the approved
secrets store — never committed, never logged.

## Approval gates

Eight **separate** gates. Each requires its **own explicit authorization**,
recorded before the gate's work begins. Gates are **never combined**, never
pre-approved in bulk, and a later gate never implies an earlier one.

### Gate A — readiness (code + runbook only)

Authorizes **nothing operational**. Confirms:

- All CI gates green on the release commit (format, lint, typecheck, unit,
  coverage, build, `contract:verify`, integration, audit, license, secret
  scan).
- This runbook reviewed and current.
- No production migration applied, no flag enabled anywhere (the safe default).

### Gate B — named non-production infrastructure

Authorization must name, exactly:

- The **exact Supabase project** (non-production; verified against the
  provisioning CLI denylist — see operational notes).
- The **worker runtime environment** (host/cluster, region) and its
  **deployment identity** (who deploys, with which account).
- **Backup / PITR** confirmed enabled on the target database.
- The **migration target** (the database the canonical migrations will be
  applied to at Gate C).

### Gate C — database change

Authorization must name, exactly:

- The **exact migration list with checksums**, read from the canonical UI
  manifest (`supabase/contracts/phase3-transport-contract.json`) — never
  hand-copied. `pnpm contract:verify` must pass against the checkout being
  applied.
- Role creation (`transport_worker`) and the **exact grants** (including the
  `phase3_send_attempt_transition_ok` EXECUTE grant — see
  [runbook.md](runbook.md)).
- The **expected schema diff** (reviewed) and the **rollback method** for this
  database change.

**Production state fact:** the canonical migrations are **NOT applied to
production**. Gate C is where that decision would be made, explicitly, and it
is out of scope for Phase 3B (which targets the named non-production instance
from Gate B only).

### Gate D — secret provisioning

Authorization must name, exactly:

- The **encryption-key destination** (which secrets store holds
  `CREDENTIAL_KEYRING`, which environment reads it).
- The **mailbox-credential destination** (`transport.mailbox_credentials`,
  ciphertext only, via the test-only provisioning CLI).
- The **rotation and deletion procedure** for both (see rollback section).
- The **permitted operators** (named individuals) allowed to handle either.

### Gate E — named mailbox

Authorization must name, exactly:

- The **exact IONOS test mailbox** (address supplied at gate time; a dedicated
  non-production mailbox with no real user mail).
- Whether the mailbox is **synthetic-data-only** (expected: yes).
- The **allowed folders** the worker may touch.
- The **allowed sender and recipients** for any send test.
- The **maximum message count** for the exercise and the **retention** of
  anything created (when and how test messages are removed).

### Gate F — first synchronization (read-only IMAP)

Authorization must name, exactly:

- Confirmation the exercise is **read-only IMAP** (discovery + metadata fetch;
  no send, no mutation, no append).
- The **expected folder/message scope** (which folders, roughly how many
  messages).
- **Success criteria** (folders discovered with roles incl. the localized Sent
  folder, metadata-only rows, correct cursor, idempotent re-run) and **abort
  criteria** (anything unexpected → engage the kill switch, stop, review).

### Gate G — first send (ONE message)

Authorization must name, exactly:

- The **exact user-controlled recipient** (an address the operator owns).
- The **exact subject marker** and the **exact body**.
- **Zero attachments** unless separately and explicitly approved.
- **ONE message** total, from one confirmed `send_intent`.
- A **human confirmation** step immediately before enqueue.
- Verification: `smtp_accepted` with the SMTP response recorded, the recipient
  received exactly one copy, and the **Sent folder** holds one copy with the
  same Message-ID.
- **Single-recipient only** for this first send (see operational notes).

### Gate H — failure drill

Authorization must name, exactly:

- The **exact synthetic failure** to inject (e.g. a disconnect during/after
  DATA against the test mailbox).
- **Proof of no duplicate**: the attempt is never auto-resent; SMTP submission
  count stays at its pre-drill value.
- **Proof of `needs_human_review`**: the attempt lands in
  `needs_human_review` with Message-ID + content-free evidence preserved.
- **Cleanup**: how the drill's artifacts (test messages, attempt rows left in
  review) are resolved and recorded.

## Operational notes

- **Single-recipient-only for the first send.** Partial RCPT rejection on a
  multi-recipient send is surfaced to `needs_human_review` (counts only, never
  addresses) — correct, but not something the first controlled send should
  exercise. One recipient removes the case entirely.
- **Stale send-claim expiry is automatic**: the sync-request dispatcher expires
  expired `transport.worker_claims` leases once per pass and logs a
  content-free `stale_send_claims_expired {count}`. Expiry only removes the
  lease row — the attempt still requires its normal claim + state flow, and a
  restart from `smtp_in_progress` still goes to `needs_human_review`. Manual
  SQL fallback (operator, audited):

  ```sql
  delete from transport.worker_claims where lease_until < now();
  ```

- **Kill-switch env hygiene**: boolean env parsing is strict
  (`1|true|0|false` only); `TRANSPORT_GLOBAL_KILL_SWITCH=yes` no longer parses
  silently to DISENGAGED — the worker refuses to start.
- **Flags are read at worker startup**: changing
  `MAIL_TRANSPORT_V1_ENABLED` or `TRANSPORT_GLOBAL_KILL_SWITCH` requires a
  **worker restart** to take effect.
- **Mailbox flags are live per-job**: `public.mailboxes.enabled` and
  `kill_switch` are re-read on every job — flipping them takes effect without
  a restart.
- **Provisioning CLI denylist caveat**: the test-only credential CLI refuses
  Supabase-shaped production targets (the production project ref and hosted
  `*.supabase.co` / pooler URLs). It is a tripwire, not a guarantee — the
  operator must still point `DATABASE_URL` at the Gate-B instance.
- **Queue depth** (operator SQL against the pg-boss schema):

  ```sql
  select name, state, count(*)
    from pgboss.job
   group by name, state
   order by name, state;
  ```

- **Manual credential rotation** (single transaction; the one-active partial
  unique index on `transport.mailbox_credentials` enforces that at most one
  active credential exists per mailbox):

  ```sql
  begin;
    update transport.mailbox_credentials
       set revoked_at = now()
     where mailbox_id = '<mailbox-uuid>' and revoked_at is null;
    -- insert the NEW ciphertext row via the provisioning CLI / an equivalent
    -- audited INSERT (ciphertext, nonce, auth_tag, algorithm, key_version, aad).
  commit;
  ```

- **Production state fact** (repeated deliberately): the canonical migrations
  are **not applied to production**; Gate C is the only place that decision
  happens, and Phase 3B does not include it.

## Rollback (D3)

Rollback never requires deleting audit evidence, and **must not** delete it.

1. **Disable the global transport flag**: set
   `MAIL_TRANSPORT_V1_ENABLED=false`. Flags are read at startup → a **worker
   restart is required**. With the flag off the worker registers no handlers,
   opens no mail connection, decrypts nothing.
2. **Disable per-mailbox** (live, no restart): set
   `public.mailboxes.enabled=false` and/or `kill_switch=true` for the test
   mailbox. Every job re-checks these before touching the provider.
3. **Stop the worker**: `SIGTERM` performs a graceful shutdown — stops the
   dispatch timer, pg-boss graceful stop, a final heartbeat, then `db.end()`.
   There are **no persistent IDLE sessions** to tear down: connections are
   per-job and closed in `finally`.
4. **Prevent new claims**: any of flag off / global kill switch / per-mailbox
   kill switch / worker stop prevents new send claims and new sync dispatch.
5. **Preserve DB evidence**: `transport_audit` is append-only and is **never
   deleted** (the worker cannot delete it — it holds SELECT+INSERT only…
   INSERT only, in fact, for audit). Confirmed `send_intents` remain intact.
   Ambiguous attempts **stay in `needs_human_review`, untouched — never
   auto-resent**.
6. **Credential revocation**: flip `revoked_at = now()` on the active
   `transport.mailbox_credentials` row (optionally rotate the key version via
   `CREDENTIAL_KEYRING`'s additive versions and re-provision). The worker then
   fails closed with `credential_missing`.
7. **Worker DB access removal** happens only via an authorized
   migration/provisioning step (role/grant changes are Gate-C-class changes) —
   never an ad-hoc statement.
8. **What rollback cannot do**: an application rollback **cannot roll back
   delivered mail**. An SMTP-accepted message is irreversible — which is
   exactly WHY ambiguous outcomes stop for human review instead of retrying.

## Exit

Phase 3B ends with the worker stopped or flag-off, evidence archived
(content-free logs + audit rows), the test mailbox cleaned per Gate E's
retention, and production untouched: no production migration, no production
flag, no production credential.
