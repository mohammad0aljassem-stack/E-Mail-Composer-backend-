import type {
  DraftMirrorRow,
  DraftVersionRow,
  FolderRole,
  MailboxFolderRow,
  MailboxRow,
  MailMessageMeta,
  SendAttemptRow,
  SendIntentRow,
  StoredCredential,
  SyncRequestRow,
} from "../domain/models.js";
import type { SendState } from "../domain/send-state.js";

/**
 * Repository ports. Both the `pg`-backed implementations (repositories.ts) and
 * the in-memory test fakes implement these, so executors are unit-testable with
 * no database and integration-testable against real Postgres.
 */

export interface MailboxReader {
  getById(id: string): Promise<MailboxRow | null>;
  listEnabled(): Promise<MailboxRow[]>;
}

export interface CredentialReader {
  getActiveByMailbox(mailboxId: string): Promise<StoredCredential | null>;
}

/**
 * Read-only folder-role lookup (SELECT only). Used by the send executor to
 * resolve the discovered Sent folder (providers localize it — e.g. IONOS
 * "Gesendete Objekte") instead of relying on a hard-coded name.
 */
export interface FolderRoleReader {
  findByRole(
    mailboxId: string,
    role: FolderRole,
  ): Promise<MailboxFolderRow | null>;
}

export interface FolderStore extends FolderRoleReader {
  upsertDiscovered(input: {
    workspaceId: string;
    mailboxId: string;
    name: string;
    role: MailboxFolderRow["role"];
    uidvalidity: bigint;
    uidnext: bigint;
  }): Promise<MailboxFolderRow>;
  getByMailboxAndName(
    mailboxId: string,
    name: string,
  ): Promise<MailboxFolderRow | null>;
  updateCursor(input: {
    id: string;
    uidvalidity: bigint;
    uidnext: bigint;
    lastSeenUid: bigint;
    highestModseq: bigint | null;
  }): Promise<void>;
  resetForUidValidityChange(input: {
    id: string;
    newUidvalidity: bigint;
    newUidnext: bigint;
  }): Promise<void>;
}

export interface MessageStore {
  upsertMeta(m: MailMessageMeta): Promise<void>;
  countByFolder(folderId: string): Promise<number>;
}

export interface DraftMirrorStore {
  getByDraftAndMailbox(
    draftId: string,
    mailboxId: string,
  ): Promise<DraftMirrorRow | null>;
  upsert(input: {
    workspaceId: string;
    draftId: string;
    mailboxId: string;
    remoteUid: bigint | null;
    remoteUidvalidity: bigint | null;
    mirroredRevision: bigint;
    status: DraftMirrorRow["status"];
  }): Promise<DraftMirrorRow>;
}

/**
 * SELECT-only lookup of the immutable draft snapshot for an EXACT confirmed
 * revision (public.draft_versions). Returns the highest version_no when
 * several snapshots share the same source_revision, and null when no snapshot
 * exists for that exact revision — the caller must fail CLOSED (checkpoints
 * are not guaranteed for every revision; a near-miss is never substituted).
 */
export interface DraftVersionReader {
  findDraftVersion(
    workspaceId: string,
    draftId: string,
    sourceRevision: bigint,
  ): Promise<DraftVersionRow | null>;
}

export interface SendIntentReader {
  getById(id: string): Promise<SendIntentRow | null>;
}

export interface SendAttemptStore {
  getById(id: string): Promise<SendAttemptRow | null>;
  getBySendIntent(sendIntentId: string): Promise<SendAttemptRow | null>;
  compareAndSet(input: {
    id: string;
    expectedVersion: bigint;
    expectedState: SendState;
    toState: SendState;
    fields?: {
      claimedBy?: string | null;
      claimedAt?: Date | null;
      messageId?: string | null;
      smtpResponse?: string | null;
      evidence?: Record<string, string | number | boolean>;
    };
  }): Promise<SendAttemptRow | null>;
}

export interface WorkerClaimStore {
  tryClaim(input: {
    sendAttemptId: string;
    workerId: string;
    leaseUntil: Date;
  }): Promise<boolean>;
  heartbeat(sendAttemptId: string, leaseUntil: Date): Promise<void>;
  release(sendAttemptId: string): Promise<void>;
  expireStale(now: Date): Promise<number>;
}

export interface AuditWriter {
  append(input: {
    workspaceId: string;
    mailboxId?: string | null;
    eventType: string;
    sendIntentId?: string | null;
    sendAttemptId?: string | null;
    correlationId?: string | null;
    messageId?: string | null;
    detail?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface HeartbeatWriter {
  beat(workerId: string, state: string | null): Promise<void>;
}

/**
 * Durable sync-request consumer store (transport.sync_requests). The worker has
 * exactly SELECT + UPDATE — NO INSERT/DELETE (the DEFINER RPC inserts). Every
 * method is a single atomic statement; `claimBatch` is a concurrency-safe
 * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` so at most one
 * worker claims any one request.
 */
export interface SyncRequestStore {
  /**
   * Atomically claim up to `limit` requests. Eligible rows are `pending` OR
   * `claimed` whose `claimedAt < leaseCutoff` (a STALE claim past the lease —
   * reclaimable crash recovery) AND `attemptCount < maxAttempts`. Each claimed
   * row moves to `claimed`, sets `claimedAt = now`, and increments
   * `attemptCount`. A FRESH claim (recent `claimedAt`) is never stolen.
   */
  claimBatch(input: {
    limit: number;
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
  }): Promise<SyncRequestRow[]>;

  /**
   * Fenced lease renewal for an in-flight claim (single-claimant guarantee,
   * no schema change): a single CAS statement
   * `UPDATE ... SET claimed_at = now WHERE id AND status = 'claimed' AND
   * claimed_at = prevClaimedAt RETURNING claimed_at`. Returns the NEW
   * `claimedAt` (the next fencing token) or null when the lease was lost —
   * another claimant re-claimed the row (its claimed_at moved) or the request
   * reached a terminal state. `prevClaimedAt` MUST be the exact Date previously
   * returned by claimBatch/getById/renewLease (Postgres timestamptz keeps the
   * millisecond value exactly; never a re-derived timestamp).
   */
  renewLease(id: string, prevClaimedAt: Date, now: Date): Promise<Date | null>;

  /** Terminal success: `claimed -> completed`, set `completedAt`. Idempotent. */
  markCompleted(id: string, now: Date): Promise<SyncRequestRow | null>;

  /**
   * Terminal failure: `claimed|pending -> failed`, set `completedAt` and a
   * bounded, content-free `lastError` code. Idempotent.
   */
  markFailed(input: {
    id: string;
    now: Date;
    lastError: string;
  }): Promise<SyncRequestRow | null>;

  /**
   * Sweep STALE `claimed` rows whose `attemptCount >= maxAttempts` to `failed`
   * with a bounded content-free code. Returns the number reaped. This is the
   * terminal bound on durable re-claims.
   */
  reapExhausted(input: {
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
    lastError: string;
  }): Promise<number>;

  getById(id: string): Promise<SyncRequestRow | null>;
}
