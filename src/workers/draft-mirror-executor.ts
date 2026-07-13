import { TransportError } from "../domain/errors.js";
import type { MailboxRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type {
  AuditWriter,
  DraftMirrorStore,
  MailboxReader,
} from "../db/repository-interfaces.js";
import type { ProviderFactory } from "./ports.js";

/**
 * Draft-mirror executor. Idempotent on (draftId, immutable revision).
 *
 * IMAP has no in-place update: mirroring appends (assigning a NEW UID), and a
 * replace is append-then-retire (\Deleted the old UID). An interruption must not
 * create an uncontrolled duplicate draft (the provider appends first, retires
 * second). A newer local revision must never be overwritten by an older queued
 * job — the mirror upsert guard rejects a stale revision. The stored remote UID
 * is namespaced by its UIDVALIDITY.
 *
 * May be disabled by default operationally, but the state machine + tests are
 * complete.
 */

export interface DraftPayload {
  readonly revision: bigint;
  readonly mime: Buffer;
}

/** Reconstructs the exact draft MIME for a (draftId, revision). */
export interface DraftPayloadResolver {
  resolve(draftId: string, revision: bigint): Promise<DraftPayload | null>;
}

export interface DraftMirrorExecutorDeps {
  mailboxes: MailboxReader;
  mirrors: DraftMirrorStore;
  audit: AuditWriter;
  providerFactory: ProviderFactory;
  payloadResolver: DraftPayloadResolver;
  logger: Logger;
  config: { draftsFolder: string };
}

export interface DraftMirrorJobInput {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly draftId: string;
  readonly revision: bigint;
}

export type DraftMirrorOutcome =
  "mirrored" | "skipped_stale" | "skipped_missing_payload";

export class DraftMirrorExecutor {
  public constructor(private readonly deps: DraftMirrorExecutorDeps) {}

  public async execute(job: DraftMirrorJobInput): Promise<DraftMirrorOutcome> {
    const log = this.deps.logger.child({
      component: "draft-mirror-executor",
      mailboxId: job.mailboxId,
      draftId: job.draftId,
    });

    const existing = await this.deps.mirrors.getByDraftAndMailbox(
      job.draftId,
      job.mailboxId,
    );
    // Never overwrite a newer revision with an older queued job.
    if (
      existing !== null &&
      existing.mirroredRevision !== null &&
      existing.mirroredRevision >= job.revision
    ) {
      log.info("draft_mirror_skipped_stale", {
        stored: existing.mirroredRevision.toString(),
        job: job.revision.toString(),
      });
      return "skipped_stale";
    }

    const payload = await this.deps.payloadResolver.resolve(
      job.draftId,
      job.revision,
    );
    if (payload === null) {
      log.warn("draft_mirror_missing_payload");
      return "skipped_missing_payload";
    }

    const mailbox = await this.requireMailbox(job.mailboxId);
    // IMAP session ONLY — draft mirroring must never construct an SMTP client.
    const provider = await this.deps.providerFactory.createImapSession(mailbox);
    try {
      const previousUid =
        existing?.remoteUid !== undefined ? existing.remoteUid : null;
      const appended = await provider.replaceOrSupersedeDraft(
        this.deps.config.draftsFolder,
        previousUid,
        payload.mime,
      );

      await this.deps.mirrors.upsert({
        workspaceId: job.workspaceId,
        draftId: job.draftId,
        mailboxId: job.mailboxId,
        remoteUid: appended.uid,
        remoteUidvalidity: appended.uidvalidity,
        mirroredRevision: job.revision,
        status: "mirrored",
      });

      await this.deps.audit.append({
        workspaceId: job.workspaceId,
        mailboxId: job.mailboxId,
        eventType: "draft_mirrored",
        detail: { revision: job.revision.toString() },
      });
      log.info("draft_mirrored", { revision: job.revision.toString() });
      return "mirrored";
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
  }

  private async requireMailbox(mailboxId: string): Promise<MailboxRow> {
    const mailbox = await this.deps.mailboxes.getById(mailboxId);
    if (mailbox === null) {
      throw new TransportError("not_found", "mailbox not found");
    }
    if (!mailbox.enabled || mailbox.killSwitch) {
      throw new TransportError("mailbox_disabled", "mailbox not usable");
    }
    return mailbox;
  }
}
