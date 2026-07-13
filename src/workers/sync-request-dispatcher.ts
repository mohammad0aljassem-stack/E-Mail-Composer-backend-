import type { Clock } from "../domain/clock.js";
import type { MailboxRow, SyncRequestRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type {
  MailboxReader,
  SyncRequestStore,
  WorkerClaimStore,
} from "../db/repository-interfaces.js";
import type { SyncMailboxJob } from "../queues/queue-config.js";

/**
 * Durable sync-request consumer / dispatcher (transport.sync_requests).
 *
 * The browser-facing SECURITY DEFINER RPC `request_mailbox_sync` INSERTs a
 * durable, deduped, claimable row (the worker has SELECT + UPDATE only — never
 * INSERT/DELETE). This dispatcher is the ONLY consumer: it atomically claims
 * pending / stale-reclaimable rows and enqueues a `sync_mailbox` pg-boss job
 * with a DETERMINISTIC key derived from the durable request id. It never polls
 * transport_audit (that is not a queue) and never creates pg-boss jobs from SQL.
 *
 * STATE DIAGRAM (durable row):
 *
 *   pending --claimBatch--> claimed --final batch (needsFollowUp=false)--> completed
 *      ^                     |  ^ \
 *      |                     |  |  \--terminal fail (final pg-boss attempt)
 *      (RPC insert only)     |  |      or reapExhausted / unsyncable--> failed
 *                            |  |
 *                            |  renewLease CAS (in-job, between batches)
 *                            |  and cursor-keyed CONTINUATION jobs — the row
 *                            |  STAYS 'claimed' across both (no state change,
 *                            |  no attempt_count change)
 *                            |
 *                            stale lease (claimed_at < now - leaseMs)
 *                            --claimBatch reclaim (attempt_count += 1)--> claimed
 *
 *   * A claim is a single atomic statement (see SyncRequestStore.claimBatch):
 *     `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`.
 *     Exactly one worker claims any one row; two-worker races resolve to one.
 *   * On claim: status='claimed', claimed_at=now(), attempt_count += 1.
 *     attempt_count increments ONLY on a durable (re)claim — never per pg-boss
 *     retry, never per lease renewal, never per continuation job.
 *   * completed_at is set only when markCompleted runs (claimed -> completed;
 *     status-guarded, so completion is monotonic and terminal). claimed_at is
 *     written on every claim and renewed by every in-job renewLease CAS; it is
 *     intentionally NOT nulled on completion/failure (last-claim timestamp,
 *     retained for audit).
 *
 * IN-JOB BATCH LOOP + LEASE RENEWAL FENCING (see workers/sync-lifecycle.ts):
 *   The sync_mailbox handler runs up to SYNC_MAX_BATCHES_PER_JOB executor
 *   batches inside ONE job. Between batches it renews the durable lease with a
 *   fenced CAS: `UPDATE ... SET claimed_at=now WHERE id AND status='claimed'
 *   AND claimed_at=<the exact Date the claimant holds>`. The claimed_at value
 *   is the fencing token — a reclaim moves it, so a stale claimant's next CAS
 *   fails (null) and it stops WITHOUT marking anything. At most one claimant
 *   is ever effective, with no schema change.
 *
 * CONTINUATION KEY (multi-batch backlog beyond the in-job bound):
 *   When the bound is hit while needsFollowUp is still true, the handler
 *   enqueues a continuation job that carries the SAME syncRequestId (every
 *   continuation stays associated with the original durable request) under
 *   singletonKey `sync-req:{id}:uid:{cursorUid}` (cursorUid = the folder
 *   cursor's lastSeenUid after the last completed batch). The key is
 *   cursor-distinct: it can NEVER collide with the original `sync-req:{id}`
 *   dispatch key, and a crash-recovery duplicate of the same continuation
 *   produces the SAME key.
 *
 * NULL-ENQUEUE BEHAVIOR (pg-boss singleton semantics):
 *   boss.send returns null when a job with the same singletonKey is already
 *   queued. For the deterministic keys above, null therefore PROVES an
 *   identical-work job already exists: dispatch treats it as dispatched, and
 *   the continuation path logs content-free `sync_continuation_dedup` and
 *   treats it as success. An enqueue THROW (not null) marks nothing — the
 *   request stays 'claimed' and the stale-lease reclaim re-drives it.
 *
 * CRASH WINDOWS (each is safe):
 *   * Before/during the first batch: nothing (or a partial batch) persisted,
 *     cursor NOT advanced past durable rows. Lease expires -> reclaim
 *     (attempt_count+1) -> re-run. The (folder,uidvalidity,uid) upsert is
 *     idempotent, so re-fetched messages never duplicate.
 *   * Mid-loop after a batch persisted (cursor advanced, before/after a
 *     renewal): request stays 'claimed'; reclaim re-runs incrementally from
 *     the monotonic cursor — no loss, no duplicates.
 *   * After the continuation enqueue, before the job acks: a pg-boss retry (or
 *     a reclaim) re-runs the loop idempotently and re-enqueues the SAME
 *     cursor-distinct key -> null -> dedup. No lost work, no duplicate job.
 *   * After the final batch, before markCompleted: request stays 'claimed';
 *     reclaim re-runs one incremental batch that finds nothing new
 *     (needsFollowUp=false) -> markCompleted. Bounded by attempt_count.
 *
 * DUPLICATE DISPATCH:
 *   A reclaim re-enqueues under the original deterministic `sync-req:{id}` key;
 *   while a queued (created-state) job holds that key the re-enqueue dedups to
 *   null. If a reclaimed dispatch job and a still-running (or continuation)
 *   job momentarily coexist, the renewLease CAS guarantees only ONE of them
 *   remains effective — the loser stops without marking anything.
 *
 * MAX ATTEMPTS + interaction with sync_mailbox.retryLimit=5:
 *   Two INDEPENDENT layers that MUST NOT multiply into an undocumented count:
 *     - pg-boss retryLimit=5 retries the *executed job* for transient IMAP
 *       errors WITHIN a single durable claim. These do NOT touch attempt_count.
 *     - the durable attempt_count bounds *re-dispatch* (crash / lease expiry).
 *   Continuation jobs bypass claimBatch entirely (the request stays 'claimed';
 *   they renew the lease via the CAS using the claimed_at they read at start),
 *   so continuations NEVER consume the failure budget: attempt_count grows
 *   only via dispatcher reclaims (crash / lease expiry) — bounded as before.
 *   In the absence of crashes a request is claimed ONCE and enqueued ONCE, so
 *   the execution count is bounded by 5 (pg-boss) — not maxAttempts × 5. A clean
 *   job failure is terminal (markFailed -> 'failed'); it is NOT re-dispatched.
 *   Durable re-claim happens ONLY when a claim went stale without a terminal
 *   result. `reapExhausted` moves a stale claim whose attempt_count has reached
 *   maxAttempts to 'failed' with a bounded, content-free code — the hard cap.
 *
 * SAFETY:
 *   * Runs ONLY when MAIL_TRANSPORT_V1_ENABLED=true. With the flag off,
 *     dispatchOnce is a no-op: it never claims, never enqueues, never connects.
 *   * The global kill switch and per-mailbox kill switch / disabled flag are
 *     respected: a claimed request for a non-syncable mailbox is marked failed
 *     with a content-free code and NO sync job is enqueued (no IMAP connect).
 *   * last_error carries only a short bounded code — never a body, MIME,
 *     credential, raw provider response, attachment, or connection string.
 */

export interface SyncRequestDispatcherDeps {
  syncRequests: SyncRequestStore;
  mailboxes: MailboxReader;
  /**
   * Send worker-claim store: each dispatch pass expires stale send-claim
   * leases (a crashed worker's claim must not block re-driving a queued
   * attempt forever). Expiry only removes the expired lease row — it never
   * re-enqueues or re-sends anything; the attempt still needs its normal
   * claim + state flow, and smtp_in_progress restarts still go to
   * needs_human_review.
   */
  sendClaims: WorkerClaimStore;
  /** Enqueue a durable-request sync job (deterministic key on the request id). */
  enqueueSync: (
    job: SyncMailboxJob & { syncRequestId: string },
  ) => Promise<string | null>;
  clock: Clock;
  logger: Logger;
  config: {
    transportEnabled: boolean;
    globalKillSwitch: boolean;
    /** Max requests claimed per pass (a fairness / batch bound). */
    batchSize: number;
    /** Stale-claim lease timeout in ms. */
    leaseMs: number;
    /** Hard cap on durable re-claims before a stale request is failed. */
    maxAttempts: number;
  };
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly enqueued: number;
  readonly blocked: number;
  readonly reaped: number;
}

/** Content-free, bounded terminal codes. */
const CODE = {
  mailboxUnsyncable: "mailbox_unsyncable",
  attemptsExhausted: "attempts_exhausted",
} as const;

export class SyncRequestDispatcher {
  public constructor(private readonly deps: SyncRequestDispatcherDeps) {}

  /**
   * One dispatch pass: reap exhausted stale claims, claim a bounded batch, and
   * enqueue a deterministic sync job per claimable request. Idempotent and safe
   * to call on an interval or on an IDLE wakeup.
   */
  public async dispatchOnce(): Promise<DispatchSummary> {
    const empty: DispatchSummary = {
      claimed: 0,
      enqueued: 0,
      blocked: 0,
      reaped: 0,
    };
    // Fail-closed: never touch the DB / a provider when transport is disabled or
    // the global kill switch is engaged.
    if (!this.deps.config.transportEnabled) return empty;
    if (this.deps.config.globalKillSwitch) return empty;

    const now = this.deps.clock.now();
    const leaseCutoff = new Date(
      this.deps.clock.nowMs() - this.deps.config.leaseMs,
    );

    // Expire stale SEND claim leases (crashed worker recovery). Removal only —
    // no re-enqueue, no auto-resend; content-free count when anything expired.
    const expiredSendClaims = await this.deps.sendClaims.expireStale(now);
    if (expiredSendClaims > 0) {
      this.deps.logger.warn("stale_send_claims_expired", {
        count: expiredSendClaims,
      });
    }

    const reaped = await this.deps.syncRequests.reapExhausted({
      now,
      leaseCutoff,
      maxAttempts: this.deps.config.maxAttempts,
      lastError: CODE.attemptsExhausted,
    });

    const claimedRows = await this.deps.syncRequests.claimBatch({
      limit: this.deps.config.batchSize,
      now,
      leaseCutoff,
      maxAttempts: this.deps.config.maxAttempts,
    });

    let enqueued = 0;
    let blocked = 0;
    for (const row of claimedRows) {
      const dispatched = await this.dispatchClaimed(row, now);
      if (dispatched) enqueued += 1;
      else blocked += 1;
    }

    if (claimedRows.length > 0 || reaped > 0) {
      this.deps.logger.info("sync_dispatch_pass", {
        claimed: claimedRows.length,
        enqueued,
        blocked,
        reaped,
      });
    }
    return { claimed: claimedRows.length, enqueued, blocked, reaped };
  }

  private async dispatchClaimed(
    row: SyncRequestRow,
    now: Date,
  ): Promise<boolean> {
    const mailbox = await this.deps.mailboxes.getById(row.mailboxId);
    if (!this.syncable(mailbox)) {
      // Kill switch / disabled / missing mailbox: terminal, content-free, no IMAP.
      await this.deps.syncRequests.markFailed({
        id: row.id,
        now,
        lastError: CODE.mailboxUnsyncable,
      });
      this.deps.logger.warn("sync_request_blocked", {
        sync_request_id: row.id,
        reason: CODE.mailboxUnsyncable,
      });
      return false;
    }

    // Whole-mailbox (folder null) => an initial discovery pass; a folder-scoped
    // request => an incremental sync of that folder. Distinct durable rows/ids
    // (per uq_sync_requests_open) map to distinct deterministic pg-boss keys.
    const isWholeMailbox = row.folder === null;
    const job: SyncMailboxJob & { syncRequestId: string } = {
      workspaceId: row.workspaceId,
      mailboxId: row.mailboxId,
      folder: row.folder ?? "INBOX",
      mode: isWholeMailbox ? "initial" : "incremental",
      syncRequestId: row.id,
    };
    await this.deps.enqueueSync(job);
    return true;
  }

  /** Called by the sync_mailbox job handler on a successful sync. */
  public async markCompleted(syncRequestId: string): Promise<void> {
    await this.deps.syncRequests.markCompleted(
      syncRequestId,
      this.deps.clock.now(),
    );
  }

  /** Called by the sync_mailbox job handler on a terminal (final) failure. */
  public async markFailed(syncRequestId: string, code: string): Promise<void> {
    await this.deps.syncRequests.markFailed({
      id: syncRequestId,
      now: this.deps.clock.now(),
      lastError: code,
    });
  }

  private syncable(mailbox: MailboxRow | null): mailbox is MailboxRow {
    return mailbox !== null && mailbox.enabled && !mailbox.killSwitch;
  }
}
