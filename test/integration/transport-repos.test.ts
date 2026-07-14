import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { recomputeConfirmationProof } from "../../src/domain/confirmation-proof.js";
import type { SendIntentRow } from "../../src/domain/models.js";
import {
  DraftMirrorRepository,
  FolderRepository,
  MessageRepository,
  MirrorSnapshotRepository,
  SendAttemptRepository,
  SendSnapshotRepository,
  WorkerClaimRepository,
} from "../../src/db/repositories.js";
import { PgDatabase } from "../../src/db/pool.js";
import { renderDraftBody } from "../../src/mime/draft-renderer.js";
import { DraftVersionSendPayloadResolver } from "../../src/workers/send-payload-resolver.js";
import { HAS_DB, seedContext, superuserPool, WORKER_URL } from "./helpers.js";

const d = HAS_DB ? describe : describe.skip;

function messageId(): string {
  return `<${randomUUID()}@mail.test.local>`;
}

/** Insert an immutable send_intent + a seeded send_attempt as the superuser. */
async function seedIntentAndAttempt(
  db: pg.Pool,
  ctx: {
    workspaceId: string;
    mailboxId: string;
    draftId: string;
    userId: string;
  },
): Promise<{ intentId: string; attemptId: string; messageId: string }> {
  const mId = messageId();
  const proof = "a".repeat(64);
  const intent = await db.query<{ id: string }>(
    `insert into public.send_intents
       (workspace_id, mailbox_id, draft_id, draft_revision, sender, recipients,
        subject, message_id, idempotency_key, confirmed_by, confirmation_proof)
     values ($1,$2,$3,1,'sender@test.local',
             '{"to":["r@test.local"]}'::jsonb,'s',$4,$5,$6,$7)
     returning id`,
    [
      ctx.workspaceId,
      ctx.mailboxId,
      ctx.draftId,
      mId,
      `idem-${randomUUID()}`,
      ctx.userId,
      proof,
    ],
  );
  const intentId = intent.rows[0]!.id;
  const attempt = await db.query<{ id: string }>(
    `insert into public.send_attempts (workspace_id, send_intent_id, state, message_id)
     values ($1,$2,'confirmed',$3) returning id`,
    [ctx.workspaceId, intentId, mId],
  );
  return { intentId, attemptId: attempt.rows[0]!.id, messageId: mId };
}

d("send_attempts state machine (real DB trigger)", () => {
  let admin: pg.Pool;
  let worker: PgDatabase;
  beforeAll(() => {
    admin = superuserPool();
    worker = new PgDatabase({ connectionString: WORKER_URL });
  });
  afterAll(async () => {
    await worker.end();
    await admin.end();
  });

  it("advances state under a version-guarded compare-and-set", async () => {
    const ctx = await seedContext(admin);
    const { attemptId } = await seedIntentAndAttempt(admin, ctx);
    const repo = new SendAttemptRepository(worker);
    const moved = await repo.compareAndSet({
      id: attemptId,
      expectedVersion: 1n,
      expectedState: "confirmed",
      toState: "queued",
    });
    expect(moved?.state).toBe("queued");
    expect(moved?.version).toBe(2n);
  });

  it("a stale CAS (wrong version) is a no-op", async () => {
    const ctx = await seedContext(admin);
    const { attemptId } = await seedIntentAndAttempt(admin, ctx);
    const repo = new SendAttemptRepository(worker);
    const lost = await repo.compareAndSet({
      id: attemptId,
      expectedVersion: 99n,
      expectedState: "confirmed",
      toState: "queued",
    });
    expect(lost).toBeNull();
  });

  it("the DB trigger REJECTS an illegal transition (confirmed→completed)", async () => {
    const ctx = await seedContext(admin);
    const { attemptId } = await seedIntentAndAttempt(admin, ctx);
    const repo = new SendAttemptRepository(worker);
    await expect(
      repo.compareAndSet({
        id: attemptId,
        expectedVersion: 1n,
        expectedState: "confirmed",
        toState: "completed",
      }),
    ).rejects.toBeTruthy();
  });

  it("send_intents are immutable (UPDATE raises)", async () => {
    const ctx = await seedContext(admin);
    const { intentId } = await seedIntentAndAttempt(admin, ctx);
    await expect(
      admin.query(
        `update public.send_intents set subject = 'x' where id = $1`,
        [intentId],
      ),
    ).rejects.toBeTruthy();
  });
});

d("worker claims are atomic (at most one holder)", () => {
  let admin: pg.Pool;
  let worker: PgDatabase;
  beforeAll(() => {
    admin = superuserPool();
    worker = new PgDatabase({ connectionString: WORKER_URL });
  });
  afterAll(async () => {
    await worker.end();
    await admin.end();
  });

  it("only one of two concurrent claims wins", async () => {
    const ctx = await seedContext(admin);
    const { attemptId } = await seedIntentAndAttempt(admin, ctx);
    const claims = new WorkerClaimRepository(worker);
    const lease = new Date(Date.now() + 60_000);
    const [a, b] = await Promise.all([
      claims.tryClaim({
        sendAttemptId: attemptId,
        workerId: "w-a",
        leaseUntil: lease,
      }),
      claims.tryClaim({
        sendAttemptId: attemptId,
        workerId: "w-b",
        leaseUntil: lease,
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // Release lets it be re-claimed (recovery path).
    await claims.release(attemptId);
    expect(
      await claims.tryClaim({
        sendAttemptId: attemptId,
        workerId: "w-c",
        leaseUntil: lease,
      }),
    ).toBe(true);
  });
});

d("message dedupe + draft mirror guard (real DB)", () => {
  let admin: pg.Pool;
  let worker: PgDatabase;
  beforeAll(() => {
    admin = superuserPool();
    worker = new PgDatabase({ connectionString: WORKER_URL });
  });
  afterAll(async () => {
    await worker.end();
    await admin.end();
  });

  it("upserts message metadata idempotently on (folder,uidvalidity,uid)", async () => {
    const ctx = await seedContext(admin);
    const folders = new FolderRepository(worker);
    const messages = new MessageRepository(worker);
    const folder = await folders.upsertDiscovered({
      workspaceId: ctx.workspaceId,
      mailboxId: ctx.mailboxId,
      name: "INBOX",
      role: "inbox",
      uidvalidity: 5n,
      uidnext: 1n,
    });
    const meta = {
      workspaceId: ctx.workspaceId,
      mailboxId: ctx.mailboxId,
      folderId: folder.id,
      uidvalidity: 5n,
      uid: 10n,
      messageId: "<m@x>",
      inReplyTo: null,
      referencesHeader: null,
      subject: "s",
      fromSummary: "a@x",
      toSummary: "b@x",
      internalDate: new Date(),
      sizeBytes: 42n,
      flags: ["\\Seen"],
      hasAttachments: false,
    };
    await messages.upsertMeta(meta);
    await messages.upsertMeta(meta); // duplicate job → still one row
    expect(await messages.countByFolder(folder.id)).toBe(1);
  });

  it("never overwrites a newer draft revision with an older one", async () => {
    const ctx = await seedContext(admin);
    const mirrors = new DraftMirrorRepository(worker);
    await mirrors.upsert({
      workspaceId: ctx.workspaceId,
      draftId: ctx.draftId,
      mailboxId: ctx.mailboxId,
      remoteUid: 3n,
      remoteUidvalidity: 7n,
      mirroredRevision: 3n,
      status: "mirrored",
    });
    // A stale (older revision) job arrives late.
    const after = await mirrors.upsert({
      workspaceId: ctx.workspaceId,
      draftId: ctx.draftId,
      mailboxId: ctx.mailboxId,
      remoteUid: 2n,
      remoteUidvalidity: 7n,
      mirroredRevision: 2n,
      status: "mirrored",
    });
    expect(after.mirroredRevision).toBe(3n); // unchanged
  });
});

d(
  "confirmed-send snapshot access via the private function (v2, real grants)",
  () => {
    let admin: pg.Pool;
    let worker: PgDatabase;
    beforeAll(() => {
      admin = superuserPool();
      worker = new PgDatabase({ connectionString: WORKER_URL });
    });
    afterAll(async () => {
      await worker.end();
      await admin.end();
    });

    const SNAPSHOT_DOC = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "integration snapshot body" }],
        },
      ],
    };

    /**
     * Seed a fully-formed v2 confirmation directly (as superuser): an immutable
     * draft_versions snapshot + a send_intent bound to it by the composite
     * identity FK, with proof_version = 2 / contract_version = 2. Mirrors exactly
     * what create_send_intent writes, so transport.get_send_snapshot accepts it.
     */
    async function seedV2Intent(ctx: {
      workspaceId: string;
      mailboxId: string;
      draftId: string;
      userId: string;
    }): Promise<{ intentId: string; draftVersionId: string }> {
      const dv = await admin.query<{ id: string }>(
        `insert into public.draft_versions
         (workspace_id, draft_id, version_no, source_revision, subject,
          body_json, reason, created_by)
       values ($1,$2,1,1,'subject',$3::jsonb,'send_confirmation',$4)
       returning id`,
        [
          ctx.workspaceId,
          ctx.draftId,
          JSON.stringify(SNAPSHOT_DOC),
          ctx.userId,
        ],
      );
      const draftVersionId = dv.rows[0]!.id;
      const intent = await admin.query<{ id: string }>(
        `insert into public.send_intents
         (workspace_id, mailbox_id, draft_id, draft_revision, sender, recipients,
          subject, message_id, idempotency_key, confirmed_by, confirmation_proof,
          contract_version, draft_version_id, proof_version)
       values ($1,$2,$3,1,'sender@test.local',
               '{"to":["r@test.local"]}'::jsonb,'subject',$4,$5,$6,$7,2,$8,2)
       returning id`,
        [
          ctx.workspaceId,
          ctx.mailboxId,
          ctx.draftId,
          messageId(),
          `idem-${randomUUID()}`,
          ctx.userId,
          "a".repeat(64),
          draftVersionId,
        ],
      );
      return { intentId: intent.rows[0]!.id, draftVersionId };
    }

    function intentFor(
      ctx: {
        workspaceId: string;
        mailboxId: string;
        draftId: string;
        userId: string;
      },
      intentId: string,
    ): SendIntentRow {
      return {
        id: intentId,
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        draftId: ctx.draftId,
        draftRevision: 1n,
        sender: "sender@test.local",
        recipients: { to: ["r@test.local"] },
        subject: "subject",
        htmlHash: null,
        textHash: null,
        attachmentManifest: [],
        messageId: messageId(),
        idempotencyKey: `idem-${randomUUID()}`,
        templateVersionId: null,
        signatureId: null,
        confirmedBy: ctx.userId,
        confirmationProof: "a".repeat(64),
        contractVersion: 2,
        proofVersion: 2,
        draftVersionId: null,
      };
    }

    // The worker has NO table grant on public.draft_versions — it reads confirmed
    // content ONLY through the private SECURITY DEFINER accessor. This negative
    // guard pins that a direct SELECT is denied (42501) even though the accessor
    // works (next test).
    it("transport_worker has NO direct SELECT on public.draft_versions (42501)", async () => {
      try {
        await worker.query(`select id from public.draft_versions limit 1`);
        expect.unreachable("worker SELECT on draft_versions should be denied");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("42501");
      }
    });

    it("the WORKER role CAN execute transport.get_send_snapshot with NO test-only grant", async () => {
      const ctx = await seedContext(admin);
      const { intentId, draftVersionId } = await seedV2Intent(ctx);
      // Executes as the least-privileged worker login — the only grant is the
      // canonical EXECUTE from migration 20260716100000.
      const repo = new SendSnapshotRepository(worker);
      const snap = await repo.getSendSnapshot(intentId);
      expect(snap.draftVersionId).toBe(draftVersionId);
      expect(snap.workspaceId).toBe(ctx.workspaceId);
      expect(snap.draftId).toBe(ctx.draftId);
      expect(snap.sourceRevision).toBe(1n);
      expect(snap.subject).toBe("subject");
      expect(snap.bodyJson).toEqual(SNAPSHOT_DOC);
    });

    it("send happy path resolves via the function under the worker role", async () => {
      const ctx = await seedContext(admin);
      const { intentId } = await seedV2Intent(ctx);
      const resolver = new DraftVersionSendPayloadResolver({
        sendSnapshots: new SendSnapshotRepository(worker),
      });
      const payload = await resolver.resolve(intentFor(ctx, intentId));
      expect(payload.revision).toBe(1n);
      const rendered = renderDraftBody(SNAPSHOT_DOC);
      expect(payload.message.html).toBe(rendered.html);
      expect(payload.message.text).toBe(rendered.text);
      expect(payload.message.attachments).toEqual([]);
    });

    it("a legacy (proof-v1) intent is non-sendable: uniform P0002 → snapshot_unavailable", async () => {
      const ctx = await seedContext(admin);
      // Legacy shape: no draft_version_id, proof_version/contract_version default 1.
      const legacy = await admin.query<{ id: string }>(
        `insert into public.send_intents
         (workspace_id, mailbox_id, draft_id, draft_revision, sender, recipients,
          subject, message_id, idempotency_key, confirmed_by, confirmation_proof)
       values ($1,$2,$3,1,'sender@test.local',
               '{"to":["r@test.local"]}'::jsonb,'subject',$4,$5,$6,$7)
       returning id`,
        [
          ctx.workspaceId,
          ctx.mailboxId,
          ctx.draftId,
          messageId(),
          `idem-${randomUUID()}`,
          ctx.userId,
          "a".repeat(64),
        ],
      );
      const repo = new SendSnapshotRepository(worker);
      await expect(
        repo.getSendSnapshot(legacy.rows[0]!.id),
      ).rejects.toMatchObject({ code: "snapshot_unavailable" });
      // And a wholly unknown intent id fails identically (indistinguishable).
      await expect(repo.getSendSnapshot(randomUUID())).rejects.toMatchObject({
        code: "snapshot_unavailable",
      });
    });

    it("the WORKER role CAN execute transport.get_mirror_snapshot; missing → P0002", async () => {
      const ctx = await seedContext(admin);
      await seedV2Intent(ctx); // also lands a draft_versions row at revision 1
      const repo = new MirrorSnapshotRepository(worker);
      const snap = await repo.getMirrorSnapshot(
        ctx.workspaceId,
        ctx.draftId,
        1n,
      );
      expect(snap.subject).toBe("subject");
      expect(snap.bodyJson).toEqual(SNAPSHOT_DOC);
      await expect(
        repo.getMirrorSnapshot(ctx.workspaceId, ctx.draftId, 999n),
      ).rejects.toMatchObject({ code: "snapshot_unavailable" });
    });
  },
);

d("confirmation-proof parity: SQL RPC vs TS re-derivation", () => {
  let admin: pg.Pool;
  beforeAll(() => {
    admin = superuserPool();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("recomputes the exact proof create_send_intent produced", async () => {
    const ctx = await seedContext(admin);
    const client = await admin.connect();
    try {
      // Establish the auth.uid() the RPC will read.
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, false)`,
        [ctx.userId],
      );
      // Sender authority (hardening migration): p_sender MUST equal the mailbox
      // address after trim+lowercase, so pass the seeded mailbox's own address.
      const mb = await client.query<{ email_address: string }>(
        `select email_address from public.mailboxes where id = $1`,
        [ctx.mailboxId],
      );
      const senderAddr = mb.rows[0]!.email_address;
      const res = await client.query<{
        id: string;
        message_id: string;
        confirmation_proof: string;
        recipients: unknown;
        attachment_manifest: unknown;
        subject: string;
        sender: string;
        draft_revision: string;
        contract_version: number;
        proof_version: number;
        draft_version_id: string;
      }>(
        // v2: the confirmed subject MUST byte-match the locked draft subject
        // (seedContext seeds 'subject'); p_contract_version defaults to 2.
        `select * from public.create_send_intent(
           $1,$2,$3, 1, $4,
           '{"to":["r@test.local"],"cc":["c@test.local"]}'::jsonb,
           'subject',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           null,
           '[{"filename":"a.txt","contentType":"text/plain","sizeBytes":3,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]'::jsonb
         )`,
        [ctx.workspaceId, ctx.mailboxId, ctx.draftId, senderAddr],
      );
      const row = res.rows[0]!;
      const intent: SendIntentRow = {
        id: row.id,
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        draftId: ctx.draftId,
        draftRevision: BigInt(row.draft_revision),
        sender: row.sender,
        recipients: row.recipients as SendIntentRow["recipients"],
        subject: row.subject,
        htmlHash:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        textHash: null,
        attachmentManifest:
          row.attachment_manifest as SendIntentRow["attachmentManifest"],
        messageId: row.message_id,
        idempotencyKey: "unused",
        templateVersionId: null,
        signatureId: null,
        confirmedBy: ctx.userId,
        confirmationProof: row.confirmation_proof,
        contractVersion: row.contract_version,
        proofVersion: row.proof_version,
        draftVersionId: row.draft_version_id,
      };
      const recomputed = recomputeConfirmationProof(intent);
      expect(recomputed).toBe(row.confirmation_proof);
    } finally {
      client.release();
    }
  });
});
