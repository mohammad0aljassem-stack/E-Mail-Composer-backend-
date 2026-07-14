import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { SyncRequestRepository } from "../../src/db/repositories.js";
import { PgDatabase } from "../../src/db/pool.js";
import { singletonKeys } from "../../src/queues/queue-config.js";
import { HAS_DB, seedContext, superuserPool, WORKER_URL } from "./helpers.js";

const d = HAS_DB ? describe : describe.skip;

/**
 * Create a durable sync_requests row through the REAL SECURITY DEFINER RPC
 * `request_mailbox_sync` (the only write path; the worker has no INSERT). Sets
 * auth.uid() via the JWT-sub GUC the RPC reads.
 */
async function requestSync(
  admin: pg.Pool,
  ctx: { workspaceId: string; mailboxId: string; userId: string },
): Promise<{ id: string; status: string }> {
  const client = await admin.connect();
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, false)`,
      [ctx.userId],
    );
    const r = await client.query<{
      result: { sync_request_id: string; status: string };
    }>(`select public.request_mailbox_sync($1,$2) as result`, [
      ctx.mailboxId,
      ctx.workspaceId,
    ]);
    const res = r.rows[0]!.result;
    return { id: res.sync_request_id, status: res.status };
  } finally {
    client.release();
  }
}

d("durable sync_requests — worker least privilege (SELECT+UPDATE only)", () => {
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

  it("the worker role can SELECT+UPDATE but NOT INSERT/DELETE sync_requests", async () => {
    const ctx = await seedContext(admin);
    const req = await requestSync(admin, ctx);
    // SELECT works.
    const repo = new SyncRequestRepository(worker);
    expect((await repo.getById(req.id))?.status).toBe("pending");
    // INSERT + DELETE are denied by the canonical grant model.
    await expect(
      worker.query(
        `insert into transport.sync_requests (workspace_id, mailbox_id, status)
         values ($1,$2,'pending')`,
        [ctx.workspaceId, ctx.mailboxId],
      ),
    ).rejects.toBeTruthy();
    await expect(
      worker.query(`delete from transport.sync_requests where id = $1`, [
        req.id,
      ]),
    ).rejects.toBeTruthy();
  });

  it("claims a pending request atomically: claimed, attempt_count=1, claimed_at set", async () => {
    const ctx = await seedContext(admin);
    const req = await requestSync(admin, ctx);
    const repo = new SyncRequestRepository(worker);
    const now = new Date();
    const claimed = await repo.claimBatch({
      limit: 10,
      now,
      leaseCutoff: new Date(now.getTime() - 300_000),
      maxAttempts: 5,
    });
    const mine = claimed.find((r) => r.id === req.id);
    expect(mine?.status).toBe("claimed");
    expect(mine?.attemptCount).toBe(1);
    expect(mine?.claimedAt).not.toBeNull();
  });

  it("the RPC dedups an open request (same mailbox → same row)", async () => {
    const ctx = await seedContext(admin);
    const first = await requestSync(admin, ctx);
    const second = await requestSync(admin, ctx);
    expect(second.id).toBe(first.id); // open dedup via uq_sync_requests_open
  });
});

d("durable sync_requests — two-worker race resolves to one claim", () => {
  let admin: pg.Pool;
  let workerA: PgDatabase;
  let workerB: PgDatabase;
  beforeAll(() => {
    admin = superuserPool();
    workerA = new PgDatabase({ connectionString: WORKER_URL });
    workerB = new PgDatabase({ connectionString: WORKER_URL });
  });
  afterAll(async () => {
    await workerA.end();
    await workerB.end();
    await admin.end();
  });

  it("only one of two concurrent claimBatch calls claims the single request", async () => {
    const ctx = await seedContext(admin);
    const req = await requestSync(admin, ctx);
    const now = new Date();
    const args = {
      limit: 5,
      now,
      leaseCutoff: new Date(now.getTime() - 300_000),
      maxAttempts: 5,
    };
    const [a, b] = await Promise.all([
      new SyncRequestRepository(workerA).claimBatch(args),
      new SyncRequestRepository(workerB).claimBatch(args),
    ]);
    const claims = [...a, ...b].filter((r) => r.id === req.id);
    // FOR UPDATE SKIP LOCKED guarantees at most one claim of the row.
    expect(claims).toHaveLength(1);
  });
});

d("durable sync_requests — lease, stale reclaim, terminal states", () => {
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

  /** Insert a claimed row directly (superuser) to simulate a crashed worker. */
  async function seedClaimed(
    ctx: { workspaceId: string; mailboxId: string },
    opts: {
      claimedAgoMs: number;
      attemptCount: number;
      folder?: string | null;
    },
  ): Promise<string> {
    // Seed claimed_at from a JS Date parameter (MILLISECOND precision), exactly
    // as production writes it (claimBatch/renewLease always set claimed_at from a
    // JS Date). A DB-side `now()` would store microseconds that do not survive
    // the JS Date round-trip used to derive a fencing token, which would break a
    // token-equality CAS in a way production never sees.
    const claimedAt = new Date(Date.now() - opts.claimedAgoMs);
    const r = await admin.query<{ id: string }>(
      `insert into transport.sync_requests
         (workspace_id, mailbox_id, folder, status, claimed_at, attempt_count)
       values ($1,$2,$3,'claimed', $4, $5)
       returning id`,
      [
        ctx.workspaceId,
        ctx.mailboxId,
        opts.folder ?? null,
        claimedAt,
        opts.attemptCount,
      ],
    );
    return r.rows[0]!.id;
  }

  it("reclaims a STALE claim after the lease; never steals a FRESH claim", async () => {
    const ctx = await seedContext(admin);
    const stale = await seedClaimed(ctx, {
      claimedAgoMs: 600_000,
      attemptCount: 1,
    });
    const fresh = await seedClaimed(ctx, {
      claimedAgoMs: 10_000,
      attemptCount: 1,
      folder: "INBOX",
    });
    const repo = new SyncRequestRepository(worker);
    const now = new Date();
    const claimed = await repo.claimBatch({
      limit: 10,
      now,
      leaseCutoff: new Date(now.getTime() - 300_000),
      maxAttempts: 5,
    });
    const ids = claimed.map((r) => r.id);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(fresh);
    expect(claimed.find((r) => r.id === stale)?.attemptCount).toBe(2);
  });

  it("reaps a stale claim at max attempts to failed with a bounded content-free code", async () => {
    const ctx = await seedContext(admin);
    const exhausted = await seedClaimed(ctx, {
      claimedAgoMs: 600_000,
      attemptCount: 5,
    });
    const repo = new SyncRequestRepository(worker);
    const now = new Date();
    const reaped = await repo.reapExhausted({
      now,
      leaseCutoff: new Date(now.getTime() - 300_000),
      maxAttempts: 5,
      lastError: "attempts_exhausted",
    });
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = await repo.getById(exhausted);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("attempts_exhausted");
    expect((row?.lastError ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("markCompleted and markFailed advance from claimed only, fenced on generation+token", async () => {
    const ctx = await seedContext(admin);
    const id = await seedClaimed(ctx, { claimedAgoMs: 1000, attemptCount: 1 });
    const repo = new SyncRequestRepository(worker);
    const row = await repo.getById(id);
    const gen = row!.attemptCount;
    const token = row!.claimedAt!;
    // A WRONG generation or token cannot complete (fenced CAS).
    expect(await repo.markCompleted(id, gen + 1, token, new Date())).toBeNull();
    expect(
      await repo.markCompleted(
        id,
        gen,
        new Date(token.getTime() + 1),
        new Date(),
      ),
    ).toBeNull();
    const done = await repo.markCompleted(id, gen, token, new Date());
    expect(done?.status).toBe("completed");
    expect(done?.completedAt).not.toBeNull();
    // Idempotent: a second completion is a no-op (not claimed anymore).
    expect(await repo.markCompleted(id, gen, token, new Date())).toBeNull();

    const id2 = await seedClaimed(ctx, {
      claimedAgoMs: 1000,
      attemptCount: 1,
      folder: "INBOX",
    });
    const row2 = await repo.getById(id2);
    const failed = await repo.markFailed({
      id: id2,
      expectedGeneration: row2!.attemptCount,
      expectedToken: row2!.claimedAt!,
      now: new Date(),
      lastError: "sync_failed",
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("sync_failed");
  });
});

d(
  "durable sync_requests — two-worker reclaim RACE (generation + token fencing)",
  () => {
    let admin: pg.Pool;
    let workerA: PgDatabase;
    let workerB: PgDatabase;
    beforeAll(() => {
      admin = superuserPool();
      workerA = new PgDatabase({ connectionString: WORKER_URL });
      workerB = new PgDatabase({ connectionString: WORKER_URL });
    });
    afterAll(async () => {
      await workerA.end();
      await workerB.end();
      await admin.end();
    });

    // The core cross-generation safety proof against REAL Postgres: once a stale
    // lease is reclaimed into a new generation, the OLD generation's claimant can
    // change nothing — every fenced CAS (renew/complete/fail) loses — while the
    // new generation owns the request. The generation-scoped dispatch keys differ.
    it("a superseded generation-1 claimant can change NOTHING; generation-2 owns the request", async () => {
      const ctx = await seedContext(admin);
      const req = await requestSync(admin, ctx);
      const repoA = new SyncRequestRepository(workerA);
      const repoB = new SyncRequestRepository(workerB);

      // (1) Worker A claims the pending request -> generation g1, token t1.
      const tA = new Date();
      const claimedA = await repoA.claimBatch({
        limit: 10,
        now: tA,
        leaseCutoff: new Date(tA.getTime() - 300_000),
        maxAttempts: 5,
      });
      const rowA = claimedA.find((r) => r.id === req.id)!;
      const g1 = rowA.attemptCount;
      const t1 = rowA.claimedAt!;
      expect(g1).toBe(1);

      // (2) The lease goes stale, then Worker B reclaims -> g2 = g1+1, t2 != t1.
      await admin.query(
        `update transport.sync_requests
          set claimed_at = now() - interval '10 minutes' where id = $1`,
        [req.id],
      );
      const tB = new Date();
      const claimedB = await repoB.claimBatch({
        limit: 10,
        now: tB,
        leaseCutoff: new Date(tB.getTime() - 300_000),
        maxAttempts: 5,
      });
      const rowB = claimedB.find((r) => r.id === req.id)!;
      const g2 = rowB.attemptCount;
      const t2 = rowB.claimedAt!;
      expect(g2).toBe(g1 + 1);
      expect(t2.getTime()).not.toBe(t1.getTime());

      // Snapshot the row (owned by g2 now) before A's doomed attempts.
      const before = await repoA.getById(req.id);

      // (3) A still holds (g1, t1): EVERY fenced write loses (returns null).
      expect(await repoA.renewLease(req.id, g1, t1, new Date())).toBeNull();
      expect(await repoA.markCompleted(req.id, g1, t1, new Date())).toBeNull();
      expect(
        await repoA.markFailed({
          id: req.id,
          expectedGeneration: g1,
          expectedToken: t1,
          now: new Date(),
          lastError: "sync_failed",
        }),
      ).toBeNull();
      // A changed NOTHING: status / last_error / claimed_at are exactly as B left
      // them; the generation is still g2.
      const afterA = await repoA.getById(req.id);
      expect(afterA?.status).toBe(before?.status);
      expect(afterA?.lastError).toBe(before?.lastError);
      expect(afterA?.claimedAt?.getTime()).toBe(before?.claimedAt?.getTime());
      expect(afterA?.attemptCount).toBe(g2);

      // (4) B holds (g2, t2): renew succeeds (new token), then completes.
      const t3 = await repoB.renewLease(req.id, g2, t2, new Date());
      expect(t3).not.toBeNull();
      const done = await repoB.markCompleted(req.id, g2, t3!, new Date());
      expect(done?.status).toBe("completed");

      // (5) The generation-scoped singleton keys for g1 and g2 differ.
      expect(singletonKeys.syncRequest(req.id, g1)).toBe(
        `sync-req:${req.id}:gen:1`,
      );
      expect(singletonKeys.syncRequest(req.id, g2)).toBe(
        `sync-req:${req.id}:gen:2`,
      );
      expect(singletonKeys.syncRequest(req.id, g1)).not.toBe(
        singletonKeys.syncRequest(req.id, g2),
      );
    });
  },
);
