import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { SendAttemptRepository } from "../../src/db/repositories.js";
import { PgDatabase } from "../../src/db/pool.js";
import {
  HAS_DB,
  seedContext,
  superuserPool,
  WORKER_URL,
  type SeededContext,
} from "./helpers.js";

const d = HAS_DB ? describe : describe.skip;

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

async function mailboxAddress(
  admin: pg.Pool,
  mailboxId: string,
): Promise<string> {
  const r = await admin.query<{ email_address: string }>(
    `select email_address from public.mailboxes where id = $1`,
    [mailboxId],
  );
  return r.rows[0]!.email_address;
}

/**
 * Call the canonical create_send_intent RPC as a member (auth.uid set to the
 * seeded user). Idempotency key + payload are explicit so we can exercise
 * replay / divergence / cross-workspace.
 */
async function createIntent(
  admin: pg.Pool,
  ctx: SeededContext,
  opts: { key: string; subject?: string; sender?: string },
): Promise<{ id: string }> {
  const sender = opts.sender ?? (await mailboxAddress(admin, ctx.mailboxId));
  const client = await admin.connect();
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, false)`,
      [ctx.userId],
    );
    const r = await client.query<{ id: string }>(
      // v2: p_contract_version MUST be 2, and the confirmed subject MUST
      // byte-match the locked draft subject (seedContext seeds 'subject').
      `select id from public.create_send_intent(
         $1,$2,$3, 1, $4,
         '{"to":["r@test.local"]}'::jsonb,
         $5,
         null, null, '[]'::jsonb,
         null, null, 2, $6)`,
      [
        ctx.workspaceId,
        ctx.mailboxId,
        ctx.draftId,
        sender,
        opts.subject ?? "subject",
        opts.key,
      ],
    );
    return { id: r.rows[0]!.id };
  } finally {
    client.release();
  }
}

// ===========================================================================
// B6 — strict idempotency contract (fixtures against the FINAL schema).
//
// The WORKER never calls create_send_intent — intent creation is the trusted
// app/API boundary and the worker consumes only immutable, confirmed intents.
// So there is NO production worker code that classifies P0409; instead we PROVE
// the RPC contract here, against the canonical schema, as the API would see it.
// ===========================================================================
d("create_send_intent idempotency contract (B6)", () => {
  let admin: pg.Pool;
  beforeAll(() => {
    admin = superuserPool();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("identical key + identical payload → the SAME existing intent (replay)", async () => {
    const ctx = await seedContext(admin);
    const key = `idem-${randomUUID()}`;
    const a = await createIntent(admin, ctx, { key });
    const b = await createIntent(admin, ctx, { key });
    expect(b.id).toBe(a.id);
  });

  it("identical key + DIVERGENT payload → P0409 (deterministic conflict)", async () => {
    const ctx = await seedContext(admin);
    const key = `idem-${randomUUID()}`;
    // First call uses the matching (locked) subject and succeeds. The replay
    // reuses the key with a DIVERGENT subject: the input-only fingerprint
    // differs, so strict idempotency raises P0409 at the idempotency check
    // (before the subject gate) — the deterministic-conflict contract.
    await createIntent(admin, ctx, { key });
    let code: string | undefined;
    try {
      await createIntent(admin, ctx, { key, subject: "Divergent" });
    } catch (err) {
      code = pgCode(err);
    }
    expect(code).toBe("P0409");
  });

  it("cross-workspace inaccessible → uniform P0002 (no existence leak)", async () => {
    const ctxA = await seedContext(admin);
    const ctxB = await seedContext(admin); // a different workspace + member
    const key = `idem-${randomUUID()}`;
    await createIntent(admin, ctxA, { key });
    // User B (member of workspace B only) reuses A's key against B's params.
    let code: string | undefined;
    try {
      await createIntent(admin, ctxB, { key });
    } catch (err) {
      code = pgCode(err);
    }
    // Uniform not-found, NOT P0409 — existence across workspaces is not leaked.
    expect(code).toBe("P0002");
  });
});

// ===========================================================================
// B2 regression + B7/B8 — the send state machine under the REAL transport_worker
// role, with the canonical grant and NO injected privilege.
// ===========================================================================
d(
  "send_attempts under the real worker role (canonical grant, no injection)",
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

    async function seedAttempt(ctx: SeededContext): Promise<string> {
      const mId = `<${randomUUID()}@mail.test.local>`;
      const intent = await admin.query<{ id: string }>(
        `insert into public.send_intents
         (workspace_id, mailbox_id, draft_id, draft_revision, sender, recipients,
          subject, message_id, idempotency_key, confirmed_by, confirmation_proof)
       values ($1,$2,$3,1,'sender@test.local',
               '{"to":["r@test.local"]}'::jsonb,'s',$4,$5,$6,$7) returning id`,
        [
          ctx.workspaceId,
          ctx.mailboxId,
          ctx.draftId,
          mId,
          `idem-${randomUUID()}`,
          ctx.userId,
          "a".repeat(64),
        ],
      );
      const attempt = await admin.query<{ id: string }>(
        `insert into public.send_attempts (workspace_id, send_intent_id, state, message_id)
       values ($1,$2,'confirmed',$3) returning id`,
        [ctx.workspaceId, intent.rows[0]!.id, mId],
      );
      return attempt.rows[0]!.id;
    }

    it("transport_worker HOLDS canonical EXECUTE on the transition validator (no injected grant)", async () => {
      const r = await worker.query<{ ok: boolean }>(
        `select has_function_privilege(
         'transport_worker',
         'public.phase3_send_attempt_transition_ok(text,text)',
         'EXECUTE') as ok`,
      );
      expect(r.rows[0]?.ok).toBe(true);
    });

    it("a LEGAL transition (confirmed→queued) succeeds under the worker role", async () => {
      const ctx = await seedContext(admin);
      const attemptId = await seedAttempt(ctx);
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

    it("an ILLEGAL transition (confirmed→completed) is rejected by the trigger", async () => {
      const ctx = await seedContext(admin);
      const attemptId = await seedAttempt(ctx);
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

    it("a VERSION ROLLBACK is rejected by the trigger", async () => {
      const ctx = await seedContext(admin);
      const attemptId = await seedAttempt(ctx);
      const repo = new SendAttemptRepository(worker);
      // Advance legally to version 2.
      await repo.compareAndSet({
        id: attemptId,
        expectedVersion: 1n,
        expectedState: "confirmed",
        toState: "queued",
      });
      // Directly attempt to roll the version backwards under the worker role.
      await expect(
        worker.query(
          `update public.send_attempts set version = 1, state = 'confirmed' where id = $1`,
          [attemptId],
        ),
      ).rejects.toBeTruthy();
    });

    it("a TERMINAL state stays terminal (cancelled→queued rejected)", async () => {
      const ctx = await seedContext(admin);
      const attemptId = await seedAttempt(ctx);
      const repo = new SendAttemptRepository(worker);
      const cancelled = await repo.compareAndSet({
        id: attemptId,
        expectedVersion: 1n,
        expectedState: "confirmed",
        toState: "cancelled",
      });
      expect(cancelled?.state).toBe("cancelled");
      // Any transition out of a terminal state is rejected.
      await expect(
        repo.compareAndSet({
          id: attemptId,
          expectedVersion: cancelled!.version,
          expectedState: "cancelled",
          toState: "queued",
        }),
      ).rejects.toBeTruthy();
    });
  },
);
