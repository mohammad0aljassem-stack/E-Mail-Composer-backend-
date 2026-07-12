# Transport worker runbook

## Starting / stopping

- Start: `pnpm start` (built) or `pnpm worker` (tsx). Reads `.env` (see
  [env-reference.md](env-reference.md)).
- With `MAIL_TRANSPORT_V1_ENABLED=false` the worker connects to Postgres +
  pg-boss only to report health `transport-disabled`; it registers **no work
  handlers** and opens **no mail connections**.
- Graceful shutdown: `SIGTERM`/`SIGINT` stop taking new work, flush a final
  heartbeat, and close pools. In-flight SMTP is bounded by `SMTP_TIMEOUT_MS`;
  a crash mid-`smtp_in_progress` is recovered by human review, never auto-send.

## Kill switches

- **Global**: `TRANSPORT_GLOBAL_KILL_SWITCH=true` → no delivery at all.
- **Per-mailbox**: `public.mailboxes.kill_switch = true` and/or
  `enabled = false`. The send path aborts **before** claiming the attempt, so
  the send can be re-driven after the switch is lifted (no state is consumed).

## Health

`checkHealth` reports one of: `transport-disabled` (flag off), `healthy-active`
(flag on, DB reachable, no global kill), `degraded` (global kill engaged),
`unhealthy` (flag on, DB unreachable). Never confuse `transport-disabled` with
a healthy active worker.

## Worker-role provisioning (PRODUCTION — manual, audited)

The canonical migration creates `transport_worker` as `nologin noinherit
bypassrls` and grants it a narrow DML surface. Production provisioning is a
**separate manual operation** and must additionally:

1. `ALTER ROLE transport_worker LOGIN PASSWORD '<from-secrets-manager>'` (or use
   IAM/cert auth). Never commit the password.
2. `GRANT CONNECT ON DATABASE <db> TO transport_worker`.
3. `GRANT EXECUTE ON FUNCTION public.phase3_send_attempt_transition_ok(text,text)
TO transport_worker` — **required**: the `send_attempts` BEFORE UPDATE
   trigger is `SECURITY INVOKER` and calls this function, so without the grant
   the worker cannot advance the send state machine. (Surfaced by integration
   testing; `scripts/test-db.sh` applies the same grant for local runs.)
4. Provision the AES keyring in the runtime secrets store; set
   `CREDENTIAL_KEYRING` + `CREDENTIAL_ACTIVE_KEY_VERSION`.

## Credential provisioning (TEST-ONLY CLI)

`src/entrypoints/provision-credential.ts` encrypts a **synthetic** credential
and writes only ciphertext columns. It:

- reads the secret JSON (`{"user","pass"}`) from **stdin**, never argv, never
  echoed;
- **refuses** any target that looks like production (project ref
  `fpanvpxjjddhasjmpflz` or a `*.supabase.co` URL);
- writes ciphertext/nonce/auth_tag/algorithm/key_version/aad only.

```bash
export DATABASE_URL=postgresql://postgres@localhost:54330/transport_test
export CREDENTIAL_KEYRING="1:$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
export PROVISION_WORKSPACE_ID=... PROVISION_MAILBOX_ID=...
echo '{"user":"synthetic@test.local","pass":"synthetic-not-a-real-secret"}' \
  | pnpm provision:credential
```

## Recovering stuck sends

- `needs_human_review`: an ambiguous SMTP outcome or a restart mid-DATA. The
  Message-ID + evidence are preserved. An operator inspects the mailbox's Sent
  folder / delivery logs and decides; **the automated path never auto-retries.**
- `sent_copy_pending`: delivery succeeded but the Sent-append failed. Safe to
  reconcile by re-running the job — it searches by Message-ID and appends only
  if absent. It never re-delivers via SMTP.
- `failed_before_delivery`: nothing was sent (pre-DATA). Requires a fresh
  confirmed intent to try again; there is no auto-retry.

## Reaping stale claims

`WorkerClaimRepository.expireStale(now)` removes leases whose `lease_until` has
passed so a stalled `claimed` attempt can be re-driven. Sends that reached
`smtp_in_progress` are **not** auto-reclaimed for delivery — they go to review.
