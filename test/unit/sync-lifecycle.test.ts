import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { singletonKeys } from "../../src/queues/queue-config.js";
import type { SyncMailboxJob } from "../../src/queues/queue-config.js";
import type { SyncJob, SyncResult } from "../../src/workers/sync-executor.js";
import {
  runSyncJob,
  type SyncLifecycleDeps,
} from "../../src/workers/sync-lifecycle.js";
import { FakeSyncRequestRepo } from "../fakes/in-memory-repos.js";
import { TestClock } from "../helpers/test-clock.js";

const WS = "11111111-1111-1111-1111-111111111111";
const MB = "22222222-2222-2222-2222-222222222222";

/** A batch script entry: what the executor returns for that call. */
type Batch = SyncResult | Error;

function batch(needsFollowUp: boolean, lastSeenUid: bigint): SyncResult {
  return {
    persisted: needsFollowUp ? 1 : 0,
    uidValidityChanged: false,
    needsFollowUp,
    lastSeenUid,
  };
}

interface Continuation {
  job: SyncMailboxJob & { syncRequestId: string; cursorUid: string };
  key: string;
}

interface Harness {
  deps: SyncLifecycleDeps;
  syncRequests: FakeSyncRequestRepo;
  clock: TestClock;
  executed: SyncJob[];
  continuations: Continuation[];
  followUps: unknown[];
  logLines: string[];
  /** Hook invoked before each executor batch (1-based index). */
  onBatch: (n: number) => void | Promise<void>;
}

function makeHarness(options: {
  batches: Batch[];
  maxBatchesPerJob?: number;
  continuationResult?: string | null | Error;
}): Harness {
  const syncRequests = new FakeSyncRequestRepo();
  const clock = new TestClock();
  const executed: SyncJob[] = [];
  const continuations: Continuation[] = [];
  const followUps: unknown[] = [];
  const logLines: string[] = [];
  const logger = new JsonLogger({
    level: "debug",
    sink: { write: (l) => logLines.push(l) },
  });
  const h: Harness = {
    deps: {
      executor: {
        execute: async (job: SyncJob): Promise<SyncResult> => {
          executed.push(job);
          await h.onBatch(executed.length);
          const scripted = options.batches[executed.length - 1];
          if (scripted === undefined) {
            throw new Error("executor called beyond the scripted batches");
          }
          if (scripted instanceof Error) throw scripted;
          return scripted;
        },
      },
      syncRequests,
      enqueueContinuation: (job) => {
        const outcome = options.continuationResult;
        if (outcome instanceof Error) return Promise.reject(outcome);
        continuations.push({
          job,
          key: singletonKeys.syncRequestContinuation(
            job.syncRequestId,
            job.cursorUid,
          ),
        });
        return Promise.resolve(outcome === undefined ? "job-1" : outcome);
      },
      enqueueFollowUp: (job) => {
        followUps.push(job);
        return Promise.resolve("follow-up-1");
      },
      clock,
      logger,
      config: { maxBatchesPerJob: options.maxBatchesPerJob ?? 10 },
    },
    syncRequests,
    clock,
    executed,
    continuations,
    followUps,
    logLines,
    onBatch: () => undefined,
  };
  return h;
}

/** Seed a claimed durable request (as the dispatcher leaves it) + job data. */
function claimedRequest(h: Harness): {
  id: string;
  jobData: SyncMailboxJob;
} {
  const row = h.syncRequests.seed({
    workspaceId: WS,
    mailboxId: MB,
    folder: "INBOX",
    status: "claimed",
    claimedAt: h.clock.now(),
    attemptCount: 1,
  });
  return {
    id: row.id,
    jobData: {
      workspaceId: WS,
      mailboxId: MB,
      folder: "INBOX",
      mode: "incremental",
      syncRequestId: row.id,
    },
  };
}

describe("runSyncJob — durable multi-batch loop", () => {
  it("completes a 3-batch request ONLY after the final batch (non-terminal in between)", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(true, 400n), batch(false, 450n)],
    });
    const { id, jobData } = claimedRequest(h);
    const statusAtBatch: string[] = [];
    h.onBatch = async () => {
      statusAtBatch.push((await h.syncRequests.getById(id))!.status);
    };
    await runSyncJob(h.deps, jobData, { finalAttempt: false });
    // Non-terminal (still claimed) while batches 1..3 were running.
    expect(statusAtBatch).toEqual(["claimed", "claimed", "claimed"]);
    expect(h.executed).toHaveLength(3);
    const after = await h.syncRequests.getById(id);
    expect(after?.status).toBe("completed");
    expect(after?.completedAt).not.toBeNull();
    // The in-job loop needed no continuation and no plain follow-up.
    expect(h.continuations).toHaveLength(0);
    expect(h.followUps).toHaveLength(0);
    // attempt_count untouched by loop batches + renewals (claims only).
    expect(after?.attemptCount).toBe(1);
  });

  it("renews the lease between batches (claimed_at advances via the CAS)", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(false, 300n)],
    });
    const { id, jobData } = claimedRequest(h);
    const claimedAt0 = (await h.syncRequests.getById(id))!.claimedAt!;
    h.onBatch = () => h.clock.advance(60_000);
    await runSyncJob(h.deps, jobData, { finalAttempt: false });
    const after = await h.syncRequests.getById(id);
    expect(after?.status).toBe("completed");
    // claimed_at moved forward: the renewal ran with the fetched token.
    expect(after!.claimedAt!.getTime()).toBeGreaterThan(claimedAt0.getTime());
  });

  it("runs subsequent batches as incremental even for an initial-mode job", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(false, 210n)],
    });
    const { jobData } = claimedRequest(h);
    await runSyncJob(
      h.deps,
      { ...jobData, mode: "initial" },
      { finalAttempt: false },
    );
    expect(h.executed.map((j) => j.mode)).toEqual(["initial", "incremental"]);
  });
});

describe("runSyncJob — bound hit -> cursor-keyed continuation", () => {
  it("enqueues a continuation with the SAME syncRequestId and the cursor key; request stays claimed", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(true, 400n)],
      maxBatchesPerJob: 2,
    });
    const { id, jobData } = claimedRequest(h);
    await runSyncJob(h.deps, jobData, { finalAttempt: false });
    expect(h.executed).toHaveLength(2); // the bound
    expect(h.continuations).toHaveLength(1);
    const cont = h.continuations[0]!;
    // Invariant: every continuation carries the ORIGINAL durable request id.
    expect(cont.job.syncRequestId).toBe(id);
    expect(cont.job.mode).toBe("incremental");
    // Cursor-distinct deterministic key (never the original sync-req:{id}).
    expect(cont.job.cursorUid).toBe("400");
    expect(cont.key).toBe(`sync-req:${id}:uid:400`);
    expect(cont.key).not.toBe(singletonKeys.syncRequest(id));
    // NOT completed — the continuation owns the remaining backlog.
    const after = await h.syncRequests.getById(id);
    expect(after?.status).toBe("claimed");
    expect(after?.completedAt).toBeNull();
    expect(h.followUps).toHaveLength(0);
  });

  it("a null enqueue result is a logged, proven-equivalent dedup (no completion, no throw)", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n)],
      maxBatchesPerJob: 1,
      continuationResult: null,
    });
    const { id, jobData } = claimedRequest(h);
    await runSyncJob(h.deps, jobData, { finalAttempt: false }); // resolves
    expect((await h.syncRequests.getById(id))?.status).toBe("claimed");
    const line = h.logLines.find((l) => l.includes("sync_continuation_dedup"));
    expect(line).toBeDefined();
    expect(line).toContain(id);
    expect(line).toContain('"cursor_uid":"200"');
  });

  it("a continuation enqueue THROW leaves the request claimed and propagates (no markCompleted/markFailed)", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n)],
      maxBatchesPerJob: 1,
      continuationResult: new Error("boss down"),
    });
    const { id, jobData } = claimedRequest(h);
    await expect(
      runSyncJob(h.deps, jobData, { finalAttempt: false }),
    ).rejects.toThrow("boss down");
    const after = await h.syncRequests.getById(id);
    // Stays 'claimed': the lease expires and the dispatcher reclaim re-drives.
    expect(after?.status).toBe("claimed");
    expect(after?.completedAt).toBeNull();
    expect(after?.lastError).toBeNull();
    expect(
      h.logLines.some((l) => l.includes("sync_continuation_enqueue_failed")),
    ).toBe(true);
  });
});

describe("runSyncJob — lease fencing (single effective claimant)", () => {
  it("stops without marking or throwing when the lease is lost mid-loop", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(true, 400n), batch(false, 500n)],
    });
    const { id, jobData } = claimedRequest(h);
    // After batch 1, another claimant re-claims (claimed_at moves).
    h.onBatch = (n) => {
      if (n === 1) {
        const row = h.syncRequests.rows.get(id)!;
        h.syncRequests.rows.set(id, {
          ...row,
          claimedAt: new Date(h.clock.nowMs() + 1),
          attemptCount: row.attemptCount + 1,
        });
      }
    };
    await runSyncJob(h.deps, jobData, { finalAttempt: false }); // must NOT throw
    // The loop stopped after the failed renewal: batch 2 never ran.
    expect(h.executed).toHaveLength(1);
    const after = await h.syncRequests.getById(id);
    expect(after?.status).toBe("claimed"); // the other claimant owns it now
    expect(after?.completedAt).toBeNull();
    expect(h.continuations).toHaveLength(0);
    expect(h.logLines.some((l) => l.includes("sync_lease_lost"))).toBe(true);
  });

  it("renewLease CAS: only one of two same-token renewals wins (fake mirrors the SQL)", async () => {
    const repo = new FakeSyncRequestRepo();
    const clock = new TestClock();
    const row = repo.seed({
      workspaceId: WS,
      mailboxId: MB,
      status: "claimed",
      claimedAt: clock.now(),
      attemptCount: 1,
    });
    const token = row.claimedAt!;
    const a = await repo.renewLease(row.id, token, new Date(clock.nowMs() + 1));
    const b = await repo.renewLease(row.id, token, new Date(clock.nowMs() + 2));
    expect(a).not.toBeNull();
    expect(b).toBeNull(); // the loser's token is stale
    // A renewal never touches attempt_count and never changes status.
    const after = await repo.getById(row.id);
    expect(after?.attemptCount).toBe(1);
    expect(after?.status).toBe("claimed");
  });
});

describe("runSyncJob — failure semantics", () => {
  it("a batch failure on a NON-final attempt keeps the request claimed and rethrows", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), new Error("imap transient")],
    });
    const { id, jobData } = claimedRequest(h);
    await expect(
      runSyncJob(h.deps, jobData, { finalAttempt: false }),
    ).rejects.toThrow("imap transient");
    const after = await h.syncRequests.getById(id);
    // No false completion, no premature terminal failure.
    expect(after?.status).toBe("claimed");
    expect(after?.completedAt).toBeNull();
  });

  it("a batch failure on the FINAL attempt marks the request failed (content-free code)", async () => {
    const h = makeHarness({ batches: [new Error("imap down")] });
    const { id, jobData } = claimedRequest(h);
    await expect(
      runSyncJob(h.deps, jobData, { finalAttempt: true }),
    ).rejects.toThrow("imap down");
    const after = await h.syncRequests.getById(id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("sync_failed");
  });

  it("markFailed is a no-op when another claimant already progressed the request", async () => {
    const h = makeHarness({ batches: [new Error("imap down")] });
    const { id, jobData } = claimedRequest(h);
    // The other claimant completed it while our (stale) job was failing.
    h.onBatch = async () => {
      await h.syncRequests.markCompleted(id, h.clock.now());
    };
    await expect(
      runSyncJob(h.deps, jobData, { finalAttempt: true }),
    ).rejects.toThrow("imap down");
    // Status guard: completed is terminal — the failure did not overwrite it.
    expect((await h.syncRequests.getById(id))?.status).toBe("completed");
  });
});

describe("runSyncJob — ad-hoc jobs (no durable request)", () => {
  const adHoc: SyncMailboxJob = {
    workspaceId: WS,
    mailboxId: MB,
    folder: "INBOX",
    mode: "incremental",
  };

  it("loops in-job and enqueues a plain mailbox+folder follow-up at the bound", async () => {
    const h = makeHarness({
      batches: [batch(true, 200n), batch(true, 400n)],
      maxBatchesPerJob: 2,
    });
    await runSyncJob(h.deps, adHoc, { finalAttempt: false });
    expect(h.executed).toHaveLength(2);
    expect(h.continuations).toHaveLength(0); // continuation is durable-only
    expect(h.followUps).toEqual([
      { workspaceId: WS, mailboxId: MB, folder: "INBOX", mode: "incremental" },
    ]);
  });

  it("never touches the sync-request store for an ad-hoc job", async () => {
    const h = makeHarness({ batches: [batch(false, 5n)] });
    await runSyncJob(h.deps, adHoc, { finalAttempt: true });
    expect(h.syncRequests.rows.size).toBe(0);
    expect(h.followUps).toHaveLength(0);
  });
});
