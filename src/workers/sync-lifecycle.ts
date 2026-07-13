import type { Clock } from "../domain/clock.js";
import type { Logger } from "../observability/logger.js";
import type { SyncRequestStore } from "../db/repository-interfaces.js";
import type { SyncMailboxJob } from "../queues/queue-config.js";
import {
  enqueueSyncFollowUp,
  type SyncJob,
  type SyncResult,
} from "./sync-executor.js";

/**
 * Durable multi-batch sync job lifecycle — the sync_mailbox handler body,
 * extracted from the worker entrypoint so the loop is directly unit-testable
 * (worker.ts stays thin registration).
 *
 * Correctness rules (see also the state diagram in sync-request-dispatcher.ts):
 *  - A durable request is marked completed ONLY when the executor reports
 *    needsFollowUp === false (the FINAL batch) — never after an intermediate
 *    batch of a multi-batch backlog.
 *  - Between batches the durable lease is RENEWED with a fenced CAS on
 *    claimed_at (SyncRequestStore.renewLease). A lost CAS means another
 *    claimant took over (stale-lease reclaim): the loop STOPS immediately,
 *    marks nothing, logs content-free `sync_lease_lost`, and returns without
 *    throwing — the other claimant owns the request now.
 *  - When the in-job batch bound is hit while needsFollowUp is still true, a
 *    CONTINUATION job is enqueued carrying the SAME syncRequestId, keyed
 *    deterministically on (request id, cursor lastSeenUid). A null enqueue
 *    result is a proven-equivalent duplicate (identical work already queued) —
 *    logged `sync_continuation_dedup` and treated as success. An enqueue THROW
 *    marks nothing (the request stays 'claimed'; the lease expires and the
 *    dispatcher's stale reclaim re-drives it, bounded by attempt_count) and is
 *    re-thrown so pg-boss records the job failure.
 *  - A batch failure terminally fails the durable request ONLY on the final
 *    pg-boss attempt (markFailed is status-guarded `claimed|pending -> failed`,
 *    so if another claimant already progressed the request it is a no-op).
 */

export interface SyncLifecycleDeps {
  executor: { execute(job: SyncJob): Promise<SyncResult> };
  syncRequests: Pick<
    SyncRequestStore,
    "getById" | "renewLease" | "markCompleted" | "markFailed"
  >;
  /**
   * Enqueue a cursor-keyed continuation for a durable request (must map to
   * QueueManager.enqueueSyncContinuation — singletonKey
   * `sync-req:{id}:uid:{cursorUid}`; returns null on dedup).
   */
  enqueueContinuation: (
    job: SyncMailboxJob & { syncRequestId: string; cursorUid: string },
  ) => Promise<string | null>;
  /**
   * Enqueue a plain mailbox+folder follow-up for an AD-HOC job (no durable
   * request): the pre-existing `sync:{mailbox}:{folder}` singleton key.
   */
  enqueueFollowUp: (job: {
    workspaceId: string;
    mailboxId: string;
    folder: string;
    mode: "incremental";
  }) => Promise<string | null>;
  clock: Clock;
  logger: Logger;
  config: {
    /** Max executor batches per job (SYNC_MAX_BATCHES_PER_JOB, >= 1). */
    maxBatchesPerJob: number;
  };
}

/** Content-free terminal code for a sync execution failure. */
const SYNC_FAILED = "sync_failed";

type LoopOutcome =
  | { readonly kind: "lease_lost" }
  | { readonly kind: "done"; readonly result: SyncResult };

/**
 * Bounded in-job batch loop. Runs the executor up to maxBatchesPerJob times
 * while needsFollowUp is true; for a durable request, renews the claimed_at
 * lease with a fenced CAS BEFORE every batch after the first. The fencing
 * token is the exact claimed_at Date read at job start (getById) and advanced
 * by each successful renewal.
 */
async function runBatchLoop(
  deps: SyncLifecycleDeps,
  jobData: SyncMailboxJob,
  requestId: string | undefined,
): Promise<LoopOutcome> {
  let leaseToken: Date | null = null;
  if (requestId !== undefined) {
    const row = await deps.syncRequests.getById(requestId);
    leaseToken = row?.claimedAt ?? null;
  }
  const base = {
    workspaceId: jobData.workspaceId,
    mailboxId: jobData.mailboxId,
    folder: jobData.folder,
  };
  let result = await deps.executor.execute({ ...base, mode: jobData.mode });
  let batches = 1;
  while (result.needsFollowUp && batches < deps.config.maxBatchesPerJob) {
    if (requestId !== undefined) {
      if (leaseToken === null) return { kind: "lease_lost" };
      const renewed = await deps.syncRequests.renewLease(
        requestId,
        leaseToken,
        deps.clock.now(),
      );
      if (renewed === null) return { kind: "lease_lost" };
      leaseToken = renewed;
    }
    // Batches after the first are ALWAYS incremental: the cursor advanced, and
    // an "initial" re-run would restart discovery from a null cursor.
    result = await deps.executor.execute({ ...base, mode: "incremental" });
    batches += 1;
  }
  return { kind: "done", result };
}

/**
 * Run one sync_mailbox job to its correct durable outcome. `finalAttempt` is
 * true when pg-boss will NOT retry this job again (retryCount >= retryLimit).
 */
export async function runSyncJob(
  deps: SyncLifecycleDeps,
  jobData: SyncMailboxJob,
  attempt: { finalAttempt: boolean },
): Promise<void> {
  const requestId = jobData.syncRequestId;
  const log = deps.logger.child({ component: "sync-lifecycle" });

  let loop: LoopOutcome;
  try {
    loop = await runBatchLoop(deps, jobData, requestId);
  } catch (err) {
    // Terminal-fail the durable request on the FINAL pg-boss attempt only, and
    // best-effort lease-guarded: markFailed advances from 'claimed'|'pending'
    // only, so a request another claimant already progressed is a no-op.
    if (requestId !== undefined && attempt.finalAttempt) {
      await deps.syncRequests
        .markFailed({
          id: requestId,
          now: deps.clock.now(),
          lastError: SYNC_FAILED,
        })
        .catch(() => undefined);
    }
    throw err;
  }

  if (loop.kind === "lease_lost") {
    // Another claimant holds the request now; mark NOTHING, do not throw.
    log.warn("sync_lease_lost", { sync_request_id: requestId ?? "unknown" });
    return;
  }

  const result = loop.result;
  if (!result.needsFollowUp) {
    // FINAL batch: the durable request is completed — and only now.
    if (requestId !== undefined) {
      await deps.syncRequests.markCompleted(requestId, deps.clock.now());
    }
    return;
  }

  // Bound hit with backlog remaining.
  if (requestId === undefined) {
    // Ad-hoc job (no durable request): plain mailbox+folder follow-up.
    await enqueueSyncFollowUp({
      result,
      job: jobData,
      enqueueSync: deps.enqueueFollowUp,
      logger: deps.logger,
    });
    return;
  }

  const cursorUid = result.lastSeenUid.toString();
  let continuationId: string | null;
  try {
    continuationId = await deps.enqueueContinuation({
      workspaceId: jobData.workspaceId,
      mailboxId: jobData.mailboxId,
      folder: jobData.folder,
      mode: "incremental",
      syncRequestId: requestId,
      cursorUid,
    });
  } catch (err) {
    // Do NOT markCompleted / markFailed: the request stays 'claimed'; the
    // lease expires and the dispatcher's stale reclaim re-drives it (bounded
    // by attempt_count). Re-throw so pg-boss records the job failure — a
    // pg-boss retry of THIS job is safe: the loop is idempotent + lease-fenced.
    log.error("sync_continuation_enqueue_failed", {
      sync_request_id: requestId,
      error: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
  if (continuationId === null) {
    // The key is deterministic in (request, cursor): null PROVES an
    // identical-work continuation is already queued. Success.
    log.info("sync_continuation_dedup", {
      sync_request_id: requestId,
      cursor_uid: cursorUid,
    });
  } else {
    log.info("sync_continuation_enqueued", {
      sync_request_id: requestId,
      cursor_uid: cursorUid,
    });
  }
}
