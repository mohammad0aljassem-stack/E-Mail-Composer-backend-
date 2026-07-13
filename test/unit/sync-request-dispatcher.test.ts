import { beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  SyncRequestDispatcher,
  type SyncRequestDispatcherDeps,
} from "../../src/workers/sync-request-dispatcher.js";
import type { SyncMailboxJob } from "../../src/queues/queue-config.js";
import { singletonKeys } from "../../src/queues/queue-config.js";
import {
  FakeMailboxRepo,
  FakeSyncRequestRepo,
} from "../fakes/in-memory-repos.js";
import { sendableMailbox } from "../helpers/send-fixtures.js";
import { TestClock } from "../helpers/test-clock.js";

const WS = "11111111-1111-1111-1111-111111111111";
const MB = "22222222-2222-2222-2222-222222222222";

interface Enq {
  job: SyncMailboxJob & { syncRequestId: string };
  key: string;
}

interface Harness {
  dispatcher: SyncRequestDispatcher;
  syncRequests: FakeSyncRequestRepo;
  mailboxes: FakeMailboxRepo;
  clock: TestClock;
  enqueued: Enq[];
  logLines: string[];
}

function makeHarness(overrides?: {
  transportEnabled?: boolean;
  globalKillSwitch?: boolean;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  mailbox?: Parameters<typeof sendableMailbox>[0];
}): Harness {
  const syncRequests = new FakeSyncRequestRepo();
  const mailboxes = new FakeMailboxRepo();
  mailboxes.rows.set(MB, sendableMailbox({ id: MB, ...overrides?.mailbox }));
  const clock = new TestClock();
  const enqueued: Enq[] = [];
  const logLines: string[] = [];
  const logger = new JsonLogger({
    level: "debug",
    sink: { write: (l) => logLines.push(l) },
  });
  const deps: SyncRequestDispatcherDeps = {
    syncRequests,
    mailboxes,
    enqueueSync: (job) => {
      enqueued.push({ job, key: singletonKeys.syncRequest(job.syncRequestId) });
      return Promise.resolve(`job-${enqueued.length}`);
    },
    clock,
    logger,
    config: {
      transportEnabled: overrides?.transportEnabled ?? true,
      globalKillSwitch: overrides?.globalKillSwitch ?? false,
      batchSize: overrides?.batchSize ?? 10,
      leaseMs: overrides?.leaseMs ?? 300_000,
      maxAttempts: overrides?.maxAttempts ?? 5,
    },
  };
  return {
    dispatcher: new SyncRequestDispatcher(deps),
    syncRequests,
    mailboxes,
    clock,
    enqueued,
    logLines,
  };
}

describe("SyncRequestDispatcher — claim + dispatch", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  // Claim-once: a pending row is claimed exactly once and enqueued once.
  it("claims a pending request once and enqueues one job", async () => {
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.claimed).toBe(1);
    expect(summary.enqueued).toBe(1);
    const after = await h.syncRequests.getById(row.id);
    expect(after?.status).toBe("claimed");
    expect(after?.attemptCount).toBe(1);
    expect(after?.claimedAt).not.toBeNull();
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]?.job.syncRequestId).toBe(row.id);
  });

  // A second pass finds nothing to claim (already claimed, still fresh).
  it("does not re-claim a fresh claim (claim-once across passes)", async () => {
    h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    await h.dispatcher.dispatchOnce();
    const second = await h.dispatcher.dispatchOnce();
    expect(second.claimed).toBe(0);
    expect(h.enqueued).toHaveLength(1);
  });

  // Dedup: re-dispatch of the same durable request uses a DETERMINISTIC key.
  it("derives a deterministic pg-boss key from the durable request id", async () => {
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    await h.dispatcher.dispatchOnce();
    // Force a stale reclaim so it dispatches a second time.
    h.clock.advance(400_000);
    await h.dispatcher.dispatchOnce();
    expect(h.enqueued).toHaveLength(2);
    expect(h.enqueued[0]?.key).toBe(h.enqueued[1]?.key);
    expect(h.enqueued[0]?.key).toBe(`sync-req:${row.id}`);
  });

  // Whole-mailbox (folder null) vs folder-scoped are distinct rows/jobs/modes.
  it("distinguishes whole-mailbox from folder-scoped requests", async () => {
    const whole = h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      folder: null,
      requestedAt: new Date(1),
    });
    const scoped = h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      folder: "INBOX",
      requestedAt: new Date(2),
    });
    await h.dispatcher.dispatchOnce();
    expect(h.enqueued).toHaveLength(2);
    const byId = new Map(h.enqueued.map((e) => [e.job.syncRequestId, e.job]));
    expect(byId.get(whole.id)?.mode).toBe("initial");
    expect(byId.get(whole.id)?.folder).toBe("INBOX");
    expect(byId.get(scoped.id)?.mode).toBe("incremental");
    expect(byId.get(scoped.id)?.folder).toBe("INBOX");
    // Distinct deterministic keys.
    expect(new Set(h.enqueued.map((e) => e.key)).size).toBe(2);
  });

  // Fairness: FIFO by requested_at; each job carries its own workspace (pg-boss
  // group = workspace preserves per-workspace fair concurrency downstream).
  it("claims FIFO by requested_at and preserves workspace on each job", async () => {
    const wsB = "33333333-3333-3333-3333-333333333333";
    h.mailboxes.rows.set(
      "mb-b",
      sendableMailbox({ id: "mb-b", workspaceId: wsB }),
    );
    h.syncRequests.seed({
      workspaceId: wsB,
      mailboxId: "mb-b",
      requestedAt: new Date(100),
    });
    h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      requestedAt: new Date(50),
    });
    await h.dispatcher.dispatchOnce();
    expect(h.enqueued[0]?.job.workspaceId).toBe(WS); // earliest first
    expect(h.enqueued[1]?.job.workspaceId).toBe(wsB);
  });
});

describe("SyncRequestDispatcher — crash recovery + lease", () => {
  // Crash-after-claim: a stale claim past the lease is reclaimable (recovery).
  it("reclaims a stale claim after the lease and bumps attempt_count", async () => {
    const h = makeHarness({ leaseMs: 300_000 });
    const row = h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      status: "claimed",
      claimedAt: new Date(h.clock.nowMs() - 400_000), // older than lease
      attemptCount: 1,
    });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.claimed).toBe(1);
    const after = await h.syncRequests.getById(row.id);
    expect(after?.attemptCount).toBe(2);
    expect(h.enqueued).toHaveLength(1);
  });

  // A FRESH claim (recent claimed_at) is never stolen by another pass.
  it("never steals a fresh claim", async () => {
    const h = makeHarness({ leaseMs: 300_000 });
    h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      status: "claimed",
      claimedAt: new Date(h.clock.nowMs() - 10_000), // well within the lease
      attemptCount: 1,
    });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.claimed).toBe(0);
    expect(h.enqueued).toHaveLength(0);
  });

  // attempt_count is bounded: a stale claim at the cap is failed, not reclaimed.
  it("reaps a stale claim at max attempts to failed (bounded), never re-dispatches", async () => {
    const h = makeHarness({ leaseMs: 300_000, maxAttempts: 5 });
    const row = h.syncRequests.seed({
      workspaceId: WS,
      mailboxId: MB,
      status: "claimed",
      claimedAt: new Date(h.clock.nowMs() - 400_000),
      attemptCount: 5,
    });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.reaped).toBe(1);
    expect(summary.claimed).toBe(0);
    const after = await h.syncRequests.getById(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("attempts_exhausted");
    expect(h.enqueued).toHaveLength(0);
  });
});

describe("SyncRequestDispatcher — terminal state + content-free errors", () => {
  it("marks a request completed after the sync completes", async () => {
    const h = makeHarness();
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    await h.dispatcher.dispatchOnce(); // -> claimed
    await h.dispatcher.markCompleted(row.id);
    const after = await h.syncRequests.getById(row.id);
    expect(after?.status).toBe("completed");
    expect(after?.completedAt).not.toBeNull();
  });

  it("stores only a bounded, content-free last_error", async () => {
    const h = makeHarness();
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    await h.dispatcher.dispatchOnce();
    // Even if a caller passes a long/sensitive string, it is bounded + code-only.
    await h.dispatcher.markFailed(row.id, "x".repeat(5000));
    const after = await h.syncRequests.getById(row.id);
    expect(after?.status).toBe("failed");
    expect((after?.lastError ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("SyncRequestDispatcher — kill switches + flag", () => {
  // Flag off: NO dispatcher activity at all (no claim, no enqueue, no IMAP/SMTP).
  it("is a no-op when MAIL_TRANSPORT_V1_ENABLED is false", async () => {
    const h = makeHarness({ transportEnabled: false });
    h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary).toEqual({ claimed: 0, enqueued: 0, blocked: 0, reaped: 0 });
    expect(h.enqueued).toHaveLength(0);
  });

  // Global kill switch: claim nothing, enqueue nothing.
  it("claims nothing when the global kill switch is engaged", async () => {
    const h = makeHarness({ globalKillSwitch: true });
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    await h.dispatcher.dispatchOnce();
    expect(h.enqueued).toHaveLength(0);
    expect((await h.syncRequests.getById(row.id))?.status).toBe("pending");
  });

  // Mailbox kill switch: the claimed request is failed content-free, NOT enqueued.
  it("blocks (fails, no enqueue) a request whose mailbox kill switch is engaged", async () => {
    const h = makeHarness({ mailbox: { killSwitch: true } });
    const row = h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.blocked).toBe(1);
    expect(summary.enqueued).toBe(0);
    const after = await h.syncRequests.getById(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("mailbox_unsyncable");
    expect(h.enqueued).toHaveLength(0);
  });

  it("blocks a request for a disabled mailbox", async () => {
    const h = makeHarness({ mailbox: { enabled: false } });
    h.syncRequests.seed({ workspaceId: WS, mailboxId: MB });
    const summary = await h.dispatcher.dispatchOnce();
    expect(summary.blocked).toBe(1);
    expect(h.enqueued).toHaveLength(0);
  });
});
