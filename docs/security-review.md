# Phase 3A security review

Scope: the transport worker foundation in this repository. Production is
disabled; this review covers the fail-closed posture and the safety controls.

## Threat model highlights

| Threat                                    | Control                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential theft via the browser/API      | Credentials live only in `transport.mailbox_credentials` (private schema; `anon`/`authenticated` have no access). Decryption is worker-only, flag-gated.                                                                                 |
| Ciphertext replay against another mailbox | AES-256-GCM AAD binds ciphertext to `workspace+mailbox+purpose`; wrong AAD fails closed.                                                                                                                                                 |
| Key confusion / downgrade                 | Versioned keyring; unknown `key_version` fails closed with no fallback; 32-byte length enforced.                                                                                                                                         |
| Secret leakage via logs                   | Content-free logger with a forbidden-key redactor; test 37 asserts no body/credential/attachment data is emitted.                                                                                                                        |
| Double-send / blind retry                 | `send_message` `retryLimit === 0`; immutable snapshot; atomic claim; ambiguous → human review.                                                                                                                                           |
| Tampered send after confirmation          | Confirmation proof re-derived and matched; body-hash/recipients/manifest/revision/Message-ID re-verified before SMTP.                                                                                                                    |
| Malicious inbound MIME                    | Treated as untrusted DATA: streaming parse with total-size/attachment-count/part-size/nesting/timeout limits; filename normalization; no external fetch, no script, no raw HTML render; never crashes on malformed input; metadata only. |
| Privilege creep                           | Worker uses the least-privileged `transport_worker` role with an explicit, narrow DML surface; no `CREATE`, no broad write.                                                                                                              |
| Runaway worker                            | Global + per-mailbox kill switches; graceful SIGTERM/SIGINT; bounded timeouts; jittered reconnect.                                                                                                                                       |
| Provisioning against production           | Test-only CLI refuses the prod project ref and `*.supabase.co`; reads secrets from stdin only; writes ciphertext only.                                                                                                                   |

## Fail-closed posture

- The feature flag defaults `false`. Off = no connection, no send worker, no
  decryption; health `transport-disabled`.
- Invalid config (missing DB URL, bad keyring, unknown active key) refuses to
  start.
- Grants and worker-startup rules are safe **independent of the flag**.

## Residual items / notes

- **Worker-role EXECUTE grant**: the canonical migration grants
  `phase3_send_attempt_transition_ok` EXECUTE to `service_role` only; the worker
  role also needs it (the `SECURITY INVOKER` update trigger calls it). Production
  provisioning must add this grant (see runbook). Surfaced by integration tests.
- **Confirmation-proof parity** depends on Postgres `jsonb` canonicalization; it
  is asserted against the real RPC in integration, and must be re-verified if the
  RPC's canonical snapshot changes.
- Real IMAP/SMTP adapters are integration-boundary code exercised via the fakes;
  live-provider behaviour is validated in the Phase 3B controlled rollout.

## Content-free logging (enforced)

The logger never emits: passwords/credentials, message bodies, attachment bytes,
raw MIME, auth headers, connection strings, or key material. Known-sensitive keys
are redacted and long values truncated even if a caller passes them by mistake.
