import type { Clock } from "../domain/clock.js";
import { TransportError } from "../domain/errors.js";
import type { MailboxRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type {
  AuditWriter,
  FolderStore,
  MailboxReader,
  MessageStore,
} from "../db/repository-interfaces.js";
import type { SyncCursor } from "../providers/mail-provider.js";
import type { ProviderFactory } from "./ports.js";

/**
 * IMAP synchronization executor.
 *
 * Correctness rules:
 *  - Sync identity is (folder, uidvalidity, uid); upserts are deterministic so
 *    repeated/duplicate jobs never create duplicate rows.
 *  - The folder cursor is persisted ONLY AFTER messages are durably stored.
 *  - A UIDVALIDITY change is detected explicitly: the old UID cursor is
 *    invalidated, new UIDs are never mixed into the old namespace, no message is
 *    silently deleted (auditability preserved), and a controlled resync is
 *    signalled to the caller.
 */

export interface SyncExecutorDeps {
  mailboxes: MailboxReader;
  folders: FolderStore;
  messages: MessageStore;
  audit: AuditWriter;
  providerFactory: ProviderFactory;
  clock: Clock;
  logger: Logger;
  config: {
    batchSize: number;
    /**
     * Global kill switch. Dispatch already filters new work, but an
     * already-enqueued job must ALSO refuse to open IMAP after the switch
     * flips — checked first in execute(), before any provider is created.
     */
    globalKillSwitch: boolean;
  };
}

export interface SyncJob {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly folder: string;
  readonly mode: "initial" | "incremental";
}

export interface SyncResult {
  readonly persisted: number;
  readonly uidValidityChanged: boolean;
  /** True when the caller should enqueue a follow-up incremental sync. */
  readonly needsFollowUp: boolean;
}

export class SyncExecutor {
  public constructor(private readonly deps: SyncExecutorDeps) {}

  public async execute(job: SyncJob): Promise<SyncResult> {
    const log = this.deps.logger.child({
      component: "sync-executor",
      mailboxId: job.mailboxId,
      folder: job.folder,
      mode: job.mode,
    });

    // Global kill switch: skip content-free BEFORE any provider/IMAP contact.
    if (this.deps.config.globalKillSwitch) {
      log.warn("sync_skipped_global_kill_switch");
      return { persisted: 0, uidValidityChanged: false, needsFollowUp: false };
    }

    const mailbox = await this.requireSyncableMailbox(job.mailboxId);
    // IMAP session ONLY — read-only sync must never construct an SMTP client.
    const provider = await this.deps.providerFactory.createImapSession(mailbox);
    try {
      // Initial mode: (re)discover folders so roles + uidvalidity are current.
      if (job.mode === "initial") {
        const discovered = await provider.discoverFolders();
        for (const f of discovered) {
          await this.deps.folders.upsertDiscovered({
            workspaceId: job.workspaceId,
            mailboxId: job.mailboxId,
            name: f.name,
            role: f.role,
            uidvalidity: f.uidvalidity,
            uidnext: f.uidnext,
          });
        }
      }

      const folderRow = await this.deps.folders.getByMailboxAndName(
        job.mailboxId,
        job.folder,
      );
      if (folderRow === null) {
        throw new TransportError("not_found", "folder not discovered", {
          context: { folder: job.folder },
        });
      }

      const cursor: SyncCursor | null =
        folderRow.uidvalidity !== null && job.mode === "incremental"
          ? {
              uidvalidity: folderRow.uidvalidity,
              uidnext: folderRow.uidnext ?? 0n,
              lastSeenUid: folderRow.lastSeenUid ?? 0n,
              highestModseq: folderRow.highestModseq,
            }
          : null;

      const result = await provider.synchronizeFolder(job.folder, cursor, {
        batchSize: this.deps.config.batchSize,
      });

      // UIDVALIDITY change → invalidate old cursor, controlled resync.
      if (result.uidValidityChanged) {
        await this.deps.folders.resetForUidValidityChange({
          id: folderRow.id,
          newUidvalidity: result.cursor.uidvalidity,
          newUidnext: result.cursor.uidnext,
        });
        await this.deps.audit.append({
          workspaceId: job.workspaceId,
          mailboxId: job.mailboxId,
          eventType: "uidvalidity_changed",
          detail: { folder: job.folder },
        });
        log.warn("uidvalidity_changed");
        return { persisted: 0, uidValidityChanged: true, needsFollowUp: true };
      }

      // Persist messages FIRST (durable), THEN advance the cursor.
      for (const m of result.messages) {
        await this.deps.messages.upsertMeta({
          workspaceId: job.workspaceId,
          mailboxId: job.mailboxId,
          folderId: folderRow.id,
          uidvalidity: m.uidvalidity,
          uid: m.uid,
          messageId: m.messageId,
          inReplyTo: m.inReplyTo,
          referencesHeader: m.referencesHeader,
          subject: m.subject,
          fromSummary: m.fromSummary,
          toSummary: m.toSummary,
          internalDate: m.internalDate,
          sizeBytes: m.sizeBytes,
          flags: [...m.flags],
          hasAttachments: m.hasAttachments,
        });
      }

      await this.deps.folders.updateCursor({
        id: folderRow.id,
        uidvalidity: result.cursor.uidvalidity,
        uidnext: result.cursor.uidnext,
        lastSeenUid: result.cursor.lastSeenUid,
        highestModseq: result.cursor.highestModseq,
      });

      // A full batch implies there may be more to fetch → follow-up.
      const needsFollowUp =
        result.messages.length >= this.deps.config.batchSize;
      log.info("sync_persisted", {
        count: result.messages.length,
        needsFollowUp,
      });
      return {
        persisted: result.messages.length,
        uidValidityChanged: false,
        needsFollowUp,
      };
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
  }

  private async requireSyncableMailbox(mailboxId: string): Promise<MailboxRow> {
    const mailbox = await this.deps.mailboxes.getById(mailboxId);
    if (mailbox === null) {
      throw new TransportError("not_found", "mailbox not found");
    }
    if (!mailbox.enabled || mailbox.killSwitch) {
      throw new TransportError("mailbox_disabled", "mailbox not syncable");
    }
    return mailbox;
  }
}

/**
 * Act on `SyncResult.needsFollowUp`: enqueue exactly ONE incremental sync for
 * the same mailbox+folder so a multi-batch backlog drains instead of stalling.
 * The mailbox+folder singletonKey dedups the enqueue; the workspace group is
 * preserved by the enqueue implementation. Content-free logging (ids + folder
 * name only). Called from the sync_mailbox job handler; unit-tested directly.
 */
export async function enqueueSyncFollowUp(input: {
  result: SyncResult;
  job: SyncJob;
  enqueueSync: (job: {
    workspaceId: string;
    mailboxId: string;
    folder: string;
    mode: "incremental";
  }) => Promise<string | null>;
  logger: Logger;
}): Promise<boolean> {
  if (!input.result.needsFollowUp) return false;
  await input.enqueueSync({
    workspaceId: input.job.workspaceId,
    mailboxId: input.job.mailboxId,
    folder: input.job.folder,
    mode: "incremental",
  });
  input.logger.info("sync_follow_up_enqueued", {
    mailboxId: input.job.mailboxId,
    folder: input.job.folder,
  });
  return true;
}
