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
| `PROVISION_WORKSPACE_ID` / `PROVISION_MAILBOX_ID` | —              | CLI only       | Used by the test-only provisioning CLI.                                                                                   |

## Fail-closed rules

- Missing `DATABASE_URL` → refuse to start.
- Flag on but no keyring, a non-32-byte key, or an active version absent from
  the keyring → refuse to start.
- Invalid `LOG_LEVEL` or non-positive numeric setting → refuse to start.
- The flag defaults `false`, so the safe state is the default; grants and worker
  startup rules are safe **independent of the flag**.
