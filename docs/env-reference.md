# Environment variable reference

The worker validates configuration at startup via `src/config/env.ts` and
**fails closed** on anything invalid. No value is ever logged.

| Variable                                          | Default        | Required       | Meaning                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_TRANSPORT_V1_ENABLED`                       | `false`        | no             | Master feature flag. When `false`: no IMAP/SMTP connection, no send worker, no decryption; health = `transport-disabled`.                                                                                         |
| `MAIL_SYNC_ENABLED`                               | `false`        | no             | Sub-capability (C2): registers the `sync_mailbox` handler + the durable sync-request dispatcher. Effective only when the master flag is also `true`; masked to `false` otherwise (fail-closed, no startup error). |
| `MAIL_IDLE_ENABLED`                               | `false`        | no             | Sub-capability (C7): constructs the IDLE + fallback coordinator. Effective only when master **and** `MAIL_SYNC_ENABLED` are `true` (a wake-up is only ever converted into a sync job).                            |
| `MAIL_DRAFT_MIRROR_ENABLED`                       | `false`        | no             | Sub-capability (C6): registers the IMAP-only `draft_mirror` handler. Effectively also requires the `draft_versions` grant prerequisite (see the runbook, Gate C/G).                                               |
| `MAIL_MUTATIONS_ENABLED`                          | `false`        | no             | Sub-capability (C2): registers the `apply_mutation` handler (flags/move; IMAP-only).                                                                                                                              |
| `MAIL_SEND_ENABLED`                               | `false`        | no             | Sub-capability (C2): registers the `send_message` handler — the ONLY code path that can construct an SMTP client.                                                                                                 |
| `DATABASE_URL`                                    | —              | **yes**        | Least-privileged `transport_worker` connection string. Never production.                                                                                                                                          |
| `PGBOSS_SCHEMA`                                   | `pgboss`       | no             | Schema that isolates the pg-boss queue tables.                                                                                                                                                                    |
| `CREDENTIAL_KEYRING`                              | —              | yes if flag on | `version:base64Key[,version:base64Key]`. Each key MUST decode to exactly 32 bytes (AES-256).                                                                                                                      |
| `CREDENTIAL_ACTIVE_KEY_VERSION`                   | `1`            | no             | Key version new ciphertext is written with; must exist in the keyring when the flag is on.                                                                                                                        |
| `WORKER_ID`                                       | `worker-<pid>` | no             | Opaque, stable worker instance id (claims + heartbeats).                                                                                                                                                          |
| `TRANSPORT_GLOBAL_KILL_SWITCH`                    | `false`        | no             | When `true`, the worker performs NO delivery at all.                                                                                                                                                              |
| `LOG_LEVEL`                                       | `info`         | no             | `debug` \| `info` \| `warn` \| `error`.                                                                                                                                                                           |
| `HEARTBEAT_INTERVAL_MS`                           | `15000`        | no             | Liveness heartbeat interval.                                                                                                                                                                                      |
| `CLAIM_LEASE_MS`                                  | `60000`        | no             | Send-claim lease duration.                                                                                                                                                                                        |
| `SMTP_TIMEOUT_MS`                                 | `30000`        | no             | SMTP connect/greeting/socket timeout.                                                                                                                                                                             |
| `IMAP_COMMAND_TIMEOUT_MS`                         | `30000`        | no             | IMAP greeting/socket timeout.                                                                                                                                                                                     |
| `SYNC_DISPATCH_INTERVAL_MS`                       | `5000`         | no             | Durable `transport.sync_requests` dispatcher poll interval (see ADR 0006).                                                                                                                                        |
| `SYNC_CLAIM_LEASE_MS`                             | `300000`       | no             | Durable sync-request stale-claim lease; a `claimed` row older than this is reclaimable.                                                                                                                           |
| `SYNC_CLAIM_BATCH_SIZE`                           | `10`           | no             | Max durable sync-requests claimed per dispatch pass.                                                                                                                                                              |
| `SYNC_MAX_ATTEMPTS`                               | `5`            | no             | Hard cap on durable re-claims before a stale sync-request is failed.                                                                                                                                              |
| `SYNC_MAX_BATCHES_PER_JOB`                        | `10`           | no             | Max executor batches inside ONE `sync_mailbox` job before a cursor-keyed continuation job is enqueued (bounds job runtime; see ADR 0006/0008).                                                                    |
| `IDLE_TIMEOUT_MS`                                 | `300000`       | no             | IDLE wait bound per cycle. A silent window enqueues ONE deduped fallback incremental sync (worker-internal; never external cron).                                                                                 |
| `IDLE_BACKOFF_MIN_MS`                             | `5000`         | no             | IDLE reconnect backoff floor (pre-jitter base; ±50% jitter applied).                                                                                                                                              |
| `IDLE_BACKOFF_MAX_MS`                             | `300000`       | no             | IDLE reconnect backoff cap. Must be `>= IDLE_BACKOFF_MIN_MS` or the worker refuses to start.                                                                                                                      |
| `IDLE_RESCAN_MS`                                  | `60000`        | no             | IDLE mailbox-list rescan interval (adopts new mailboxes, drops disabled ones).                                                                                                                                    |
| `IDLE_MAX_SESSIONS`                               | `10`           | no             | Global cap on concurrent IDLE sessions; adoption is round-robin by workspace so one workspace cannot monopolize the budget.                                                                                       |
| `PROVISION_WORKSPACE_ID` / `PROVISION_MAILBOX_ID` | —              | CLI only       | Used by the test-only provisioning CLI.                                                                                                                                                                           |

## Tooling-only variables (never read by the worker runtime)

| Variable                   | Default                                             | Used by                                      | Meaning                                                                                                    |
| -------------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `UI_REPO`                  | `./ui-schema`, then `/home/user/E-Mail-Composer-UI` | `pnpm contract:verify`, `scripts/test-db.sh` | Path to the sibling UI checkout pinned to `config/canonical-transport-contract.lock.json` → `uiCommitSha`. |
| `TEST_DATABASE_URL`        | —                                                   | integration tests                            | Superuser URL for the throwaway local Postgres (seeding + pg-boss).                                        |
| `TEST_WORKER_DATABASE_URL` | —                                                   | integration tests                            | Least-privileged `transport_worker` login URL for the privilege-proof tests.                               |

`pnpm contract:verify` is the single fail-closed compatibility gate between this
backend and the canonical transport contract (see
[docs/adr/0007-canonical-contract-lock.md](adr/0007-canonical-contract-lock.md)).
It reads the pin from the backend lock and the migration checksums from the UI
manifest — no value here is a secret and none is ever logged.

## IONOS example values (examples only)

> **Examples only.** IMAP/SMTP endpoints are **configured per mailbox row**
> (`public.mailboxes.imap_host/imap_port/imap_security/smtp_host/smtp_port/smtp_security`)
> and are **never hard-coded** in this repository. These are the typical
> IONOS-shaped values an operator would enter for a controlled test mailbox —
> substitute the values from the provider's own documentation for the actual
> account:

| Protocol | Host (example)   | Port | Security                    |
| -------- | ---------------- | ---- | --------------------------- |
| IMAP     | `imap.ionos.tld` | 993  | `ssl` (implicit TLS)        |
| SMTP     | `smtp.ionos.tld` | 465  | `ssl` (implicit TLS)        |
| SMTP     | `smtp.ionos.tld` | 587  | `starttls` (upgrade to TLS) |

The provider factory **refuses** `imap_security`/`smtp_security` of `none` (or
unset): a plaintext session is never built. IMAP `starttls` currently maps to
implicit TLS (`secure=true`) — fail-closed, never plaintext.

## Fail-closed rules

- Missing `DATABASE_URL` → refuse to start.
- Boolean flags (`MAIL_TRANSPORT_V1_ENABLED`, every `MAIL_*_ENABLED`
  sub-capability flag, `TRANSPORT_GLOBAL_KILL_SWITCH`) accept **exactly**
  `1`/`true`/`0`/`false`; anything else (`yes`, `on`, `TRUE `, typos) →
  refuse to start. A kill switch can never be silently disengaged by an
  unrecognized token.
- Sub-capability flags are **masked by the master flag**: a sub-flag set
  `true` with `MAIL_TRANSPORT_V1_ENABLED=false` is effectively `false`
  (no startup error; the startup log surfaces the effective matrix).
  `MAIL_IDLE_ENABLED` additionally requires `MAIL_SYNC_ENABLED`.
- The capability flags are **backend runtime controls** — deliberately NOT
  part of the UI schema manifest. `pnpm contract:verify` check 12b proves
  every `MAIL_*_ENABLED` flag exists, is parsed by the strict parser, and
  defaults to the literal `false`.
- Flag on but no keyring, a non-32-byte key, or an active version absent from
  the keyring → refuse to start.
- Invalid `LOG_LEVEL`, a non-positive numeric setting, or
  `IDLE_BACKOFF_MAX_MS < IDLE_BACKOFF_MIN_MS` → refuse to start.
- Every flag defaults `false`, so the safe state is the default; grants and
  worker startup rules are safe **independent of the flags**.
