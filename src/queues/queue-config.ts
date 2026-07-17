import type { Queue } from "pg-boss";

/**
 * pg-boss queue families and their EXACT policies (see docs/adr/0002-queues.md).
 *
 *  sync_mailbox   retryable, bounded exponential backoff, max ~5 attempts,
 *                 singleton/dedup per mailbox+folder, per-workspace fair
 *                 concurrency (job group = workspace).
 *  draft_mirror   retryable, bounded backoff, max ~3, idempotency key =
 *                 draftId + immutable revision.
 *  send_message   ZERO automatic retries (retryLimit === 0). No queue retry,
 *                 no generic retry wrapper. Atomic claim + explicit state
 *                 machine handle exactly-once INTENT; delivery is never retried.
 *  apply_mutation bounded retries for naturally-idempotent ops, deterministic keys.
 */

export const QUEUE_NAMES = {
  syncMailbox: "sync_mailbox",
  draftMirror: "draft_mirror",
  sendMessage: "send_message",
  applyMutation: "apply_mutation",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Queue creation options, exactly as they will be registered with pg-boss. */
export const QUEUE_DEFINITIONS: Readonly<
  Record<QueueName, Omit<Queue, "name">>
> = {
  [QUEUE_NAMES.syncMailbox]: {
    policy: "short",
    retryLimit: 5,
    retryDelay: 5, // seconds
    retryBackoff: true, // bounded exponential
    retryDelayMax: 300,
    expireInSeconds: 600,
    retentionSeconds: 7 * 24 * 3600,
  },
  [QUEUE_NAMES.draftMirror]: {
    policy: "short",
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 120,
    expireInSeconds: 300,
    retentionSeconds: 7 * 24 * 3600,
  },
  [QUEUE_NAMES.sendMessage]: {
    // CRITICAL SAFETY INVARIANT: zero automatic retries. SMTP is not
    // exactly-once delivery; a blind retry could double-send. Recovery is an
    // explicit, human-gated state transition — never an automatic re-enqueue.
    policy: "short",
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 300,
    retentionSeconds: 30 * 24 * 3600,
  },
  [QUEUE_NAMES.applyMutation]: {
    policy: "short",
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 120,
    expireInSeconds: 120,
    retentionSeconds: 7 * 24 * 3600,
  },
};

// -- Job payloads (explicit contracts; never a broad Record) ----------------

export interface SyncMailboxJob {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly folder: string;
  readonly mode: "initial" | "incremental";
  /**
   * Set when this job was dispatched from a durable transport.sync_requests row.
   * Carried end-to-end so the executor can mark that durable request
   * completed/failed. Absent for ad-hoc (IDLE-wakeup) syncs.
   */
  readonly syncRequestId?: string;
  /**
   * Durable fencing tuple (part 1): `attempt_count` at claim time. Advances by
   * exactly 1 on each durable (re)claim via claimBatch; never on renew,
   * continuation, or pg-boss retry. Present together with `claimToken` for
   * durable-request jobs; both are ABSENT for ad-hoc (IDLE-wakeup) jobs.
   */
  readonly claimGeneration?: number;
  /**
   * Durable fencing tuple (part 2): `claimed_at` at claim time, serialized as an
   * ISO-8601 string with millisecond precision (JSON-safe). It round-trips to
   * the EXACT claimed_at Date because we control claimed_at = the `now` Date we
   * pass into claimBatch. Present together with `claimGeneration` for
   * durable-request jobs; both are ABSENT for ad-hoc jobs.
   */
  readonly claimToken?: string;
}

export interface DraftMirrorJob {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly draftId: string;
  readonly revision: string; // bigint as string
}

export interface SendMessageJob {
  readonly workspaceId: string;
  readonly sendIntentId: string;
  readonly sendAttemptId: string;
}

export interface ApplyMutationJob {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly folder: string;
  readonly uid: string;
  readonly mutation:
    | { kind: "add_flags"; flags: string[] }
    | { kind: "remove_flags"; flags: string[] }
    | { kind: "move"; toFolder: string };
}

/** Deterministic dedup/idempotency keys (singletonKey). */
export const singletonKeys = {
  syncMailbox: (mailboxId: string, folder: string): string =>
    `sync:${mailboxId}:${folder}`,
  /**
   * Durable-request dispatch key: GENERATION-SCOPED in the sync_request id and
   * the claim generation (`attempt_count` at claim time). Within ONE generation,
   * a re-dispatch or crash-recovery duplicate produces the SAME key and dedups
   * to null. A durable RE-CLAIM bumps the generation and therefore mints a NEW
   * key, so it is intentionally NOT deduped against a stale queued job left over
   * from a dead generation — the fenced CAS (generation + token) is what
   * guarantees at-most-one EFFECTIVE claimant across generations, not the key.
   * Whole-mailbox vs folder-scoped requests are distinct rows/ids (per the
   * canonical uq_sync_requests_open dedup) and so map to distinct keys anyway.
   */
  syncRequest: (syncRequestId: string, claimGeneration: number): string =>
    `sync-req:${syncRequestId}:gen:${claimGeneration}`,
  /**
   * Multi-batch continuation key for a durable request: GENERATION-SCOPED in the
   * request id and claim generation, AND the folder-cursor position (lastSeenUid)
   * after the last completed batch. A continuation stays within the SAME
   * generation as the job that enqueued it. Distinct from the generation's
   * `sync-req:{id}:gen:{g}` dispatch key by the `:uid:` suffix, so a continuation
   * can never be swallowed by the dispatch job's singleton dedup; and a
   * crash-recovery duplicate of the SAME continuation (same request, generation,
   * cursor) produces the SAME key, so pg-boss dedups it (boss.send returns null →
   * proven-equivalent work already queued). A reclaim into a new generation mints
   * a fresh keyspace; the fenced CAS keeps only one claimant effective.
   */
  syncRequestContinuation: (
    syncRequestId: string,
    claimGeneration: number,
    cursorUid: string,
  ): string =>
    `sync-req:${syncRequestId}:gen:${claimGeneration}:uid:${cursorUid}`,
  draftMirror: (draftId: string, revision: string): string =>
    `draft:${draftId}:${revision}`,
  sendMessage: (sendIntentId: string): string => `send:${sendIntentId}`,
  applyMutation: (
    mailboxId: string,
    folder: string,
    uid: string,
    kind: string,
  ): string => `mutate:${mailboxId}:${folder}:${uid}:${kind}`,
};
