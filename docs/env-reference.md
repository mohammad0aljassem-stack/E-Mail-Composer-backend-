# Environment variable reference

The worker validates configuration at startup via `src/config/env.ts` and
**fails closed** on anything invalid. No value is ever logged.

| Variable                                          | Default        | Required       | Meaning                                                                                                                   |
| ------------------------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_TRANSPORT_V1_ENABLED`                       | `false`        | no             | Master feature flag. When `false`: no IMAP/SMTP connection, no send worker, no decryption; health = `transport-disabled`. |
| `DATABASE_URL`                                    | —              | **yes**        | Least-privileged `transport_worker` connection string. Never production.                                                  |
| `PGBOSS_SCHEMA`                                   | `pgboss`       | no             | Schema that isolates the pg-boss queue tables.                                                                            |
| `CREDENTIAL_KEYRING`                              | —              | yes if flag on | `version:base64Key[,version:base64Key]`. Each key MUST decode to exactly 32 bytes (AES-256).                              |
| `CREDENTIAL_ACTIVE_KEY_VERSION`                   | `1`            | no             | Key version new ciphertext is written with; must exist in the keyring when the flag is on.                                |
| `WORKER_ID`                                       | `worker-<pid>` | no             | Opaque, stable worker instance id (claims + heartbeats).                                                                  |
| `TRANSPORT_GLOBAL_KILL_SWITCH`                    | `false`        | no             | When `true`, the worker performs NO delivery at all.                                                                      |
| `LOG_LEVEL`                                       | `info`         | no             | `debug` \| `info` \| `warn` \| `error`.                                                                                   |
| `HEARTBEAT_INTERVAL_MS`                           | `15000`        | no             | Liveness heartbeat interval.                                                                                              |
| `CLAIM_LEASE_MS`                                  | `60000`        | no             | Send-claim lease duration.                                                                                                |
| `SMTP_TIMEOUT_MS`                                 | `30000`        | no             | SMTP connect/greeting/socket timeout.                                                                                     |
| `IMAP_COMMAND_TIMEOUT_MS`                         | `30000`        | no             | IMAP greeting/socket timeout.                                                                                             |
| `SYNC_DISPATCH_INTERVAL_MS`                       | `5000`         | no             | Durable `transport.sync_requests` dispatcher poll interval (see ADR 0006).                                                |
| `SYNC_CLAIM_LEASE_MS`                             | `300000`       | no             | Durable sync-request stale-claim lease; a `claimed` row older than this is reclaimable.                                   |
| `SYNC_CLAIM_BATCH_SIZE`                           | `10`           | no             | Max durable sync-requests claimed per dispatch pass.                                                                      |
| `SYNC_MAX_ATTEMPTS`                               | `5`            | no             | Hard cap on durable re-claims before a stale sync-request is failed.                                                      |
| `PROVISION_WORKSPACE_ID` / `PROVISION_MAILBOX_ID` | —              | CLI only       | Used by the test-only provisioning CLI.                                                                                   |

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

## Fail-closed rules

- Missing `DATABASE_URL` → refuse to start.
- Flag on but no keyring, a non-32-byte key, or an active version absent from
  the keyring → refuse to start.
- Invalid `LOG_LEVEL` or non-positive numeric setting → refuse to start.
- The flag defaults `false`, so the safe state is the default; grants and worker
  startup rules are safe **independent of the flag**.
