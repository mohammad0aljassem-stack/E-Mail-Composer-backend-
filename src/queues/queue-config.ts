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
