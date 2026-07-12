import type {
  DraftMirrorRow,
  MailboxFolderRow,
  MailboxRow,
  MailMessageMeta,
  SendAttemptRow,
  SendIntentRow,
  StoredCredential,
} from "../domain/models.js";
import type { SendState } from "../domain/send-state.js";
import type {
  AuditWriter,
  CredentialReader,
  DraftMirrorStore,
  FolderStore,
  HeartbeatWriter,
  MailboxReader,
  MessageStore,
  SendAttemptStore,
  SendIntentReader,
  WorkerClaimStore,
} from "./repository-interfaces.js";
import type { Queryable } from "./pool.js";

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
