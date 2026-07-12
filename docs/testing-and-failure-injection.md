# Testing & failure-injection guide

Everything is testable **with no network** once dependencies are installed. The
container registry is blocked, so integration coverage comes from **in-repo
fake protocol servers** plus a **local Postgres** (`scripts/test-db.sh`), not
testcontainers.

## Fakes (`test/fakes/`)

- **`fake-imap.ts`** — `FakeImapServer` + `FakeImapClient` implementing the
  `ImapClient` port. Models folders, UID/UIDVALIDITY/UIDNEXT, fetch, append
  (Drafts/Sent), flag mutation, move, search-by-Message-ID, IDLE signals. Inject:
  `changeUidValidity`, `queueIdleSignal`, `connectOk`/`authOk`, seeded messages.
- **`fake-smtp.ts`** — `FakeSmtpClient` implementing the `SmtpClient` port.
  `behavior`: `accept` | `pre_data` (→ `SmtpPreDataError`) | `ambiguous`
  (→ `SmtpAmbiguousError`). Records accepted submissions for exactly-once and
  Message-ID-reuse assertions.
- **`fake-provider-factory.ts`** — assembles the **real** `ImapSmtpProvider` over
  the fakes, so provider logic (append-then-retire, Sent-copy search, Message-ID
  reuse) is exercised while delivery stays deterministic.
- **`in-memory-repos.ts`** — repository fakes that reproduce the safety-relevant
  DB behaviour: CAS version guard, the send-attempt transition table, atomic
  single-holder claims, and the draft-mirror stale-revision guard.

## The 43 required tests

| #     | Area                                                                                                                                                                                 | Location                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1–11  | IMAP sync: discovery, persistence, cursor-after-durability, incremental-only, dedupe/restart, UIDVALIDITY change + invalidation + audit, disabled-mailbox refusal, batched follow-up | `test/unit/sync-executor.test.ts`                                                                                |
| 12    | IMAP IDLE wake-up → enqueue + timeout fallback                                                                                                                                       | `test/unit/sync-executor.test.ts`                                                                                |
| 13–17 | Draft mirror: mirror + UID namespacing, idempotent-on-revision, append-then-retire, no older-overwrites-newer, missing payload                                                       | `test/unit/draft-mirror-executor.test.ts`                                                                        |
| 18–21 | Send happy path: deliver+complete, Message-ID reuse, terminal skip, no double-send                                                                                                   | `test/unit/send-executor.test.ts`                                                                                |
| 22–28 | Pre-send verification: global kill, disabled, mailbox kill, tampered proof→review, body-hash / recipients / revision mismatch→failed_before_delivery                                 | `test/unit/send-executor.test.ts`                                                                                |
| 29    | Pre-DATA failure → `failed_before_delivery`, nothing sent                                                                                                                            | `test/unit/send-executor.test.ts`                                                                                |
| 30    | Restart after `smtp_accepted` → no re-send, Sent reconcile only                                                                                                                      | `test/unit/send-executor.test.ts`                                                                                |
| 31    | Restart during `smtp_in_progress` → `needs_human_review`                                                                                                                             | `test/unit/send-executor.test.ts`                                                                                |
| 32–33 | Ambiguous disconnect → `needs_human_review`, Message-ID+evidence preserved, no auto-enqueue                                                                                          | `test/unit/send-executor.test.ts`                                                                                |
| 34    | Claim already held → no send                                                                                                                                                         | `test/unit/send-executor.test.ts`                                                                                |
| 35    | `send_message` `retryLimit === 0`                                                                                                                                                    | `test/unit/queue-config.test.ts` (config) + `test/integration/schema-and-queues.test.ts` (real pg-boss metadata) |
| 36    | Sent-append failure → `sent_copy_pending`, delivery still once                                                                                                                       | `test/unit/send-executor.test.ts`                                                                                |
| 37    | End-to-end: logs contain no body/credential/attachment data                                                                                                                          | `test/unit/send-executor.test.ts` + `test/unit/logger.test.ts`                                                   |
| 38    | Crypto round-trip                                                                                                                                                                    | `test/unit/crypto.test.ts`                                                                                       |
| 39    | Wrong-AAD fail                                                                                                                                                                       | `test/unit/crypto.test.ts`                                                                                       |
| 40    | Wrong/unknown key-version fail                                                                                                                                                       | `test/unit/crypto.test.ts`                                                                                       |
| 41    | Tampered ciphertext/tag fail                                                                                                                                                         | `test/unit/crypto.test.ts`                                                                                       |
| 42    | No plaintext fixtures in git                                                                                                                                                         | `test/unit/crypto.test.ts` (repo scan) + `scripts/secret-scan.sh`                                                |
| 43    | Provisioning refuses production refs                                                                                                                                                 | `test/unit/crypto.test.ts`                                                                                       |

Additional real-DB integration tests (`test/integration/`) cover: schema +
private-schema tables + worker role presence, `send_attempts` CAS + **DB-trigger
rejection of an illegal transition**, `send_intents` immutability, atomic
claim race, message-dedupe upsert, draft-mirror stale guard, and
**confirmation-proof parity** (the SQL RPC `create_send_intent` vs the TS
re-derivation in `src/domain/confirmation-proof.ts`).

## Running

```bash
pnpm test                 # unit
pnpm test:coverage        # unit + coverage thresholds
bash scripts/test-db.sh --print
TEST_DATABASE_URL=... TEST_WORKER_DATABASE_URL=... pnpm test:integration
bash scripts/test-db.sh --stop
```
