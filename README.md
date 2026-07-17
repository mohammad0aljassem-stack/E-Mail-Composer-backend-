# E-Mail Composer — Transport Worker (Phase 3A)

A production-quality, **fully locally-testable** foundation for the IMAP/SMTP
transport worker. This repository owns the **backend worker**; the canonical
database schema and all deployable migrations are owned by the sibling UI repo
(`E-Mail-Composer-UI`, merged commit `4bca2fc927c552f6466d9e8124e9b07c9770d1c1`).

The backend is pinned to that contract by a **single source of truth**:
[`config/canonical-transport-contract.lock.json`](config/canonical-transport-contract.lock.json)
records the UI commit SHA, the manifest path, the manifest `sha256`, and the
supported schema/contract versions. The migration checksums themselves live in
the UI's machine-readable manifest
(`supabase/contracts/phase3-transport-contract.json`) — never hand-copied here.
A single fail-closed command, **`pnpm contract:verify`**, is used identically
locally and in CI: it asserts the checked-out UI SHA equals the lock, the
manifest hash + versions match, every listed migration's on-disk checksum
matches the manifest, and the worker privilege / queue / feature-flag boundaries
and static regression scans hold. See
[docs/adr/0007-canonical-contract-lock.md](docs/adr/0007-canonical-contract-lock.md).

> **Production remains DISABLED.** `MAIL_TRANSPORT_V1_ENABLED` defaults `false`.
> With the flag off the worker starts NO IMAP/SMTP connection, runs NO send
> worker, and decrypts NO credential — it reports health `transport-disabled`.
> Phase 2 readiness remains a **separate gate**; this PR does not touch it.
> See [docs/production-non-deployment.md](docs/production-non-deployment.md).

## What this is

- A versioned, provider-agnostic **MailProvider** contract with an IONOS-style
  IMAP+SMTP implementation (ImapFlow / Nodemailer / mailparser).
- An **AES-256-GCM credential cipher** (versioned keyring, AAD-bound to
  workspace+mailbox, constant-shape errors, no secret logging).
- Least-privileged **repositories** over the canonical transport schema, run as
  the `transport_worker` role.
- **pg-boss** queues with exact policies — including `send_message` with
  **zero automatic retries**.
- A **safe-send state machine** implementing exactly-once _intent_ (never
  blind-retry _delivery_), with an immutable confirmed snapshot, atomic claims,
  and human review for ambiguous outcomes.
- IMAP **sync** (UID/UIDVALIDITY-aware), **draft mirror**, inbound **MIME
  safety**, content-free **observability**, health/readiness, graceful shutdown.
- In-repo **fake IMAP + fake SMTP** protocol servers so the whole system is
  testable with **no network** (the container registry is blocked, so this — not
  testcontainers — is where integration coverage lives).

## Layout

```
src/
  config/         env validation (fail-closed) + the feature flag
  crypto/         CredentialCipher contract + AES-256-GCM implementation
  db/             pg pool, repositories, repository interfaces (ports)
  domain/         errors, clock, ids, send-state machine, models, confirmation-proof
  providers/      MailProvider contract + imap-smtp/ (ImapFlow/Nodemailer adapters)
  queues/         pg-boss families + policies + typed enqueue
  workers/        send / sync / draft-mirror / mutation executors + provider factory
  mime/           inbound streaming parser (safety limits) + outbound builder/hashing
  observability/  content-free structured logger + heartbeat
  health/         health + readiness
  entrypoints/    worker main + TEST-ONLY provisioning CLI
test/
  fakes/          fake IMAP server + client, fake SMTP, in-memory repos
  unit/           deterministic unit tests (coverage-gated)
  integration/    real local Postgres + pg-boss + fakes
scripts/          test-db.sh, license-check.mjs, secret-scan.sh
docs/             ADRs, runbook, security review, Phase 3B checklist, env reference
```

## Local development

```bash
pnpm install

# Fast, no-DB checks
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test            # unit tests
pnpm test:coverage   # unit tests + coverage thresholds
pnpm build           # emit dist/

# Canonical-contract compatibility gate (single fail-closed command).
# Point UI_REPO at the sibling UI checkout pinned to the lock's uiCommitSha
# (defaults to ./ui-schema, then /home/user/E-Mail-Composer-UI).
UI_REPO=/home/user/E-Mail-Composer-UI pnpm contract:verify

# Integration (real local Postgres + pg-boss + fakes)
bash scripts/test-db.sh --print      # start throwaway PG16, load canonical schema
export TEST_DATABASE_URL=postgresql://postgres@localhost:54330/transport_test
export TEST_WORKER_DATABASE_URL=postgresql://transport_worker:worker_test_pw@localhost:54330/transport_test
pnpm test:integration
bash scripts/test-db.sh --stop       # tear down

# Policy gates
pnpm run license:check
pnpm run secret:scan
pnpm audit --prod --audit-level high
```

`scripts/test-db.sh` is **test-only and non-deployable**: it loads the sibling
repo's baseline + the FULL five-migration chain into a throwaway cluster and
creates a local `transport_worker` login (login + connect only). It does not own
migrations, and it injects **no** privilege grants — the canonical
worker-transition grant migration (20260715100000) already gives the worker role
the one `EXECUTE` it needs to advance the send state machine, so integration
tests run under the real least-privilege role with nothing added.

## Key safety properties

- **Exactly-once INTENT, not exactly-once delivery.** SMTP cannot promise
  exactly-once delivery. We make the _decision to send_ exactly-once (immutable
  `send_intents` snapshot + unique idempotency key + atomic claim) and **never
  auto-retry a delivery**. See [docs/adr/0003-safe-send.md](docs/adr/0003-safe-send.md).
- **`send_message` has zero queue retries** (`retryLimit === 0`), asserted in
  both a unit test and a real-pg-boss integration test.
- **Ambiguous SMTP outcomes → `needs_human_review`**, never an auto-resend; the
  Message-ID and evidence are preserved.
- **Pre-DATA failures → `failed_before_delivery`** (nothing was sent), no retry.
- **A restart while `smtp_in_progress` never auto-sends** → human review.
- **After acceptance, only Sent-copy reconciliation happens** (by Message-ID
  search), never another SMTP submission.
- **Content-free logging**: no passwords, bodies, attachment bytes, raw MIME,
  auth headers, connection strings, or keys ever reach the logs.
- **Worker-only decryption**: credentials are decrypted only inside the worker,
  only when the flag is on, bound by AAD to their workspace+mailbox.

## Documentation

| Doc                                                                                  | Purpose                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------- |
| [docs/env-reference.md](docs/env-reference.md)                                       | Every environment variable                  |
| [docs/runbook.md](docs/runbook.md)                                                   | Operating the worker + provisioning         |
| [docs/adr/0001-mail-provider.md](docs/adr/0001-mail-provider.md)                     | MailProvider contract                       |
| [docs/adr/0002-queues.md](docs/adr/0002-queues.md)                                   | pg-boss families + policies                 |
| [docs/adr/0003-safe-send.md](docs/adr/0003-safe-send.md)                             | Safe-send state machine                     |
| [docs/adr/0004-credential-encryption.md](docs/adr/0004-credential-encryption.md)     | Credential cipher                           |
| [docs/adr/0005-imap-sync.md](docs/adr/0005-imap-sync.md)                             | IMAP sync + UIDVALIDITY                     |
| [docs/adr/0006-durable-sync-requests.md](docs/adr/0006-durable-sync-requests.md)     | Durable claimable sync requests             |
| [docs/adr/0007-canonical-contract-lock.md](docs/adr/0007-canonical-contract-lock.md) | Canonical contract lock + `contract:verify` |
| [docs/testing-and-failure-injection.md](docs/testing-and-failure-injection.md)       | Test map + fakes                            |
| [docs/security-review.md](docs/security-review.md)                                   | Phase 3A security review                    |
| [docs/phase-3b-checklist.md](docs/phase-3b-checklist.md)                             | Controlled-IONOS rollout                    |
| [docs/production-non-deployment.md](docs/production-non-deployment.md)               | Why prod stays off                          |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)                                     | Dependency licenses                         |
