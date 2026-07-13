# ADR 0007 — Canonical transport contract lock + `contract:verify`

## Status: accepted (Phase 3A contract lock)

## Context

The canonical Phase 3 transport schema — the immutable migration set, the
least-privilege `transport_worker` role, and the function/table/schema privilege
boundaries — is owned by the sibling UI repo (`E-Mail-Composer-UI`), which
publishes a machine-readable manifest at
`supabase/contracts/phase3-transport-contract.json`.

Before this ADR the backend hand-copied the pin in **six** places (the CI
workflow, `scripts/test-db.sh`, `test/unit/canonical-pin.test.ts`, `README.md`,
`THIRD_PARTY_NOTICES.md`, and `docs/production-non-deployment.md`): a full UI
commit SHA plus the three Phase 3 migration `sha256` checksums, each as literal
strings. Six copies of the same constants drift; a partial update silently
weakens the fail-closed guarantee.

## Decision

### One backend lock file

`config/canonical-transport-contract.lock.json` is the **single backend source**
for the pin:

```json
{
  "uiCommitSha": "…",
  "manifestPath": "supabase/contracts/phase3-transport-contract.json",
  "manifestSha256": "…",
  "supportedManifestSchemaVersion": 1,
  "supportedTransportContractVersion": 1
}
```

The lock deliberately does **not** contain the per-migration checksums. Those
live in the UI manifest (the single owner of migration content). The lock pins
the manifest _as a whole_ (via `manifestSha256`) and the exact UI commit it was
read from; the manifest then pins each migration.

### One fail-closed command: `pnpm contract:verify`

`scripts/verify-contract.mjs` is the **single** implementation, used identically
locally and in CI. It is a static/structural check — it never opens a database,
socket, or production system. It parses JSON with strict `JSON.parse` (no `eval`,
no dynamic `require` of untrusted content) and hashes files with `node:crypto`.
It accepts the UI checkout path via `UI_REPO` (default `./ui-schema` in CI, then
the local sibling checkout). It exits non-zero, listing every violation, when:

1. the checked-out UI git SHA != `lock.uiCommitSha`;
2. `sha256(manifest)` != `lock.manifestSha256`;
   3/4. the manifest schema / transport-contract versions are unsupported;
   5/6. a manifest-listed migration is missing on disk, or its on-disk `sha256`
   differs from the manifest;
3. the manifest does not grant `transport_worker` `EXECUTE` on the validator
   `public.phase3_send_attempt_transition_ok(text,text)`;
4. the manifest omits the forbidden browser-role `EXECUTE` / worker
   `INSERT`+`DELETE` boundaries;
5. `protectedPrivateSchemas` omits `transport`;
6. the backend queue names differ from the manifest queue names;
7. `QUEUE_DEFINITIONS[send_message].retryLimit` != 0;
8. the transport feature-flag default (`MAIL_TRANSPORT_V1_ENABLED`) is not
   disabled;
9. a test-only object `GRANT` to `transport_worker` exists in backend
   sql/ts/scripts;
10. audit-table polling of `public.transport_audit` as a work queue reappears;
11. durable sync-request support regressed (no `SyncRequestRepository.claimBatch`
    or its SQL no longer uses `FOR UPDATE SKIP LOCKED`).

Live-database privilege PROOF (worker `EXECUTE`; `SELECT`+`UPDATE`-only on
`transport.sync_requests`; browser role has no `USAGE` on the private schema)
stays in the integration suite (see ADR 0003/0006 and
`test/integration/*`). `contract:verify` covers only the static/structural and
config checks so it can run with no database, in the same command, everywhere.

The CI workflow keeps `UI_REPO_REF` as a literal because `actions/checkout` needs
the ref before any file is readable — but that literal MUST equal
`lock.uiCommitSha`, and `contract:verify` asserts
`git -C ui-schema rev-parse HEAD === lock.uiCommitSha`. The old hand-copied
`EXPECTED_*_SHA` env vars and the inline checksum shell block are gone.

### LOGIN/CONNECT vs object-grant distinction

The integration harness creates the `transport_worker` role with **only**
`ALTER ROLE transport_worker LOGIN` + `GRANT CONNECT ON DATABASE` — local
_authentication_ setup so the suite can connect **as** the least-privilege role.
That is a role/database privilege, **not** application-object privilege
injection. Every application object privilege the worker holds
(`EXECUTE` on the transition validator; `SELECT`+`UPDATE` on
`transport.sync_requests`; `SELECT` on the private credential/claim tables) comes
**only** from the canonical migrations. The static scan (check 13, and the B7
unit test) FAILS on any `GRANT … TO transport_worker` in backend sql/ts/scripts
**except** an explicit `LOGIN`/`CONNECT` grant or a clearly-labelled negative
test fixture. LOGIN/CONNECT are the documented exception; object grants are not.

## Cross-repo update workflow

To adopt a new additive UI migration:

1. Open **one UI PR** that adds the new additive migration **and** updates the
   manifest (new migration entry + checksum, version bumps if the schema/contract
   version changed). Never edit a merged migration; never bypass checksum review.
2. Let the UI gates run and **merge** that PR.
3. Record the **merged** UI commit SHA and the new manifest `sha256`.
4. In a **separate backend PR**, update
   `config/canonical-transport-contract.lock.json` (and `UI_REPO_REF` in CI, kept
   equal to the lock) to the merged UI SHA + manifest hash.
5. Run `pnpm contract:verify` against the **exact merged UI SHA**; merge only when
   it passes.

Never pin an unmerged UI branch. Never edit a merged migration. Never bypass the
checksum review. Neither the UI merge nor the backend lock update authorizes a
production deployment — enabling transport in production is a later, explicit,
separately-gated decision (see `docs/production-non-deployment.md` and
`docs/phase-3b-checklist.md`).
