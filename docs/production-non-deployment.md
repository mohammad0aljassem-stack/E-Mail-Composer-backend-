# Production non-deployment statement

**This repository does not deploy anything to production, and Phase 3A does not
enable transport in production.**

- `MAIL_TRANSPORT_V1_ENABLED` defaults to `false`. With the flag off the worker
  opens no IMAP/SMTP connection, starts no send worker, and decrypts no
  credential; it reports health `transport-disabled`.
- `scripts/test-db.sh` is **test-only and non-deployable**. It loads the sibling
  UI repo's baseline + three migrations into a **throwaway** local Postgres and
  creates a **local** `transport_worker` login (plus one test-only grant).
  It does **not** own or ship migrations — the sibling UI repo
  (`E-Mail-Composer-UI`, merged `67daad9`) is the single owner. It never touches
  a hosted database.
- The provisioning CLI is test-only and **refuses** production references
  (project ref `fpanvpxjjddhasjmpflz`, `*.supabase.co`). It encrypts only
  synthetic credentials and writes only ciphertext.
- CI **builds and tests**; it is not a scheduler or runtime and performs no
  deploy.
- Production provisioning of the `transport_worker` role (login, connect,
  `phase3_send_attempt_transition_ok` EXECUTE grant) and the AES keyring is a
  **separate, manual, audited operation** (see the runbook), not performed here.

## Gating

- Enabling transport in production is a **later, explicit decision**, taken only
  after the Phase 3B controlled-IONOS rollout ([phase-3b-checklist.md](phase-3b-checklist.md))
  succeeds against a dedicated non-production mailbox.
- **Phase 2 readiness remains a separate gate** and is unaffected by this PR.

The migration this worker is built against is pinned by checksum
`a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a` (UI PR merged
at `67daad9`); a mismatch fails `scripts/test-db.sh` and CI.
