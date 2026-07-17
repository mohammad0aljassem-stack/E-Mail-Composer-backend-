import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { JsonLogger } from "../../src/observability/logger.js";
import { QueueManager } from "../../src/queues/queue-manager.js";
import {
  QUEUE_NAMES,
  singletonKeys,
  type SyncMailboxJob,
} from "../../src/queues/queue-config.js";
import {
  FolderRepository,
  MessageRepository,
  SyncRequestRepository,
} from "../../src/db/repositories.js";
import { PgDatabase } from "../../src/db/pool.js";
import type { Clock } from "../../src/domain/clock.js";
import type { SyncResult } from "../../src/workers/sync-executor.js";
import {
  runSyncJob,
  type SyncLifecycleDeps,
} from "../../src/workers/sync-lifecycle.js";
import {
  HAS_DB,
  SUPERUSER_URL,
  WORKER_URL,
  seedContext,
  superuserPool,
  type SeededContext,
} from "./helpers.js";

const d = HAS_DB ? describe : describe.skip;

const BOSS_SCHEMA = "pgboss_test";

/** Durable request via the REAL SECURITY DEFINER RPC (the only insert path). */
async function requestSync(
  admin: pg.Pool,
  ctx: { workspaceId: string; mailboxId: string; userId: string },
): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, false)`,
      [ctx.userId],
    );
    const r = await client.query<{
      result: { sync_request_id: string };
    }>(`select public.request_mailbox_sync($1,$2) as result`, [
      ctx.mailboxId,
      ctx.workspaceId,
    ]);
    return r.rows[0]!.result.sync_request_id;
  } finally {
    client.release();
  }
}

/** Fixed-time clock (distinct per actor so CAS renewal values never tie). */
function fixedClock(ms: number): Clock {
  return { now: () => new Date(ms), nowMs: () => ms };
}

function silentLogger(lines?: string[]): JsonLogger {
  return new JsonLogger({
    level: "debug",
    sink: { write: (l) => lines?.push(l) },
  });
}

d("pg-boss 12.26.0 — REAL singleton semantics for sync dispatch keys", () => {
  let admin: pg.Pool;
  let queues: QueueManager;
  beforeAll(async () => {
    admin = superuserPool();
    queues = new QueueManager({
      connectionString: SUPERUSER_URL,
      schema: BOSS_SCHEMA,
      logger: silentLogger(),
    });
    await queues.start();
  });
  afterAll(async () => {
    await queues.stop();
    await admin.end();
  });

  function requestJob(
    syncRequestId: string,
  ): SyncMailboxJob & { syncRequestId: string } {
    return {
      workspaceId: "11111111-1111-1111-1111-111111111111",
      mailboxId: "22222222-2222-2222-2222-222222222222",
      folder: "INBOX",
      mode: "incremental",
      syncRequestId,
      // Fencing tuple stamped by the dispatcher (generation 1 for a fresh claim).
      claimGeneration: 1,
      claimToken: new Date(1_700_000_000_000).toISOString(),
    };
  }

  // CORE PROOF (a): boss.send returns null for a duplicate singletonKey while
  // the first job is queued — a same-key continuation would silently vanish.
  it("dedups the SAME sync-req:{id} key to null while the first job is queued", async () => {
    const requestId = randomUUID();
    const first = await queues.enqueueSyncForRequest(requestJob(requestId));
    const second = await queues.enqueueSyncForRequest(requestJob(requestId));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  // CORE PROOF (b): the cursor-distinct continuation key is accepted (non-null)
  // while the original sync-req:{id} job is ACTIVE — continuations can never
  // collide with the running dispatch job.
  it("accepts the cursor-distinct continuation key while the original job is active", async () => {
    const requestId = randomUUID();
    const original = await queues.enqueueSyncForRequest(requestJob(requestId));
    expect(original).not.toBeNull();
    // Move the original job to ACTIVE (fetch drains created-state jobs; other
    // tests' leftovers may be fetched too — we only need ours active).
    const fetched = await queues.instance.fetch<SyncMailboxJob>(
      QUEUE_NAMES.syncMailbox,
      { batchSize: 100 },
    );
    expect(fetched.some((j) => j.id === original)).toBe(true);
    const continuation = await queues.enqueueSyncContinuation({
      ...requestJob(requestId),
      cursorUid: "200",
    });
    expect(continuation).not.toBeNull();
    // The continuation payload carries the ORIGINAL durable request id.
    const r = await admin.query<{ data: SyncMailboxJob }>(
      `select data from ${BOSS_SCHEMA}.job where id = $1`,
      [continuation],
    );
    expect(r.rows[0]?.data.syncRequestId).toBe(requestId);
  });

  // CORE PROOF (c): a duplicate continuation (same request, same cursor) is
  // NULL-equivalent — exactly one job row exists for the key.
  it("dedups a duplicate continuation key K to null with exactly one job row", async () => {
    const requestId = randomUUID();
    const job = { ...requestJob(requestId), cursorUid: "400" };
    const first = await queues.enqueueSyncContinuation(job);
    const second = await queues.enqueueSyncContinuation(job);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const key = singletonKeys.syncRequestContinuation(requestId, 1, "400");
    const r = await admin.query<{ n: number }>(
      `select count(*)::int as n from ${BOSS_SCHEMA}.job where singleton_key = $1`,
      [key],
    );
    expect(r.rows[0]?.n).toBe(1);
  });
});

d(
  "durable multi-batch lifecycle — real claim -> loop -> continuation -> completion",
  () => {
    let admin: pg.Pool;
    let worker: PgDatabase;
    let queues: QueueManager;
    beforeAll(async () => {
      admin = superuserPool();
      worker = new PgDatabase({ connectionString: WORKER_URL });
      queues = new QueueManager({
        connectionString: SUPERUSER_URL,
        schema: BOSS_SCHEMA,
        logger: silentLogger(),
      });
      await queues.start();
    });
    afterAll(async () => {
      await queues.stop();
      await worker.end();
      await admin.end();
    });

    /** Persist one message (idempotent by folder,uidvalidity,uid). */
    async function persist(
      messages: MessageRepository,
      ctx: SeededContext,
      folderId: string,
      uid: bigint,
    ): Promise<void> {
      await messages.upsertMeta({
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        folderId,
        uidvalidity: 5n,
        uid,
        messageId: `<m${uid}@x>`,
        inReplyTo: null,
        referencesHeader: null,
        subject: "s",
        fromSummary: "a@x",
        toSummary: "b@x",
        internalDate: new Date(),
        sizeBytes: 42n,
        flags: [],
        hasAttachments: false,
      });
    }

    function makeDeps(input: {
      repo: SyncRequestRepository;
      /** Scripted executor; the caller owns batch numbering (shared or per-actor). */
      execute: () => Promise<SyncResult>;
      clock: Clock;
      logLines?: string[];
      maxBatchesPerJob: number;
    }): SyncLifecycleDeps {
      return {
        executor: { execute: () => input.execute() },
        syncRequests: input.repo,
        enqueueContinuation: (job) => queues.enqueueSyncContinuation(job),
        enqueueFollowUp: (job) => queues.enqueueSync(job),
        clock: input.clock,
        logger: silentLogger(input.logLines),
        config: { maxBatchesPerJob: input.maxBatchesPerJob },
      };
    }

    it("drives a 3-batch request to completion; continuations carry the request id, dedup by upsert, and consume no attempt budget", async () => {
      const ctx = await seedContext(admin);
      const folders = new FolderRepository(worker);
      const messages = new MessageRepository(worker);
      const repo = new SyncRequestRepository(worker);
      const folder = await folders.upsertDiscovered({
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        name: "INBOX",
        role: "inbox",
        uidvalidity: 5n,
        uidnext: 1n,
      });

      // Real durable request through the RPC, claimed like the dispatcher does.
      const requestId = await requestSync(admin, ctx);
      const now = new Date();
      const claimed = await repo.claimBatch({
        limit: 50,
        now,
        leaseCutoff: new Date(now.getTime() - 300_000),
        maxAttempts: 5,
      });
      const mine = claimed.find((r) => r.id === requestId);
      expect(mine).toBeDefined();

      const statuses: string[] = [];
      // Scripted batches against the REAL message store: batch 3 re-persists
      // batch 2's UIDs (crash/duplicate window) — the upsert must dedup. The
      // batch counter is SHARED across the original job and the continuation.
      let call = 0;
      const execute = async (): Promise<SyncResult> => {
        call += 1;
        const n = call;
        statuses.push((await repo.getById(requestId))!.status);
        if (n === 1) {
          await persist(messages, ctx, folder.id, 1n);
          await persist(messages, ctx, folder.id, 2n);
          return {
            persisted: 2,
            uidValidityChanged: false,
            needsFollowUp: true,
            lastSeenUid: 2n,
          };
        }
        if (n === 2) {
          await persist(messages, ctx, folder.id, 3n);
          await persist(messages, ctx, folder.id, 4n);
          return {
            persisted: 2,
            uidValidityChanged: false,
            needsFollowUp: true,
            lastSeenUid: 4n,
          };
        }
        await persist(messages, ctx, folder.id, 3n); // duplicate window
        await persist(messages, ctx, folder.id, 4n);
        return {
          persisted: 0,
          uidValidityChanged: false,
          needsFollowUp: false,
          lastSeenUid: 4n,
        };
      };

      const jobData: SyncMailboxJob = {
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        folder: "INBOX",
        mode: "initial",
        syncRequestId: requestId,
        // The fencing tuple the dispatcher would stamp: the claim's generation
        // (attempt_count) and token (claimed_at), carried on the job payload.
        claimGeneration: mine!.attemptCount,
        claimToken: mine!.claimedAt!.toISOString(),
      };
      const deps = makeDeps({
        repo,
        execute,
        clock: fixedClock(Date.now() + 1_000),
        maxBatchesPerJob: 2,
      });

      // Job 1: batches 1+2, bound hit -> continuation enqueued, NOT completed.
      await runSyncJob(deps, jobData, { finalAttempt: false });
      const midway = await repo.getById(requestId);
      expect(midway?.status).toBe("claimed"); // non-terminal after batches 1..2
      expect(midway?.completedAt).toBeNull();

      const key = singletonKeys.syncRequestContinuation(requestId, 1, "4");
      const contRow = await admin.query<{ data: SyncMailboxJob }>(
        `select data from ${BOSS_SCHEMA}.job where singleton_key = $1`,
        [key],
      );
      expect(contRow.rows).toHaveLength(1);
      // Invariant: the continuation payload carries the ORIGINAL request id.
      expect(contRow.rows[0]?.data.syncRequestId).toBe(requestId);
      expect(contRow.rows[0]?.data.mode).toBe("incremental");

      // Job 2 (the continuation, driven with its REAL persisted payload):
      // batch 3 finds no new work -> completes the durable request.
      const contDeps = makeDeps({
        repo,
        execute,
        clock: fixedClock(Date.now() + 2_000),
        maxBatchesPerJob: 2,
      });
      await runSyncJob(contDeps, contRow.rows[0]!.data, {
        finalAttempt: false,
      });

      const done = await repo.getById(requestId);
      expect(statuses).toEqual(["claimed", "claimed", "claimed"]);
      expect(done?.status).toBe("completed");
      expect(done?.completedAt).not.toBeNull();
      // Continuations bypass claimBatch: attempt_count stayed at the single claim.
      expect(done?.attemptCount).toBe(1);
      // No duplicate message rows despite the re-persisted batch (upsert dedup).
      expect(await messages.countByFolder(folder.id)).toBe(4);
    });

    it("renewLease fencing: two actors with the same token — exactly one wins; the loser's markCompleted is a no-op", async () => {
      const ctx = await seedContext(admin);
      const repoA = new SyncRequestRepository(worker);
      const repoB = new SyncRequestRepository(
        new PgDatabase({ connectionString: WORKER_URL }),
      );
      const requestId = await requestSync(admin, ctx);
      const now = new Date();
      const claimed = await repoA.claimBatch({
        limit: 50,
        now,
        leaseCutoff: new Date(now.getTime() - 300_000),
        maxAttempts: 5,
      });
      const claimedRow = claimed.find((r) => r.id === requestId)!;
      const gen = claimedRow.attemptCount;
      const token = claimedRow.claimedAt!;

      const [a, b] = await Promise.all([
        repoA.renewLease(
          requestId,
          gen,
          token,
          new Date(now.getTime() + 1_000),
        ),
        repoB.renewLease(
          requestId,
          gen,
          token,
          new Date(now.getTime() + 2_000),
        ),
      ]);
      // The CAS admits exactly one renewal for one (generation, token).
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);
      const winner = a !== null ? repoA : repoB;
      const loser = a !== null ? repoB : repoA;
      const winnerToken = (a ?? b)!; // the new claimed_at the winning renew set

      // The winner completes (fenced on its held token); the loser's late
      // completion — still holding the stale token — is a no-op.
      expect(
        await winner.markCompleted(requestId, gen, winnerToken, new Date()),
      ).not.toBeNull();
      expect(
        await loser.markCompleted(requestId, gen, token, new Date()),
      ).toBeNull();
      expect((await repoA.getById(requestId))?.status).toBe("completed");
      // A renewal never consumed attempt budget.
      expect((await repoA.getById(requestId))?.attemptCount).toBe(1);
    });

    it("lease expiry during backlog: a superseded generation-1 job is fenced out before it opens IMAP; generation 2 completes", async () => {
      const ctx = await seedContext(admin);
      const folders = new FolderRepository(worker);
      const messages = new MessageRepository(worker);
      const repo = new SyncRequestRepository(worker);
      const folder = await folders.upsertDiscovered({
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        name: "INBOX",
        role: "inbox",
        uidvalidity: 5n,
        uidnext: 1n,
      });
      const requestId = await requestSync(admin, ctx);

      // Generation 1: the first (about-to-stall) claimant.
      const t0 = new Date();
      const firstClaim = await repo.claimBatch({
        limit: 50,
        now: t0,
        leaseCutoff: new Date(t0.getTime() - 300_000),
        maxAttempts: 5,
      });
      const g1 = firstClaim.find((r) => r.id === requestId)!;
      expect(g1.attemptCount).toBe(1);

      // A continuation job from the generation-1 claimant is queued (payload
      // carries generation 1)...
      const contId = await queues.enqueueSyncContinuation({
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        folder: "INBOX",
        mode: "incremental",
        syncRequestId: requestId,
        claimGeneration: g1.attemptCount,
        claimToken: g1.claimedAt!.toISOString(),
        cursorUid: "2",
      });
      expect(contId).not.toBeNull();

      // ...then the lease expires (crash simulation) and the dispatcher path
      // reclaims into generation 2: attempt_count += 1, fresh claimed_at, and a
      // NEW generation-scoped key re-dispatch.
      await admin.query(
        `update transport.sync_requests
          set claimed_at = now() - interval '10 minutes' where id = $1`,
        [requestId],
      );
      const t1 = new Date();
      const reclaimed = await repo.claimBatch({
        limit: 50,
        now: t1,
        leaseCutoff: new Date(t1.getTime() - 300_000),
        maxAttempts: 5,
      });
      const g2 = reclaimed.find((r) => r.id === requestId)!;
      expect(g2.attemptCount).toBe(2);
      const redispatch = await queues.enqueueSyncForRequest({
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        folder: "INBOX",
        mode: "incremental",
        syncRequestId: requestId,
        claimGeneration: g2.attemptCount,
        claimToken: g2.claimedAt!.toISOString(),
      });
      expect(redispatch).not.toBeNull(); // BOTH generation keys now exist.

      // Actor A carries the generation-1 payload; Actor B the generation-2 one.
      // A's FIRST pre-batch ownership assert (renewLease CAS) fails on the
      // generation mismatch, so A stops WITHOUT executing — it never opens IMAP.
      // B owns the request: it drives the backlog to completion.
      const logsA: string[] = [];
      const logsB: string[] = [];
      let executedA = 0;
      let executedB = 0;
      const scriptedB = (): (() => Promise<SyncResult>) => {
        let n = 0;
        return async (): Promise<SyncResult> => {
          executedB += 1;
          n += 1;
          if (n === 1) {
            await persist(messages, ctx, folder.id, 1n);
            await persist(messages, ctx, folder.id, 2n);
            return {
              persisted: 2,
              uidValidityChanged: false,
              needsFollowUp: true,
              lastSeenUid: 2n,
            };
          }
          return {
            persisted: 0,
            uidValidityChanged: false,
            needsFollowUp: false,
            lastSeenUid: 2n,
          };
        };
      };
      const jobDataA: SyncMailboxJob = {
        workspaceId: ctx.workspaceId,
        mailboxId: ctx.mailboxId,
        folder: "INBOX",
        mode: "incremental",
        syncRequestId: requestId,
        claimGeneration: g1.attemptCount,
        claimToken: g1.claimedAt!.toISOString(),
      };
      const jobDataB: SyncMailboxJob = {
        ...jobDataA,
        claimGeneration: g2.attemptCount,
        claimToken: g2.claimedAt!.toISOString(),
      };
      const depsA = makeDeps({
        repo,
        execute: () => {
          executedA += 1;
          return Promise.reject(new Error("generation-1 must not execute"));
        },
        clock: fixedClock(Date.now() + 10_000),
        logLines: logsA,
        maxBatchesPerJob: 5,
      });
      const depsB = makeDeps({
        repo: new SyncRequestRepository(
          new PgDatabase({ connectionString: WORKER_URL }),
        ),
        execute: scriptedB(),
        clock: fixedClock(Date.now() + 20_000),
        logLines: logsB,
        maxBatchesPerJob: 5,
      });
      // Neither throws: the superseded actor stops silently, the owner completes.
      await Promise.all([
        runSyncJob(depsA, jobDataA, { finalAttempt: false }),
        runSyncJob(depsB, jobDataB, { finalAttempt: false }),
      ]);

      const done = await repo.getById(requestId);
      expect(done?.status).toBe("completed");
      expect(done?.completedAt).not.toBeNull();
      // The generation-1 actor was fenced out BEFORE its first batch (no IMAP).
      expect(executedA).toBe(0);
      expect(executedB).toBeGreaterThanOrEqual(1);
      expect(logsA.some((l) => l.includes("sync_lease_lost"))).toBe(true);
      expect(logsB.some((l) => l.includes("sync_lease_lost"))).toBe(false);
      // Renewals/continuations never consumed the failure budget.
      expect(done?.attemptCount).toBe(2);
      // Only generation 2 persisted the backlog — exactly once.
      expect(await messages.countByFolder(folder.id)).toBe(2);
    });
  },
);
