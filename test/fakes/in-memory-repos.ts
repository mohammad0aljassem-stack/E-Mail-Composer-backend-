import type {
  DraftMirrorRow,
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
} from "../../src/domain/models.js";
import { canTransition, type SendState } from "../../src/domain/send-state.js";
import {
  MimeArtifactError,
  SnapshotUnavailableError,
} from "../../src/domain/errors.js";
import { sha256Hex } from "../../src/mime/outbound-builder.js";
import type {
  AuditWriter,
  CredentialReader,
  DraftMirrorStore,
  FolderStore,
  HeartbeatWriter,
  MailboxReader,
  MessageStore,
  MimeArtifactStore,
  MirrorSnapshotReader,
  SendAttemptStore,
  SendIntentReader,
  SendSnapshotReader,
  SyncRequestStore,
  WorkerClaimStore,
} from "../../src/db/repository-interfaces.js";

/**
 * A pg-like error carrying a SQLSTATE `code`, so a fake can faithfully reproduce
 * a DB constraint/trigger rejection (e.g. the 23514 raised by
 * trg_send_attempts_require_mime_before_smtp) without an `as any` cast.
 */
export class FakePgError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FakePgError";
  }
}

/**
 * In-memory repository fakes that faithfully reproduce the safety-relevant
 * behaviour the real Postgres schema enforces: compare-and-set version guards,
 * the send-attempt transition table, atomic single-holder claims, and the
 * draft-mirror stale-revision guard. Used by unit tests so the executors are
 * exercised without a database.
 */

export class FakeMailboxRepo implements MailboxReader {
  public readonly rows = new Map<string, MailboxRow>();
  public getById(id: string): Promise<MailboxRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  public listEnabled(): Promise<MailboxRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((m) => m.enabled && !m.killSwitch),
    );
  }
}

export class FakeCredentialRepo implements CredentialReader {
  public readonly rows = new Map<string, StoredCredential>();
  public getActiveByMailbox(
    mailboxId: string,
  ): Promise<StoredCredential | null> {
    return Promise.resolve(this.rows.get(mailboxId) ?? null);
  }
}

export class FakeFolderRepo implements FolderStore {
  public readonly rows = new Map<string, MailboxFolderRow>();
  private seq = 1;

  public upsertDiscovered(input: {
    workspaceId: string;
    mailboxId: string;
    name: string;
    role: MailboxFolderRow["role"];
    uidvalidity: bigint;
    uidnext: bigint;
  }): Promise<MailboxFolderRow> {
    const key = `${input.mailboxId}:${input.name}`;
    const existing = this.rows.get(key);
    const row: MailboxFolderRow = {
      id: existing?.id ?? `folder-${this.seq++}`,
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      name: input.name,
      role: input.role,
      uidvalidity: input.uidvalidity,
      uidnext: input.uidnext,
      lastSeenUid: existing?.lastSeenUid ?? null,
      highestModseq: existing?.highestModseq ?? null,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
    };
    this.rows.set(key, row);
    return Promise.resolve(row);
  }

  public getByMailboxAndName(
    mailboxId: string,
    name: string,
  ): Promise<MailboxFolderRow | null> {
    return Promise.resolve(this.rows.get(`${mailboxId}:${name}`) ?? null);
  }

  public findByRole(
    mailboxId: string,
    role: MailboxFolderRow["role"],
  ): Promise<MailboxFolderRow | null> {
    const match = [...this.rows.values()]
      .filter((r) => r.mailboxId === mailboxId && r.role === role)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    return Promise.resolve(match ?? null);
  }

  public updateCursor(input: {
    id: string;
    uidvalidity: bigint;
    uidnext: bigint;
    lastSeenUid: bigint;
    highestModseq: bigint | null;
  }): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.id === input.id) {
        this.rows.set(key, {
          ...row,
          uidvalidity: input.uidvalidity,
          uidnext: input.uidnext,
          lastSeenUid: input.lastSeenUid,
          highestModseq: input.highestModseq,
          lastSyncedAt: new Date(),
        });
      }
    }
    return Promise.resolve();
  }

  public resetForUidValidityChange(input: {
    id: string;
    newUidvalidity: bigint;
    newUidnext: bigint;
  }): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.id === input.id) {
        this.rows.set(key, {
          ...row,
          uidvalidity: input.newUidvalidity,
          uidnext: input.newUidnext,
          lastSeenUid: 0n,
          highestModseq: null,
          lastSyncedAt: new Date(),
        });
      }
    }
    return Promise.resolve();
  }
}

export class FakeMessageRepo implements MessageStore {
  /** keyed by folderId:uidvalidity:uid (the dedupe identity). */
  public readonly rows = new Map<string, MailMessageMeta>();

  public upsertMeta(m: MailMessageMeta): Promise<void> {
    this.rows.set(`${m.folderId}:${m.uidvalidity}:${m.uid}`, m);
    return Promise.resolve();
  }
  public countByFolder(folderId: string): Promise<number> {
    return Promise.resolve(
      [...this.rows.values()].filter((m) => m.folderId === folderId).length,
    );
  }
}

export class FakeDraftMirrorRepo implements DraftMirrorStore {
  public readonly rows = new Map<string, DraftMirrorRow>();
  private seq = 1;

  public getByDraftAndMailbox(
    draftId: string,
    mailboxId: string,
  ): Promise<DraftMirrorRow | null> {
    return Promise.resolve(this.rows.get(`${draftId}:${mailboxId}`) ?? null);
  }

  public upsert(input: {
    workspaceId: string;
    draftId: string;
    mailboxId: string;
    remoteUid: bigint | null;
    remoteUidvalidity: bigint | null;
    mirroredRevision: bigint;
    status: DraftMirrorRow["status"];
  }): Promise<DraftMirrorRow> {
    const key = `${input.draftId}:${input.mailboxId}`;
    const existing = this.rows.get(key);
    // Stale-revision guard: never overwrite a newer revision.
    if (
      existing !== null &&
      existing !== undefined &&
      existing.mirroredRevision !== null &&
      input.mirroredRevision < existing.mirroredRevision
    ) {
      return Promise.resolve(existing);
    }
    const row: DraftMirrorRow = {
      id: existing?.id ?? `mirror-${this.seq++}`,
      workspaceId: input.workspaceId,
      draftId: input.draftId,
      mailboxId: input.mailboxId,
      remoteUid: input.remoteUid,
      remoteUidvalidity: input.remoteUidvalidity,
      mirroredRevision: input.mirroredRevision,
      status: input.status,
    };
    this.rows.set(key, row);
    return Promise.resolve(row);
  }
}

/**
 * In-memory transport.get_send_snapshot(send_intent_id). Keyed by the intent id
 * (the sole key — the real function resolves the exact bound snapshot from the
 * intent, never a workspace/draft/revision lookup the worker controls). A
 * missing key or `failWith` rejects with the content-free SnapshotUnavailableError,
 * exactly as the real accessor's uniform P0002 does for every
 * missing/legacy/inconsistent case.
 */
export class FakeSendSnapshotRepo implements SendSnapshotReader {
  public readonly rows = new Map<string, SendSnapshotRow>();
  public failWith: Error | null = null;

  public getSendSnapshot(sendIntentId: string): Promise<SendSnapshotRow> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const row = this.rows.get(sendIntentId);
    if (row === undefined)
      return Promise.reject(new SnapshotUnavailableError());
    return Promise.resolve(row);
  }
}

/**
 * In-memory transport.get_mirror_snapshot(workspace, draft, source_revision).
 * Mirrors the real semantics: exact (workspace, draft, source_revision) match,
 * highest version_no wins, and a uniform P0002 (→ SnapshotUnavailableError) when
 * none exists. Seed rows carry the keying revision explicitly (the returned row
 * shape omits it, matching the function's TABLE columns). `failWith` simulates
 * an unreadable accessor.
 */
export interface MirrorSnapshotSeed extends MirrorSnapshotRow {
  workspaceId: string;
  draftId: string;
  sourceRevision: bigint;
}

export class FakeMirrorSnapshotRepo implements MirrorSnapshotReader {
  public readonly rows: MirrorSnapshotSeed[] = [];
  public failWith: Error | null = null;

  public getMirrorSnapshot(
    workspaceId: string,
    draftId: string,
    sourceRevision: bigint,
  ): Promise<MirrorSnapshotRow> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const match = this.rows
      .filter(
        (r) =>
          r.workspaceId === workspaceId &&
          r.draftId === draftId &&
          r.sourceRevision === sourceRevision,
      )
      .sort((a, b) => (a.versionNo < b.versionNo ? 1 : -1))[0];
    if (match === undefined) {
      return Promise.reject(new SnapshotUnavailableError());
    }
    return Promise.resolve({
      draftVersionId: match.draftVersionId,
      versionNo: match.versionNo,
      subject: match.subject,
      bodyJson: match.bodyJson,
    });
  }
}

export class FakeSendIntentRepo implements SendIntentReader {
  public readonly rows = new Map<string, SendIntentRow>();
  public getById(id: string): Promise<SendIntentRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

export class FakeSendAttemptRepo implements SendAttemptStore {
  public readonly rows = new Map<string, SendAttemptRow>();
  /**
   * Mirrors the DB ordering guard trg_send_attempts_require_mime_before_smtp:
   * when set, the claimed -> smtp_in_progress transition is REJECTED with a
   * 23514 (as the real trigger does) unless the predicate confirms a valid
   * retained MIME artifact exists for the attempt. Left null in tests that do
   * not exercise the artifact ordering.
   */
  public mimeArtifactGuard: ((sendAttemptId: string) => boolean) | null = null;

  public getById(id: string): Promise<SendAttemptRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  public getBySendIntent(sendIntentId: string): Promise<SendAttemptRow | null> {
    return Promise.resolve(
      [...this.rows.values()].find((a) => a.sendIntentId === sendIntentId) ??
        null,
    );
  }

  public compareAndSet(input: {
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
  }): Promise<SendAttemptRow | null> {
    const row = this.rows.get(input.id);
    if (row === undefined) return Promise.resolve(null);
    // CAS: version + state must match (mirrors the SQL WHERE clause).
    if (
      row.version !== input.expectedVersion ||
      row.state !== input.expectedState
    ) {
      return Promise.resolve(null);
    }
    // Transition legality (mirrors the DB trigger).
    if (!canTransition(input.expectedState, input.toState)) {
      return Promise.reject(
        new Error(
          `illegal transition ${input.expectedState} -> ${input.toState}`,
        ),
      );
    }
    // Artifact-before-SMTP ordering guard (mirrors
    // trg_send_attempts_require_mime_before_smtp): a missing/invalid artifact
    // makes the claimed -> smtp_in_progress UPDATE fail 23514, so the executor
    // treats it as failed_before_delivery with ZERO SMTP.
    if (
      input.expectedState === "claimed" &&
      input.toState === "smtp_in_progress" &&
      this.mimeArtifactGuard !== null &&
      !this.mimeArtifactGuard(input.id)
    ) {
      return Promise.reject(
        new FakePgError(
          "23514",
          "send attempt cannot enter smtp_in_progress without a persisted MIME artifact",
        ),
      );
    }
    const f = input.fields ?? {};
    const updated: SendAttemptRow = {
      ...row,
      state: input.toState,
      version: row.version + 1n,
      claimedBy: f.claimedBy ?? row.claimedBy,
      claimedAt: f.claimedAt ?? row.claimedAt,
      messageId: f.messageId ?? row.messageId,
      smtpResponse: f.smtpResponse ?? row.smtpResponse,
      evidence:
        f.evidence === undefined
          ? row.evidence
          : { ...row.evidence, ...f.evidence },
    };
    this.rows.set(input.id, updated);
    return Promise.resolve(updated);
  }
}

/**
 * In-memory transport.send_mime_artifacts + create_or_verify function. Faithful
 * to the safety-relevant DB behaviour:
 *  - FIRST-CREATE only while the attempt is EXACTLY 'claimed' (via `attemptState`,
 *    mirroring the function's state gate + the BEFORE INSERT trigger), with the
 *    exact-bytes hash/size/25MiB-bound re-checked.
 *  - A second call with an artifact already present is the VERIFY path: it
 *    succeeds only on EXACT identity, ALWAYS re-hashing the caller's bytes
 *    against the stored durable digest/size, and NEVER overwrites bytes.
 *  - Any rejection is the uniform content-free MimeArtifactError (the repo's
 *    mapping of the function's 23514).
 * The worker never INSERTs directly — this fake IS the function, exactly as the
 * repository only ever calls it. One artifact per attempt (keyed by attempt id).
 */
export class FakeMimeArtifactRepo implements MimeArtifactStore {
  public readonly rows = new Map<string, MimeArtifactRow>();
  public createOrVerifyCalls = 0;
  private seq = 1;
  /** Reads the attempt's current state (mirrors the function's FOR UPDATE read). */
  public attemptState: ((sendAttemptId: string) => SendState | null) | null =
    null;

  /** Test-only direct seed (stands in for a previously-created artifact). */
  public seed(input: {
    sendAttemptId: string;
    sendIntentId: string;
    workspaceId: string;
    messageId: string;
    rawMime: Buffer;
    clearedAt?: Date | null;
  }): MimeArtifactRow {
    const cleared = input.clearedAt ?? null;
    const row: MimeArtifactRow = {
      id: `mime-${this.seq++}`,
      sendAttemptId: input.sendAttemptId,
      sendIntentId: input.sendIntentId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      mimeSha256: sha256Hex(input.rawMime),
      sizeBytes: BigInt(input.rawMime.length),
      rawMime: cleared !== null ? null : Buffer.from(input.rawMime),
      clearedAt: cleared,
    };
    this.rows.set(input.sendAttemptId, row);
    return row;
  }

  public createOrVerify(input: {
    sendAttemptId: string;
    sendIntentId: string;
    workspaceId: string;
    messageId: string;
    mimeSha256: string;
    sizeBytes: bigint;
    rawMime: Buffer;
  }): Promise<MimeArtifactRow> {
    this.createOrVerifyCalls += 1;
    const existing = this.rows.get(input.sendAttemptId);
    if (existing !== undefined) {
      // VERIFY path — permitted regardless of the attempt's current state, but
      // the caller must PROVE it still holds the exact bytes: re-hash + re-size
      // the caller's ACTUAL bytes against the stored durable digest/size, match
      // every ref field, and (while retained) byte-compare.
      const digest = sha256Hex(input.rawMime);
      const diverges =
        existing.sendIntentId !== input.sendIntentId ||
        existing.workspaceId !== input.workspaceId ||
        existing.messageId !== input.messageId ||
        existing.mimeSha256 !== input.mimeSha256 ||
        existing.sizeBytes !== input.sizeBytes ||
        digest !== existing.mimeSha256 ||
        BigInt(input.rawMime.length) !== existing.sizeBytes ||
        (existing.rawMime !== null && !existing.rawMime.equals(input.rawMime));
      if (diverges) return Promise.reject(new MimeArtifactError());
      return Promise.resolve(existing);
    }
    // FIRST-CREATE path — the attempt must be EXACTLY 'claimed'.
    const state = this.attemptState?.(input.sendAttemptId) ?? null;
    if (state !== "claimed") return Promise.reject(new MimeArtifactError());
    const digest = sha256Hex(input.rawMime);
    if (
      digest !== input.mimeSha256 ||
      BigInt(input.rawMime.length) !== input.sizeBytes ||
      input.sizeBytes > 26_214_400n ||
      input.sizeBytes <= 0n
    ) {
      return Promise.reject(new MimeArtifactError());
    }
    const row: MimeArtifactRow = {
      id: `mime-${this.seq++}`,
      sendAttemptId: input.sendAttemptId,
      sendIntentId: input.sendIntentId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      mimeSha256: input.mimeSha256,
      sizeBytes: input.sizeBytes,
      rawMime: Buffer.from(input.rawMime),
      clearedAt: null,
    };
    this.rows.set(input.sendAttemptId, row);
    return Promise.resolve(row);
  }

  public getBySendAttempt(
    sendAttemptId: string,
  ): Promise<MimeArtifactRow | null> {
    return Promise.resolve(this.rows.get(sendAttemptId) ?? null);
  }
}

export class FakeWorkerClaimRepo implements WorkerClaimStore {
  public readonly claims = new Map<
    string,
    { workerId: string; leaseUntil: Date }
  >();

  public tryClaim(input: {
    sendAttemptId: string;
    workerId: string;
    leaseUntil: Date;
  }): Promise<boolean> {
    if (this.claims.has(input.sendAttemptId)) return Promise.resolve(false);
    this.claims.set(input.sendAttemptId, {
      workerId: input.workerId,
      leaseUntil: input.leaseUntil,
    });
    return Promise.resolve(true);
  }
  public heartbeat(sendAttemptId: string, leaseUntil: Date): Promise<void> {
    const c = this.claims.get(sendAttemptId);
    if (c !== undefined) c.leaseUntil = leaseUntil;
    return Promise.resolve();
  }
  public release(sendAttemptId: string): Promise<void> {
    this.claims.delete(sendAttemptId);
    return Promise.resolve();
  }
  public expireStale(now: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.claims) {
      if (v.leaseUntil < now) {
        this.claims.delete(k);
        n++;
      }
    }
    return Promise.resolve(n);
  }
}

export interface AuditEvent {
  workspaceId: string;
  mailboxId?: string | null;
  eventType: string;
  sendIntentId?: string | null;
  sendAttemptId?: string | null;
  correlationId?: string | null;
  messageId?: string | null;
  detail?: Record<string, string | number | boolean>;
}

export class FakeAuditRepo implements AuditWriter {
  public readonly events: AuditEvent[] = [];
  public append(input: AuditEvent): Promise<void> {
    this.events.push(input);
    return Promise.resolve();
  }
}

/**
 * In-memory transport.sync_requests faithful to the real claim semantics: the
 * atomic claim is single-holder (a row can only be claimed by one caller per
 * pass), a fresh claim is never stolen, a stale claim past the lease is
 * reclaimable, and attempt_count is the bound. Insertion is via `seed` because
 * the worker itself never INSERTs (the DEFINER RPC does).
 */
export class FakeSyncRequestRepo implements SyncRequestStore {
  public readonly rows = new Map<string, SyncRequestRow>();
  private seq = 1;

  /** Test-only INSERT (stands in for the DEFINER RPC). */
  public seed(input: {
    workspaceId: string;
    mailboxId: string;
    folder?: string | null;
    status?: SyncRequestRow["status"];
    requestedAt?: Date;
    claimedAt?: Date | null;
    attemptCount?: number;
  }): SyncRequestRow {
    const id = `sync-req-${this.seq++}`;
    const row: SyncRequestRow = {
      id,
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      folder: input.folder ?? null,
      status: input.status ?? "pending",
      requestedBy: null,
      requestedAt: input.requestedAt ?? new Date(0),
      claimedAt: input.claimedAt ?? null,
      completedAt: null,
      attemptCount: input.attemptCount ?? 0,
      lastError: null,
    };
    this.rows.set(id, row);
    return row;
  }

  public claimBatch(input: {
    limit: number;
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
  }): Promise<SyncRequestRow[]> {
    const eligible = [...this.rows.values()]
      .filter(
        (r) =>
          r.attemptCount < input.maxAttempts &&
          (r.status === "pending" ||
            (r.status === "claimed" &&
              r.claimedAt !== null &&
              r.claimedAt.getTime() < input.leaseCutoff.getTime())),
      )
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, input.limit);
    const claimed: SyncRequestRow[] = [];
    for (const r of eligible) {
      const updated: SyncRequestRow = {
        ...r,
        status: "claimed",
        claimedAt: input.now,
        attemptCount: r.attemptCount + 1,
      };
      this.rows.set(r.id, updated);
      claimed.push(updated);
    }
    return Promise.resolve(claimed);
  }

  /**
   * Fenced lease renewal — same CAS semantics as the SQL implementation:
   * succeeds only while status='claimed' AND attempt_count equals the generation
   * the caller holds AND claimed_at equals the exact token the caller holds;
   * never touches attempt_count.
   */
  public renewLease(
    id: string,
    expectedGeneration: number,
    prevClaimedAt: Date,
    now: Date,
  ): Promise<Date | null> {
    const r = this.rows.get(id);
    if (
      r === undefined ||
      r.status !== "claimed" ||
      r.attemptCount !== expectedGeneration ||
      r.claimedAt === null ||
      r.claimedAt.getTime() !== prevClaimedAt.getTime()
    ) {
      return Promise.resolve(null);
    }
    this.rows.set(id, { ...r, claimedAt: now });
    return Promise.resolve(now);
  }

  public markCompleted(
    id: string,
    expectedGeneration: number,
    expectedToken: Date,
    now: Date,
  ): Promise<SyncRequestRow | null> {
    const r = this.rows.get(id);
    if (
      r === undefined ||
      r.status !== "claimed" ||
      r.attemptCount !== expectedGeneration ||
      r.claimedAt === null ||
      r.claimedAt.getTime() !== expectedToken.getTime()
    ) {
      return Promise.resolve(null);
    }
    const updated: SyncRequestRow = {
      ...r,
      status: "completed",
      completedAt: now,
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  public markFailed(input: {
    id: string;
    expectedGeneration: number;
    expectedToken: Date;
    now: Date;
    lastError: string;
  }): Promise<SyncRequestRow | null> {
    const r = this.rows.get(input.id);
    if (
      r === undefined ||
      r.status !== "claimed" ||
      r.attemptCount !== input.expectedGeneration ||
      r.claimedAt === null ||
      r.claimedAt.getTime() !== input.expectedToken.getTime()
    ) {
      return Promise.resolve(null);
    }
    const updated: SyncRequestRow = {
      ...r,
      status: "failed",
      completedAt: input.now,
      lastError: input.lastError.slice(0, 200),
    };
    this.rows.set(input.id, updated);
    return Promise.resolve(updated);
  }

  public reapExhausted(input: {
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
    lastError: string;
  }): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (
        r.status === "claimed" &&
        r.claimedAt !== null &&
        r.claimedAt.getTime() < input.leaseCutoff.getTime() &&
        r.attemptCount >= input.maxAttempts
      ) {
        this.rows.set(id, {
          ...r,
          status: "failed",
          completedAt: input.now,
          lastError: input.lastError.slice(0, 200),
        });
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  public getById(id: string): Promise<SyncRequestRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

export class FakeHeartbeatRepo implements HeartbeatWriter {
  public readonly beats: { workerId: string; state: string | null }[] = [];
  public beat(workerId: string, state: string | null): Promise<void> {
    this.beats.push({ workerId, state });
    return Promise.resolve();
  }
}
