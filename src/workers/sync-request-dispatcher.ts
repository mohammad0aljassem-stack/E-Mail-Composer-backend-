import type { Clock } from "../domain/clock.js";
import type { MailboxRow, SyncRequestRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type {
  MailboxReader,
  SyncRequestStore,
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
 * STATE FLOW (durable row):
 *   pending --claim--> claimed --success--> completed
 *                          \---terminal fail / exhausted--> failed
 *
 *   * A claim is a single atomic statement (see SyncRequestStore.claimBatch):
 *     `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`.
 *     Exactly one worker claims any one row; two-worker races resolve to one.
 *   * On claim: status='claimed', claimed_at=now(), attempt_count += 1.
 *     attempt_count increments ONLY on a durable (re)claim — never per pg-boss
 *     retry (see LEASE / ATTEMPTS below).
 *   * completed_at is set only when markCompleted runs (claimed -> completed).
 *     claimed_at is written on every claim and is intentionally NOT nulled on
 *     completion/failure (it is the last-claim timestamp, retained for audit).
 *
 * LEASE + STALE DETECTION (crash recovery):
 *   A `claimed` row whose claimed_at is older than `leaseMs` is STALE: the
 *   claiming worker is presumed dead (crash-after-claim-before-enqueue, or a
 *   pod restart mid-flight). It becomes reclaimable on the next pass — a FRESH
 *   claim (recent claimed_at) is never stolen. Recommended leaseMs is a few
 *   minutes: comfortably longer than a healthy dispatch + enqueue, shorter than
 *   an operator's patience for a stuck request.
 *
 * MAX ATTEMPTS + interaction with sync_mailbox.retryLimit=5:
 *   Two INDEPENDENT layers that MUST NOT multiply into an undocumented count:
 *     - pg-boss retryLimit=5 retries the *executed job* for transient IMAP
 *       errors WITHIN a single durable claim. These do NOT touch attempt_count.
 *     - the durable attempt_count bounds *re-dispatch* (crash / lease expiry).
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
