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
 *  - The fencing tuple (generation = attempt_count, token = claimed_at) comes
 *    from the JOB PAYLOAD (claimGeneration + claimToken) — never from a re-read
 *    of the row. Ad-hoc jobs (no syncRequestId) carry no tuple and skip all
 *    fencing exactly as before.
 *  - A fenced OWNERSHIP ASSERT (a renewLease CAS on generation+token) runs
 *    BEFORE EVERY executor batch INCLUDING THE FIRST, so a superseded claimant
 *    never opens IMAP. A lost CAS means another claimant took over (stale-lease
 *    reclaim bumped the generation and/or moved the token): the loop STOPS
 *    immediately, marks nothing, executes nothing, logs content-free
 *    `sync_lease_lost`, and returns without throwing. On success the held token
 *    advances to the returned claimed_at.
 *  - A durable request is marked completed ONLY when the executor reports
 *    needsFollowUp === false (the FINAL batch) — never after an intermediate
 *    batch of a multi-batch backlog — and markCompleted is FENCED on the held
 *    generation+token.
 *  - When the in-job batch bound is hit while needsFollowUp is still true, a
 *    fenced renewLease re-confirms ownership; if lost, the loop marks nothing and
 *    enqueues no continuation. Otherwise a CONTINUATION job is enqueued carrying
 *    the SAME syncRequestId, the SAME claimGeneration, and the current token,
 *    keyed on (request id, generation, cursor lastSeenUid). A null enqueue result
 *    is a proven-equivalent duplicate (identical work already queued) — logged
 *    `sync_continuation_dedup` and treated as success. An enqueue THROW marks
 *    nothing (the request stays 'claimed'; the lease expires and the dispatcher's
 *    stale reclaim re-drives it, bounded by attempt_count) and is re-thrown so
 *    pg-boss records the job failure.
 *  - A batch failure terminally fails the durable request ONLY on the final
 *    pg-boss attempt, FENCED on the held generation+token (so if another
 *    generation already took over it is a silent no-op — the fencing loss does
 *    NOT throw; only the original executor error is re-thrown).
 */

export interface SyncLifecycleDeps {
  executor: { execute(job: SyncJob): Promise<SyncResult> };
  syncRequests: Pick<
    SyncRequestStore,
    "renewLease" | "markCompleted" | "markFailed"
  >;
  /**
   * Enqueue a cursor-keyed continuation for a durable request (must map to
   * QueueManager.enqueueSyncContinuation — singletonKey
   * `sync-req:{id}:gen:{g}:uid:{cursorUid}`; returns null on dedup). Carries the
   * SAME claimGeneration and the current token so the continuation job stays
   * fenced within the generation.
   */
  enqueueContinuation: (
    job: SyncMailboxJob & {
      syncRequestId: string;
      cursorUid: string;
      claimGeneration: number;
      claimToken: string;
    },
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

/** The durable fencing context carried on a sync_mailbox job payload. */
interface DurableFence {
  readonly requestId: string;
  readonly generation: number;
  /** The current held token; advances on every successful renewLease. */
  token: Date;
}

type LoopOutcome =
  | { readonly kind: "lease_lost" }
  | {
      readonly kind: "done";
      readonly result: SyncResult;
      /** The current held token for a durable job; null for an ad-hoc job. */
      readonly token: Date | null;
    }
  | {
      readonly kind: "error";
      readonly error: unknown;
      /** The current held token for a durable job; null for an ad-hoc job. */
      readonly token: Date | null;
    };

/**
 * Bounded in-job batch loop. Runs the executor up to maxBatchesPerJob times
 * while needsFollowUp is true. For a durable request it asserts ownership with
 * a fenced renewLease CAS (generation + token) BEFORE EVERY batch INCLUDING THE
 * FIRST — a superseded claimant never opens IMAP. Each iteration does exactly
 * one pre-batch ownership renew, then one execute. The held token starts from
 * the job payload's claimToken and advances by each successful renewal. Executor
 * errors are captured into an `error` outcome (with the held token) so the
 * caller can fence a terminal failure against the current token.
 */
async function runBatchLoop(
  deps: SyncLifecycleDeps,
  jobData: SyncMailboxJob,
  fence: DurableFence | null,
): Promise<LoopOutcome> {
  const base = {
    workspaceId: jobData.workspaceId,
    mailboxId: jobData.mailboxId,
    folder: jobData.folder,
  };
  let batches = 0;
  for (;;) {
    // Pre-batch fenced ownership assert (durable jobs only). A lost CAS means a
    // newer generation/token took over: stop before executing (no IMAP connect).
    if (fence !== null) {
      const renewed = await deps.syncRequests.renewLease(
        fence.requestId,
        fence.generation,
        fence.token,
        deps.clock.now(),
      );
      if (renewed === null) return { kind: "lease_lost" };
      fence.token = renewed;
    }
    // The first batch uses the job's mode; subsequent batches are ALWAYS
    // incremental (the cursor advanced; an "initial" re-run would restart
    // discovery from a null cursor).
    const mode = batches === 0 ? jobData.mode : "incremental";
    let result: SyncResult;
    try {
      result = await deps.executor.execute({ ...base, mode });
    } catch (error) {
      return { kind: "error", error, token: fence?.token ?? null };
    }
    batches += 1;
    if (!result.needsFollowUp || batches >= deps.config.maxBatchesPerJob) {
      return { kind: "done", result, token: fence?.token ?? null };
    }
  }
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

  // The fencing tuple comes from the JOB PAYLOAD (never a row re-read). A
  // durable job always carries claimGeneration + claimToken together; a missing
  // tuple is a malformed durable job we cannot fence, so mark nothing and stop.
  let fence: DurableFence | null = null;
  if (requestId !== undefined) {
    const generation = jobData.claimGeneration;
    const claimToken = jobData.claimToken;
    if (generation === undefined || claimToken === undefined) {
      log.warn("sync_fence_missing", { sync_request_id: requestId });
      return;
    }
    fence = { requestId, generation, token: new Date(claimToken) };
  }

  const loop = await runBatchLoop(deps, jobData, fence);

  if (loop.kind === "error") {
    // Terminal-fail the durable request on the FINAL pg-boss attempt only,
    // FENCED on the held generation+token: if another generation already took
    // over, the CAS loses and it is a silent no-op. A fencing loss never throws;
    // only the original executor error is re-thrown so pg-boss records the job.
    if (fence !== null && loop.token !== null && attempt.finalAttempt) {
      await deps.syncRequests
        .markFailed({
          id: fence.requestId,
          expectedGeneration: fence.generation,
          expectedToken: loop.token,
          now: deps.clock.now(),
          lastError: SYNC_FAILED,
        })
        .catch(() => undefined);
    }
    throw loop.error;
  }

  if (loop.kind === "lease_lost") {
    // Another claimant holds the request now; mark NOTHING, do not throw.
    log.warn("sync_lease_lost", { sync_request_id: requestId ?? "unknown" });
    return;
  }

  const result = loop.result;
  if (!result.needsFollowUp) {
    // FINAL batch: the durable request is completed — and only now. Fenced on
    // the held generation+token; a lost CAS is a silent no-op.
    if (fence !== null && loop.token !== null) {
      await deps.syncRequests.markCompleted(
        fence.requestId,
        fence.generation,
        loop.token,
        deps.clock.now(),
      );
    }
    return;
  }

  // Bound hit with backlog remaining.
  if (fence === null) {
    // Ad-hoc job (no durable request): plain mailbox+folder follow-up.
    await enqueueSyncFollowUp({
      result,
      job: jobData,
      enqueueSync: deps.enqueueFollowUp,
      logger: deps.logger,
    });
    return;
  }

  // Re-confirm ownership with a fenced renew BEFORE enqueuing the continuation;
  // if the lease was lost, mark nothing and enqueue nothing.
  if (loop.token === null) {
    log.warn("sync_lease_lost", { sync_request_id: fence.requestId });
    return;
  }
  const renewed = await deps.syncRequests.renewLease(
    fence.requestId,
    fence.generation,
    loop.token,
    deps.clock.now(),
  );
  if (renewed === null) {
    log.warn("sync_lease_lost", { sync_request_id: fence.requestId });
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
      syncRequestId: fence.requestId,
      claimGeneration: fence.generation,
      claimToken: renewed.toISOString(),
      cursorUid,
    });
  } catch (err) {
    // Do NOT markCompleted / markFailed: the request stays 'claimed'; the
    // lease expires and the dispatcher's stale reclaim re-drives it (bounded
    // by attempt_count). Re-throw so pg-boss records the job failure — a
    // pg-boss retry of THIS job is safe: the loop is idempotent + lease-fenced.
    log.error("sync_continuation_enqueue_failed", {
      sync_request_id: fence.requestId,
      error: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
  if (continuationId === null) {
    // The key is generation-scoped in (request, generation, cursor): null PROVES
    // an identical-work continuation is already queued. Success.
    log.info("sync_continuation_dedup", {
      sync_request_id: fence.requestId,
      cursor_uid: cursorUid,
    });
  } else {
    log.info("sync_continuation_enqueued", {
      sync_request_id: fence.requestId,
      cursor_uid: cursorUid,
    });
  }
}
