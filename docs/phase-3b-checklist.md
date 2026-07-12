# Phase 3B — controlled-IONOS rollout checklist

Phase 3B is the **first** time real IMAP/SMTP is touched, against a **dedicated
non-production mailbox only**. Do not proceed until every item is checked.

## Preconditions

- [ ] A **dedicated non-production IONOS mailbox** exists solely for this test
      (no real user mail).
- [ ] Provider dashboard **backup / PITR** is confirmed enabled for the target
      database.
- [ ] The DB target is an **approved non-production** instance — verified NOT the
      prod project ref `fpanvpxjjddhasjmpflz` and NOT a `*.supabase.co` prod URL.
- [ ] Secrets (AES keyring, mailbox credential) come from the **approved secrets
      store**; nothing is committed or logged.
- [ ] The `transport_worker` role is provisioned per the runbook, **including the
      `phase3_send_attempt_transition_ok` EXECUTE grant**.
- [ ] `MAIL_TRANSPORT_V1_ENABLED=true` set **only** in the controlled env.

## Controlled exercises (one of each)

- [ ] **One-folder sync**: discover folders, sync a single folder, verify
      metadata-only rows and a correct cursor; re-run → no duplicates.
- [ ] **One draft mirror**: mirror a single draft to Drafts; verify remote UID +
      UIDVALIDITY recorded; edit → append-then-retire; older job → no overwrite.
- [ ] **One confirmed message**: create exactly one `send_intent`; verify the
      immutable snapshot + server-generated Message-ID + confirmation proof.
- [ ] **Proof of one delivery**: observe `smtp_accepted` with the SMTP response
      recorded; confirm the recipient received exactly one copy.
- [ ] **One Sent copy**: verify the Sent folder holds one message with the
      **same Message-ID**; re-run reconciliation → no duplicate append.
- [ ] **Simulated ambiguous failure**: inject a disconnect during/after DATA;
      verify the attempt goes to **`needs_human_review`**, Message-ID + evidence
      preserved, and **zero auto-resend** occurs.
- [ ] Confirm **no automatic retry** happened for any `send_message` job.

## Rollback

- [ ] Rollback = **shut the worker down and set `MAIL_TRANSPORT_V1_ENABLED=false`**
      (and/or engage the global kill switch). No data migration is required to
      disable; the flag-off state is fully fail-closed.

## Exit

- [ ] All exercises pass; evidence (content-free logs + audit rows) archived.
- [ ] Production remains disabled; any production enablement is a **separate,
      later decision** gated on Phase 2 readiness and a fresh review.
