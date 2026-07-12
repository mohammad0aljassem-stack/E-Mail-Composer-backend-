import type {
  DraftMirrorRow,
  MailboxFolderRow,
  MailboxRow,
  MailMessageMeta,
  SendAttemptRow,
  SendIntentRow,
  StoredCredential,
} from "../../src/domain/models.js";
import { canTransition, type SendState } from "../../src/domain/send-state.js";
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
} from "../../src/db/repository-interfaces.js";

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

export class FakeSendIntentRepo implements SendIntentReader {
  public readonly rows = new Map<string, SendIntentRow>();
  public getById(id: string): Promise<SendIntentRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

export class FakeSendAttemptRepo implements SendAttemptStore {
  public readonly rows = new Map<string, SendAttemptRow>();

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

export class FakeHeartbeatRepo implements HeartbeatWriter {
  public readonly beats: { workerId: string; state: string | null }[] = [];
  public beat(workerId: string, state: string | null): Promise<void> {
    this.beats.push({ workerId, state });
    return Promise.resolve();
  }
}
