# Production non-deployment statement

**This repository does not deploy anything to production, and Phase 3A does not
enable transport in production.**

- `MAIL_TRANSPORT_V1_ENABLED` defaults to `false`. With the flag off the worker
  opens no IMAP/SMTP connection, starts no send worker, and decrypts no
  credential; it reports health `transport-disabled`.
- `scripts/test-db.sh` is **test-only and non-deployable**. It loads the sibling
  UI repo's baseline + the FULL five-migration chain into a **throwaway** local
  Postgres and creates a **local** `transport_worker` login (login + connect
  only, **no injected grants**). It does **not** own or ship migrations — the
  sibling UI repo (`E-Mail-Composer-UI`, merged
  `422485af44fa4606a7c0dbee798a9866b3fd0d8e`) is the single owner. It never
  touches a hosted database.
- The provisioning CLI is test-only and **refuses** production references
  (project ref `fpanvpxjjddhasjmpflz`, `*.supabase.co`). It encrypts only
  synthetic credentials and writes only ciphertext.
- CI **builds and tests**; it is not a scheduler or runtime and performs no
  deploy.
- Production provisioning of the `transport_worker` role (login, connect) and
  the AES keyring is a **separate, manual, audited operation** (see the runbook),
  not performed here. The `phase3_send_attempt_transition_ok` EXECUTE privilege
  the worker needs is now part of the **canonical** schema (migration
  20260715100000), so it is no longer an out-of-band provisioning step.

## Gating

- Enabling transport in production is a **later, explicit decision**, taken only
  after the Phase 3B controlled-IONOS rollout ([phase-3b-checklist.md](phase-3b-checklist.md))
  succeeds against a dedicated non-production mailbox.
- **Phase 2 readiness remains a separate gate** and is unaffected by this PR.

The schema this worker is built against is pinned to UI SHA
`422485af44fa4606a7c0dbee798a9866b3fd0d8e` and the three Phase 3 migration
checksums (foundation
`a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a`, hardening
`ee064f0b50d01897b8247a10edefc95bd0088862e3731693b19da7c851253977`, grant
`ca15b9de01894ef784fad57f991a052e2da1fcdca435cc1a78463af34b3c0dba`); any
mismatch — or a missing hardening/grant migration — fails `scripts/test-db.sh`
and CI closed.
