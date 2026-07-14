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
} from "../domain/models.js";
import {
  MimeArtifactError,
  SnapshotUnavailableError,
} from "../domain/errors.js";
import type { SendState } from "../domain/send-state.js";
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
} from "./repository-interfaces.js";
import type { Queryable } from "./pool.js";

/**
 * True when a driver error is the given Postgres SQLSTATE. The private snapshot
 * accessors raise a uniform P0002 for every missing/legacy/inconsistent case;
 * we map ONLY that to a content-free SnapshotUnavailableError and never surface
 * the driver message (which could name a column).
 */
function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Repositories over the canonical transport schema, executed as the
 * least-privileged `transport_worker` role. Every method is a small,
 * single-statement operation; no long transaction spans a network call.
 *
 * Column mapping mirrors migration 20260713100000_transport_foundation.sql.
 * bigint columns arrive from `pg` as strings and are converted to BigInt here.
 */

function b(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  return BigInt(v as string | number);
}

function req(v: unknown): bigint {
  return BigInt(v as string | number);
}

function date(v: unknown): Date | null {
  return v === null || v === undefined ? null : new Date(v as string);
}

// ---------------------------------------------------------------------------
// Mailboxes (read-only for the worker)
// ---------------------------------------------------------------------------
export class MailboxRepository implements MailboxReader {
  public constructor(private readonly db: Queryable) {}

  public async getById(id: string): Promise<MailboxRow | null> {
    const r = await this.db.query(
      `select id, workspace_id, provider, email_address, display_name,
              imap_host, imap_port, imap_security, smtp_host, smtp_port,
              smtp_security, enabled, kill_switch, last_synced_at
         from public.mailboxes where id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  public async listEnabled(): Promise<MailboxRow[]> {
    const r = await this.db.query(
      `select id, workspace_id, provider, email_address, display_name,
              imap_host, imap_port, imap_security, smtp_host, smtp_port,
              smtp_security, enabled, kill_switch, last_synced_at
         from public.mailboxes
        where enabled = true and kill_switch = false`,
    );
    return r.rows.map((row) => this.map(row));
  }

  private map(row: Record<string, unknown>): MailboxRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      provider: "imap_smtp",
      emailAddress: row.email_address as string,
      displayName: (row.display_name as string | null) ?? null,
      imapHost: (row.imap_host as string | null) ?? null,
      imapPort: (row.imap_port as number | null) ?? null,
      imapSecurity: (row.imap_security as MailboxRow["imapSecurity"]) ?? null,
      smtpHost: (row.smtp_host as string | null) ?? null,
      smtpPort: (row.smtp_port as number | null) ?? null,
      smtpSecurity: (row.smtp_security as MailboxRow["smtpSecurity"]) ?? null,
      enabled: row.enabled as boolean,
      killSwitch: row.kill_switch as boolean,
      lastSyncedAt: date(row.last_synced_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Credentials (private transport schema; worker SELECT only)
// ---------------------------------------------------------------------------
export class CredentialRepository implements CredentialReader {
  public constructor(private readonly db: Queryable) {}

  public async getActiveByMailbox(
    mailboxId: string,
  ): Promise<StoredCredential | null> {
    const r = await this.db.query(
      `select id, mailbox_id, ciphertext, nonce, auth_tag, algorithm,
              key_version, aad
         from transport.mailbox_credentials
        where mailbox_id = $1 and revoked_at is null
        limit 1`,
      [mailboxId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id as string,
      mailboxId: row.mailbox_id as string,
      ciphertext: row.ciphertext as Buffer,
      nonce: row.nonce as Buffer,
      authTag: (row.auth_tag as Buffer | null) ?? null,
      algorithm: row.algorithm as string,
      keyVersion: row.key_version as number,
      aad: row.aad as string,
    };
  }
}

// ---------------------------------------------------------------------------
// Folders + sync cursors
// ---------------------------------------------------------------------------
export class FolderRepository implements FolderStore {
  public constructor(private readonly db: Queryable) {}

  public async upsertDiscovered(input: {
    workspaceId: string;
    mailboxId: string;
    name: string;
    role: MailboxFolderRow["role"];
    uidvalidity: bigint;
    uidnext: bigint;
  }): Promise<MailboxFolderRow> {
    const r = await this.db.query(
      `insert into public.mailbox_folders
         (workspace_id, mailbox_id, name, role, uidvalidity, uidnext)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (mailbox_id, name) do update
         set role = excluded.role,
             uidvalidity = excluded.uidvalidity,
             uidnext = excluded.uidnext
       returning *`,
      [
        input.workspaceId,
        input.mailboxId,
        input.name,
        input.role,
        input.uidvalidity.toString(),
        input.uidnext.toString(),
      ],
    );
    return this.map(r.rows[0] as Record<string, unknown>);
  }

  public async getByMailboxAndName(
    mailboxId: string,
    name: string,
  ): Promise<MailboxFolderRow | null> {
    const r = await this.db.query(
      `select * from public.mailbox_folders where mailbox_id = $1 and name = $2`,
      [mailboxId, name],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  /** SELECT-only role lookup (e.g. the discovered, possibly localized Sent). */
  public async findByRole(
    mailboxId: string,
    role: MailboxFolderRow["role"],
  ): Promise<MailboxFolderRow | null> {
    const r = await this.db.query(
      `select * from public.mailbox_folders
        where mailbox_id = $1 and role = $2
        order by name asc
        limit 1`,
      [mailboxId, role],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  /** Advance the sync cursor. Persisted ONLY after messages are durably stored. */
  public async updateCursor(input: {
    id: string;
    uidvalidity: bigint;
    uidnext: bigint;
    lastSeenUid: bigint;
    highestModseq: bigint | null;
  }): Promise<void> {
    await this.db.query(
      `update public.mailbox_folders
          set uidvalidity = $2, uidnext = $3, last_seen_uid = $4,
              highest_modseq = $5, last_synced_at = now()
        where id = $1`,
      [
        input.id,
        input.uidvalidity.toString(),
        input.uidnext.toString(),
        input.lastSeenUid.toString(),
        input.highestModseq === null ? null : input.highestModseq.toString(),
      ],
    );
  }

  /**
   * UIDVALIDITY changed: invalidate the old UID cursor for this folder. The old
   * UID namespace is abandoned (never mixed with the new one). Messages are NOT
   * silently deleted — auditability is preserved; a controlled resync repopulates.
   */
  public async resetForUidValidityChange(input: {
    id: string;
    newUidvalidity: bigint;
    newUidnext: bigint;
  }): Promise<void> {
    await this.db.query(
      `update public.mailbox_folders
          set uidvalidity = $2, uidnext = $3, last_seen_uid = 0,
              highest_modseq = null, last_synced_at = now()
        where id = $1`,
      [input.id, input.newUidvalidity.toString(), input.newUidnext.toString()],
    );
  }

  private map(row: Record<string, unknown>): MailboxFolderRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      mailboxId: row.mailbox_id as string,
      name: row.name as string,
      role: (row.role as MailboxFolderRow["role"]) ?? null,
      uidvalidity: b(row.uidvalidity),
      uidnext: b(row.uidnext),
      lastSeenUid: b(row.last_seen_uid),
      highestModseq: b(row.highest_modseq),
      lastSyncedAt: date(row.last_synced_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Messages (metadata only) — deterministic upsert on (folder, uidvalidity, uid)
// ---------------------------------------------------------------------------
export class MessageRepository implements MessageStore {
  public constructor(private readonly db: Queryable) {}

  public async upsertMeta(m: MailMessageMeta): Promise<void> {
    await this.db.query(
      `insert into public.mail_messages
         (workspace_id, mailbox_id, folder_id, uidvalidity, uid, message_id,
          in_reply_to, references_header, subject, from_summary, to_summary,
          internal_date, size_bytes, flags, has_attachments)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (folder_id, uidvalidity, uid) do update
         set message_id = excluded.message_id,
             in_reply_to = excluded.in_reply_to,
             references_header = excluded.references_header,
             subject = excluded.subject,
             from_summary = excluded.from_summary,
             to_summary = excluded.to_summary,
             internal_date = excluded.internal_date,
             size_bytes = excluded.size_bytes,
             flags = excluded.flags,
             has_attachments = excluded.has_attachments`,
      [
        m.workspaceId,
        m.mailboxId,
        m.folderId,
        m.uidvalidity.toString(),
        m.uid.toString(),
        m.messageId,
        m.inReplyTo,
        m.referencesHeader,
        m.subject,
        m.fromSummary,
        m.toSummary,
        m.internalDate,
        m.sizeBytes === null ? null : m.sizeBytes.toString(),
        m.flags,
        m.hasAttachments,
      ],
    );
  }

  public async countByFolder(folderId: string): Promise<number> {
    const r = await this.db.query(
      `select count(*)::int as n from public.mail_messages where folder_id = $1`,
      [folderId],
    );
    return (r.rows[0]?.n as number | undefined) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Draft mirrors (idempotent on draft_id + revision)
// ---------------------------------------------------------------------------
export class DraftMirrorRepository implements DraftMirrorStore {
  public constructor(private readonly db: Queryable) {}

  public async getByDraftAndMailbox(
    draftId: string,
    mailboxId: string,
  ): Promise<DraftMirrorRow | null> {
    const r = await this.db.query(
      `select * from public.draft_mirrors where draft_id = $1 and mailbox_id = $2`,
      [draftId, mailboxId],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  /**
   * Upsert the mirror. A newer local revision must NEVER be overwritten by an
   * older queued job: the WHERE clause on update only advances when the
   * incoming revision is >= the stored one.
   */
  public async upsert(input: {
    workspaceId: string;
    draftId: string;
    mailboxId: string;
    remoteUid: bigint | null;
    remoteUidvalidity: bigint | null;
    mirroredRevision: bigint;
    status: DraftMirrorRow["status"];
  }): Promise<DraftMirrorRow> {
    const r = await this.db.query(
      `insert into public.draft_mirrors
         (workspace_id, draft_id, mailbox_id, remote_uid, remote_uidvalidity,
          mirrored_revision, status)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (draft_id, mailbox_id) do update
         set remote_uid = excluded.remote_uid,
             remote_uidvalidity = excluded.remote_uidvalidity,
             mirrored_revision = excluded.mirrored_revision,
             status = excluded.status
         where excluded.mirrored_revision >=
               coalesce(public.draft_mirrors.mirrored_revision, 0)
       returning *`,
      [
        input.workspaceId,
        input.draftId,
        input.mailboxId,
        input.remoteUid === null ? null : input.remoteUid.toString(),
        input.remoteUidvalidity === null
          ? null
          : input.remoteUidvalidity.toString(),
        input.mirroredRevision.toString(),
        input.status,
      ],
    );
    const row = r.rows[0];
    if (row === undefined) {
      // The guard rejected a stale revision; return the current row unchanged.
      const current = await this.getByDraftAndMailbox(
        input.draftId,
        input.mailboxId,
      );
      if (current === null) {
        throw new Error("draft mirror upsert returned no row");
      }
      return current;
    }
    return this.map(row);
  }

  private map(row: Record<string, unknown>): DraftMirrorRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      draftId: row.draft_id as string,
      mailboxId: row.mailbox_id as string,
      remoteUid: b(row.remote_uid),
      remoteUidvalidity: b(row.remote_uidvalidity),
      mirroredRevision: b(row.mirrored_revision),
      status: row.status as DraftMirrorRow["status"],
    };
  }
}

// ---------------------------------------------------------------------------
// Confirmed-send snapshots (PRIVATE worker accessors; EXECUTE only)
// ---------------------------------------------------------------------------
/**
 * The worker's ONLY read path for confirmed SEND content: the private
 * transport.get_send_snapshot(send_intent_id) SECURITY DEFINER function
 * (20260716100000). The worker has EXECUTE on it (canonical grant) but NO table
 * grant on public.draft_versions, so it can never read the mutable draft, a
 * near-miss revision, or a caller-supplied snapshot id — the intent id is the
 * sole key. The function raises a uniform P0002 for a missing/legacy/
 * inconsistent intent; we map ONLY that to a content-free
 * SnapshotUnavailableError (the resolver fails closed — zero SMTP bytes).
 */
export class SendSnapshotRepository implements SendSnapshotReader {
  public constructor(private readonly db: Queryable) {}

  public async getSendSnapshot(sendIntentId: string): Promise<SendSnapshotRow> {
    let r;
    try {
      r = await this.db.query(
        `select draft_version_id, workspace_id, draft_id, source_revision,
                version_no, subject, body_json
           from transport.get_send_snapshot($1)`,
        [sendIntentId],
      );
    } catch (err) {
      if (isPgError(err, "P0002")) throw new SnapshotUnavailableError();
      throw err;
    }
    const row = r.rows[0];
    if (row === undefined) throw new SnapshotUnavailableError();
    return {
      draftVersionId: row.draft_version_id as string,
      workspaceId: row.workspace_id as string,
      draftId: row.draft_id as string,
      sourceRevision: req(row.source_revision),
      versionNo: req(row.version_no),
      subject: row.subject as string,
      bodyJson: row.body_json,
    };
  }
}

/**
 * The worker's read path for MIRRORING a known revision: the private
 * transport.get_mirror_snapshot(workspace_id, draft_id, source_revision)
 * SECURITY DEFINER function (20260716100000). Returns the newest snapshot for
 * that EXACT triple; a uniform P0002 (no such snapshot — including any workspace
 * mismatch) becomes a content-free SnapshotUnavailableError, which the mirror
 * resolver maps to a skip. Never used for sending.
 */
export class MirrorSnapshotRepository implements MirrorSnapshotReader {
  public constructor(private readonly db: Queryable) {}

  public async getMirrorSnapshot(
    workspaceId: string,
    draftId: string,
    sourceRevision: bigint,
  ): Promise<MirrorSnapshotRow> {
    let r;
    try {
      r = await this.db.query(
        `select draft_version_id, version_no, subject, body_json
           from transport.get_mirror_snapshot($1, $2, $3)`,
        [workspaceId, draftId, sourceRevision.toString()],
      );
    } catch (err) {
      if (isPgError(err, "P0002")) throw new SnapshotUnavailableError();
      throw err;
    }
    const row = r.rows[0];
    if (row === undefined) throw new SnapshotUnavailableError();
    return {
      draftVersionId: row.draft_version_id as string,
      versionNo: req(row.version_no),
      subject: row.subject as string,
      bodyJson: row.body_json,
    };
  }
}

// ---------------------------------------------------------------------------
// Send intents (immutable snapshot; worker SELECT only)
// ---------------------------------------------------------------------------
export class SendIntentRepository implements SendIntentReader {
  public constructor(private readonly db: Queryable) {}

  public async getById(id: string): Promise<SendIntentRow | null> {
    const r = await this.db.query(
      `select * from public.send_intents where id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  private map(row: Record<string, unknown>): SendIntentRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      mailboxId: row.mailbox_id as string,
      draftId: row.draft_id as string,
      draftRevision: req(row.draft_revision),
      sender: row.sender as string,
      recipients: row.recipients as SendIntentRow["recipients"],
      subject: row.subject as string,
      htmlHash: (row.html_hash as string | null) ?? null,
      textHash: (row.text_hash as string | null) ?? null,
      attachmentManifest:
        row.attachment_manifest as SendIntentRow["attachmentManifest"],
      messageId: row.message_id as string,
      idempotencyKey: row.idempotency_key as string,
      templateVersionId: (row.template_version_id as string | null) ?? null,
      signatureId: (row.signature_id as string | null) ?? null,
      confirmedBy: row.confirmed_by as string,
      confirmationProof: row.confirmation_proof as string,
      contractVersion: row.contract_version as number,
      proofVersion: row.proof_version as number,
      draftVersionId: (row.draft_version_id as string | null) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Send attempts (outbound state machine; compare-and-set transitions)
// ---------------------------------------------------------------------------
export class SendAttemptRepository implements SendAttemptStore {
  public constructor(private readonly db: Queryable) {}

  public async getById(id: string): Promise<SendAttemptRow | null> {
    const r = await this.db.query(
      `select * from public.send_attempts where id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  public async getBySendIntent(
    sendIntentId: string,
  ): Promise<SendAttemptRow | null> {
    const r = await this.db.query(
      `select * from public.send_attempts where send_intent_id = $1
         order by created_at asc limit 1`,
      [sendIntentId],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  /**
   * Version-guarded transition. Advances state + bumps version ONLY when the
   * row is still at (expectedState, expectedVersion). The DB trigger
   * additionally rejects illegal transitions and version rollback. Returns the
   * new row, or null if the CAS lost (someone else moved it).
   */
  public async compareAndSet(input: {
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
    const f = input.fields ?? {};
    const r = await this.db.query(
      `update public.send_attempts
          set state = $4,
              version = version + 1,
              claimed_by = coalesce($5, claimed_by),
              claimed_at = coalesce($6, claimed_at),
              message_id = coalesce($7, message_id),
              smtp_response = coalesce($8, smtp_response),
              evidence = case when $9::jsonb is null then evidence
                              else evidence || $9::jsonb end
        where id = $1 and version = $2 and state = $3
      returning *`,
      [
        input.id,
        input.expectedVersion.toString(),
        input.expectedState,
        input.toState,
        f.claimedBy ?? null,
        f.claimedAt ?? null,
        f.messageId ?? null,
        f.smtpResponse ?? null,
        f.evidence === undefined ? null : JSON.stringify(f.evidence),
      ],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  private map(row: Record<string, unknown>): SendAttemptRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      sendIntentId: row.send_intent_id as string,
      state: row.state as SendState,
      claimedBy: (row.claimed_by as string | null) ?? null,
      claimedAt: date(row.claimed_at),
      messageId: (row.message_id as string | null) ?? null,
      smtpResponse: (row.smtp_response as string | null) ?? null,
      evidence: (row.evidence as SendAttemptRow["evidence"]) ?? {},
      version: req(row.version),
    };
  }
}

// ---------------------------------------------------------------------------
// Exact MIME artifacts (PRIVATE transport schema; worker EXECUTE + SELECT/UPDATE)
// ---------------------------------------------------------------------------
/**
 * The worker's exact-MIME-artifact store. Creation goes EXCLUSIVELY through the
 * SECURITY DEFINER function transport.create_or_verify_send_mime_artifact (the
 * worker has EXECUTE on it and NO direct INSERT — the function INSERTs as its
 * definer): this class issues NO direct INSERT on the table.
 * The function first-creates the artifact only while the attempt is 'claimed'
 * and re-hashes the caller bytes on every call, VERIFYING on a second identical
 * call (restart/reconciliation); a uniform 23514 becomes a content-free
 * MimeArtifactError. `getBySendAttempt` is a plain SELECT (worker grant) that
 * loads the EXACT stored bytes for the Sent-copy append on restart.
 */
export class MimeArtifactRepository implements MimeArtifactStore {
  public constructor(private readonly db: Queryable) {}

  public async createOrVerify(input: {
    sendAttemptId: string;
    sendIntentId: string;
    workspaceId: string;
    messageId: string;
    mimeSha256: string;
    sizeBytes: bigint;
    rawMime: Buffer;
  }): Promise<MimeArtifactRow> {
    let r;
    try {
      r = await this.db.query(
        `select id, send_attempt_id, send_intent_id, workspace_id, message_id,
                mime_sha256, size_bytes, raw_mime, cleared_at
           from transport.create_or_verify_send_mime_artifact(
             $1, $2, $3, $4, $5, $6, $7)`,
        [
          input.sendAttemptId,
          input.sendIntentId,
          input.workspaceId,
          input.messageId,
          input.mimeSha256,
          input.sizeBytes.toString(),
          input.rawMime,
        ],
      );
    } catch (err) {
      // The function raises a uniform, non-disclosing 23514 for every
      // create/verify rejection. Map ONLY that to a content-free error; never
      // surface the driver message.
      if (isPgError(err, "23514")) throw new MimeArtifactError();
      throw err;
    }
    const row = r.rows[0];
    if (row === undefined) throw new MimeArtifactError();
    return this.map(row);
  }

  public async getBySendAttempt(
    sendAttemptId: string,
  ): Promise<MimeArtifactRow | null> {
    const r = await this.db.query(
      `select id, send_attempt_id, send_intent_id, workspace_id, message_id,
              mime_sha256, size_bytes, raw_mime, cleared_at
         from transport.send_mime_artifacts
        where send_attempt_id = $1`,
      [sendAttemptId],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  private map(row: Record<string, unknown>): MimeArtifactRow {
    return {
      id: row.id as string,
      sendAttemptId: row.send_attempt_id as string,
      sendIntentId: row.send_intent_id as string,
      workspaceId: row.workspace_id as string,
      messageId: row.message_id as string,
      mimeSha256: row.mime_sha256 as string,
      sizeBytes: req(row.size_bytes),
      rawMime: (row.raw_mime as Buffer | null) ?? null,
      clearedAt: date(row.cleared_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Worker claims (atomic lease — at most one worker per attempt)
// ---------------------------------------------------------------------------
export class WorkerClaimRepository implements WorkerClaimStore {
  public constructor(private readonly db: Queryable) {}

  /**
   * Atomically claim an attempt. INSERT ... ON CONFLICT DO NOTHING means only
   * ONE worker can hold the (unique) send_attempt_id row. Returns true iff we
   * won the claim.
   */
  public async tryClaim(input: {
    sendAttemptId: string;
    workerId: string;
    leaseUntil: Date;
  }): Promise<boolean> {
    const r = await this.db.query(
      `insert into transport.worker_claims
         (send_attempt_id, worker_id, lease_until)
       values ($1,$2,$3)
       on conflict (send_attempt_id) do nothing
       returning id`,
      [input.sendAttemptId, input.workerId, input.leaseUntil],
    );
    return r.rows.length > 0;
  }

  public async heartbeat(
    sendAttemptId: string,
    leaseUntil: Date,
  ): Promise<void> {
    await this.db.query(
      `update transport.worker_claims
          set heartbeat_at = now(), lease_until = $2
        where send_attempt_id = $1`,
      [sendAttemptId, leaseUntil],
    );
  }

  public async release(sendAttemptId: string): Promise<void> {
    await this.db.query(
      `delete from transport.worker_claims where send_attempt_id = $1`,
      [sendAttemptId],
    );
  }

  /** Remove leases that have expired so a stalled attempt can be re-driven. */
  public async expireStale(now: Date): Promise<number> {
    const r = await this.db.query(
      `delete from transport.worker_claims where lease_until < $1 returning id`,
      [now],
    );
    return r.rows.length;
  }
}

// ---------------------------------------------------------------------------
// Audit (content-free, append-only)
// ---------------------------------------------------------------------------
export class AuditRepository implements AuditWriter {
  public constructor(private readonly db: Queryable) {}

  public async append(input: {
    workspaceId: string;
    mailboxId?: string | null;
    eventType: string;
    sendIntentId?: string | null;
    sendAttemptId?: string | null;
    correlationId?: string | null;
    messageId?: string | null;
    detail?: Record<string, string | number | boolean>;
  }): Promise<void> {
    await this.db.query(
      `insert into public.transport_audit
         (workspace_id, mailbox_id, event_type, send_intent_id, send_attempt_id,
          correlation_id, message_id, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.workspaceId,
        input.mailboxId ?? null,
        input.eventType,
        input.sendIntentId ?? null,
        input.sendAttemptId ?? null,
        input.correlationId ?? null,
        input.messageId ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Durable sync requests (transport.sync_requests) — worker SELECT + UPDATE only
// ---------------------------------------------------------------------------
export class SyncRequestRepository implements SyncRequestStore {
  public constructor(private readonly db: Queryable) {}

  /**
   * Single-statement, concurrency-safe claim. The inner SELECT ... FOR UPDATE
   * SKIP LOCKED locks only rows no other transaction holds, so two workers can
   * never claim the same request; the outer UPDATE advances exactly those rows.
   * Eligibility: pending, OR a STALE claim (claimed_at < leaseCutoff), always
   * bounded by attempt_count < maxAttempts. Ordered by requested_at (FIFO) for
   * baseline fairness; per-workspace execution fairness is the pg-boss job group.
   */
  public async claimBatch(input: {
    limit: number;
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
  }): Promise<SyncRequestRow[]> {
    const r = await this.db.query(
      `update transport.sync_requests s
          set status = 'claimed',
              claimed_at = $1,
              attempt_count = s.attempt_count + 1
        where s.id in (
          select id from transport.sync_requests
           where attempt_count < $4
             and ( status = 'pending'
                   or (status = 'claimed' and claimed_at < $2) )
           order by requested_at
           for update skip locked
           limit $3
        )
      returning s.*`,
      [input.now, input.leaseCutoff, input.limit, input.maxAttempts],
    );
    return r.rows.map((row) => this.map(row));
  }

  /**
   * Fenced lease renewal (single atomic CAS on the generation+token tuple).
   * Succeeds ONLY when the row is still `claimed` AND attempt_count equals the
   * generation the caller holds AND claimed_at equals the exact token the caller
   * holds; a lost CAS (another claimant re-claimed — bumping generation and/or
   * moving the token — or the request went terminal) returns null and the caller
   * must stop without marking anything. attempt_count is deliberately NOT touched:
   * renewals are not re-claims (the generation is unchanged; only the token moves).
   */
  public async renewLease(
    id: string,
    expectedGeneration: number,
    prevClaimedAt: Date,
    now: Date,
  ): Promise<Date | null> {
    const r = await this.db.query(
      `update transport.sync_requests
          set claimed_at = $4
        where id = $1 and status = 'claimed'
          and attempt_count = $2 and claimed_at = $3
      returning claimed_at`,
      [id, expectedGeneration, prevClaimedAt, now],
    );
    const row = r.rows[0];
    return row === undefined ? null : date(row.claimed_at);
  }

  public async markCompleted(
    id: string,
    expectedGeneration: number,
    expectedToken: Date,
    now: Date,
  ): Promise<SyncRequestRow | null> {
    const r = await this.db.query(
      `update transport.sync_requests
          set status = 'completed', completed_at = $4
        where id = $1 and status = 'claimed'
          and attempt_count = $2 and claimed_at = $3
      returning *`,
      [id, expectedGeneration, expectedToken, now],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  public async markFailed(input: {
    id: string;
    expectedGeneration: number;
    expectedToken: Date;
    now: Date;
    lastError: string;
  }): Promise<SyncRequestRow | null> {
    const r = await this.db.query(
      `update transport.sync_requests
          set status = 'failed', completed_at = $4, last_error = $5
        where id = $1 and status = 'claimed'
          and attempt_count = $2 and claimed_at = $3
      returning *`,
      [
        input.id,
        input.expectedGeneration,
        input.expectedToken,
        input.now,
        boundedCode(input.lastError),
      ],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  public async reapExhausted(input: {
    now: Date;
    leaseCutoff: Date;
    maxAttempts: number;
    lastError: string;
  }): Promise<number> {
    const r = await this.db.query(
      `update transport.sync_requests
          set status = 'failed', completed_at = $1, last_error = $4
        where status = 'claimed'
          and claimed_at < $2
          and attempt_count >= $3
      returning id`,
      [
        input.now,
        input.leaseCutoff,
        input.maxAttempts,
        boundedCode(input.lastError),
      ],
    );
    return r.rows.length;
  }

  public async getById(id: string): Promise<SyncRequestRow | null> {
    const r = await this.db.query(
      `select * from transport.sync_requests where id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : this.map(row);
  }

  private map(row: Record<string, unknown>): SyncRequestRow {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      mailboxId: row.mailbox_id as string,
      folder: (row.folder as string | null) ?? null,
      status: row.status as SyncRequestRow["status"],
      requestedBy: (row.requested_by as string | null) ?? null,
      requestedAt: new Date(row.requested_at as string),
      claimedAt: date(row.claimed_at),
      completedAt: date(row.completed_at),
      attemptCount: Number(row.attempt_count),
      lastError: (row.last_error as string | null) ?? null,
    };
  }
}

/**
 * Enforce the content-free, bounded invariant on last_error at the repository
 * boundary too (belt and suspenders with the DB CHECK <= 2000): a short code
 * only, never any body/MIME/credential/provider payload.
 */
function boundedCode(code: string): string {
  return code.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Worker heartbeats (liveness; no content)
// ---------------------------------------------------------------------------
export class HeartbeatRepository implements HeartbeatWriter {
  public constructor(private readonly db: Queryable) {}

  public async beat(workerId: string, state: string | null): Promise<void> {
    await this.db.query(
      `insert into transport.worker_heartbeats (worker_id, last_seen, state)
       values ($1, now(), $2)
       on conflict (worker_id) do update
         set last_seen = now(), state = excluded.state`,
      [workerId, state],
    );
  }
}
