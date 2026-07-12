import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { recomputeConfirmationProof } from "../../src/domain/confirmation-proof.js";
import type { SendIntentRow } from "../../src/domain/models.js";
import {
  DraftMirrorRepository,
  FolderRepository,
  MessageRepository,
  SendAttemptRepository,
  WorkerClaimRepository,
} from "../../src/db/repositories.js";
import { PgDatabase } from "../../src/db/pool.js";
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
      }>(
        `select * from public.create_send_intent(
           $1,$2,$3, 1, 'sender@test.local',
           '{"to":["r@test.local"],"cc":["c@test.local"]}'::jsonb,
           'Hello subject',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           null,
           '[{"filename":"a.txt","contentType":"text/plain","sizeBytes":3,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]'::jsonb
         )`,
        [ctx.workspaceId, ctx.mailboxId, ctx.draftId],
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
      };
      const recomputed = recomputeConfirmationProof(intent);
      expect(recomputed).toBe(row.confirmation_proof);
    } finally {
      client.release();
    }
  });
});
