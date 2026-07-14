import type {
  DraftMirrorRow,
  FolderRole,
  MailboxFolderRow,
  MailboxRow,
  MailMessageMeta,
  MimeArtifactRow,
  MirrorSnapshotRow,
  SendAttemptRow,
  SendIntentRow,
  SendSnapshotRow,
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
 * The worker's ONLY read path for confirmed SEND content: the private
 * transport.get_send_snapshot(send_intent_id) accessor. It returns the exact
 * draft_versions snapshot bound to the intent, or raises P0002 (mapped here to
 * a content-free SnapshotUnavailableError) for a missing/legacy/inconsistent
 * intent. It NEVER returns null and NEVER reads the mutable draft, a near-miss
 * revision, or a caller-supplied snapshot id — the intent id is the sole key.
 */
export interface SendSnapshotReader {
  getSendSnapshot(sendIntentId: string): Promise<SendSnapshotRow>;
}

/**
 * The worker's read path for MIRRORING a known revision: the private
 * transport.get_mirror_snapshot(workspace_id, draft_id, source_revision)
 * accessor. Returns the newest snapshot for that EXACT triple, or raises P0002
 * (mapped to SnapshotUnavailableError) when none exists (including any workspace
 * mismatch — the workspace is part of the exact-match key). Never used to send.
 */
export interface MirrorSnapshotReader {
  getMirrorSnapshot(
    workspaceId: string,
    draftId: string,
    sourceRevision: bigint,
  ): Promise<MirrorSnapshotRow>;
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

/**
 * The worker's exact-MIME-artifact store (transport.send_mime_artifacts). The
 * worker has EXECUTE on transport.create_or_verify_send_mime_artifact (a SECURITY
 * DEFINER function that INSERTs as its definer) plus SELECT/UPDATE on the table —
 * it holds NO direct INSERT and NEVER runs `insert into
 * transport.send_mime_artifacts`. `createOrVerify` is the sole write path: it
 * first-creates the artifact while the attempt is 'claimed' (before any SMTP
 * byte) and, on a second identical call, VERIFIES the stored row for
 * restart/reconciliation, always re-hashing the caller's bytes. A uniform 23514
 * from the function maps to a content-free MimeArtifactError. `getBySendAttempt`
 * loads the EXACT stored bytes on restart so the Sent-copy append reuses them —
 * the worker never rebuilds MIME after acceptance.
 */
export interface MimeArtifactStore {
  createOrVerify(input: {
    sendAttemptId: string;
    sendIntentId: string;
    workspaceId: string;
    messageId: string;
    mimeSha256: string;
    sizeBytes: bigint;
    rawMime: Buffer;
  }): Promise<MimeArtifactRow>;
  getBySendAttempt(sendAttemptId: string): Promise<MimeArtifactRow | null>;
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
 *
 * FENCING TUPLE (generation + token; NO schema change): a claimant "owns" a
 * request iff, in a single atomic CAS, the row is still `status = 'claimed'`
 * AND `attempt_count = expectedGeneration` AND `claimed_at = expectedToken`.
 *   - `claimGeneration` = `attempt_count` at claim time. It advances by exactly
 *     1 on each durable (re)claim via `claimBatch` — never on renew, on a
 *     continuation job, or on a pg-boss retry.
 *   - `claimToken` = `claimed_at` at claim time. It moves on every claim AND on
 *     every successful `renewLease`.
 * A stale/superseded claimant (a dead generation, or a token another renewal
 * moved) fails every CAS — renewLease/markCompleted/markFailed all return null —
 * and MUST stop, marking nothing, opening no IMAP connection.
 */
export interface SyncRequestStore {
  /**
   * Atomically claim up to `limit` requests. Eligible rows are `pending` OR
   * `claimed` whose `claimedAt < leaseCutoff` (a STALE claim past the lease —
   * reclaimable crash recovery) AND `attemptCount < maxAttempts`. Each claimed
   * row moves to `claimed`, sets `claimedAt = now`, and increments
   * `attemptCount`. The incremented `attemptCount` is the claim's GENERATION and
   * `claimedAt = now` is its TOKEN. A FRESH claim (recent `claimedAt`) is never
   * stolen.
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
   * attempt_count = expectedGeneration AND claimed_at = prevClaimedAt
   * RETURNING claimed_at`. Generation is UNCHANGED by a renewal (renewals are
   * not re-claims). Returns the NEW `claimedAt` (the next fencing token) or null
   * when the lease was lost — another claimant re-claimed the row (generation
   * and/or token moved) or the request reached a terminal state. `prevClaimedAt`
   * MUST be the exact Date previously returned by claimBatch/renewLease or
   * parsed from the job payload's `claimToken` (Postgres timestamptz keeps the
   * millisecond value exactly; never a re-derived timestamp).
   */
  renewLease(
    id: string,
    expectedGeneration: number,
    prevClaimedAt: Date,
    now: Date,
  ): Promise<Date | null>;

  /**
   * Fenced terminal success: `claimed -> completed`, set `completedAt`, ONLY
   * when `attempt_count = expectedGeneration` AND `claimed_at = expectedToken`.
   * A lost CAS (another generation took over) returns null — a silent no-op.
   * Idempotent within the owning generation.
   */
  markCompleted(
    id: string,
    expectedGeneration: number,
    expectedToken: Date,
    now: Date,
  ): Promise<SyncRequestRow | null>;

  /**
   * Fenced terminal failure: `claimed -> failed`, set `completedAt` and a
   * bounded, content-free `lastError` code, ONLY when `attempt_count =
   * expectedGeneration` AND `claimed_at = expectedToken`. Every legitimate
   * terminal-fail caller holds a live claim, so there is no `pending` allowance;
   * the unfenced terminal bound is `reapExhausted`. A lost CAS returns null.
   */
  markFailed(input: {
    id: string;
    expectedGeneration: number;
    expectedToken: Date;
    now: Date;
    lastError: string;
  }): Promise<SyncRequestRow | null>;

  /**
   * Sweep STALE `claimed` rows whose `attemptCount >= maxAttempts` to `failed`
   * with a bounded content-free code. Returns the number reaped. This is the
   * terminal bound on durable re-claims (the only UNFENCED terminal write).
   */
  reapExhausted(input: {
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
    lastError: string;
  }): Promise<number>;

  getById(id: string): Promise<SyncRequestRow | null>;
}
