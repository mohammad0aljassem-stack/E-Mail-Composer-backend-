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
  `4bca2fc927c552f6466d9e8124e9b07c9770d1c1`) is the single owner. The expected
  UI SHA and the migration checksums it enforces are read from
  `config/canonical-transport-contract.lock.json` + the UI manifest, never
  hand-copied. It never touches a hosted database.
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
`4bca2fc927c552f6466d9e8124e9b07c9770d1c1` via
`config/canonical-transport-contract.lock.json`, and the three Phase 3 migration
checksums are enforced against the UI's machine-readable manifest
(`supabase/contracts/phase3-transport-contract.json`). Any mismatch — a wrong UI
SHA, a changed manifest hash, a drifted migration checksum, or a missing
hardening/grant migration — fails `pnpm contract:verify`, `scripts/test-db.sh`,
and CI closed.
