import { TransportError } from "../domain/errors.js";
import type { MailboxRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type {
  AuditWriter,
  MailboxReader,
} from "../db/repository-interfaces.js";
import type { FolderMutation } from "../providers/mail-provider.js";
import type { ProviderFactory } from "./ports.js";

/**
 * Applies a naturally-idempotent folder mutation (flag add/remove, move). These
 * are safe to retry with deterministic keys; the queue policy allows bounded
 * retries for this family only.
 */
export interface MutationExecutorDeps {
  mailboxes: MailboxReader;
  audit: AuditWriter;
  providerFactory: ProviderFactory;
  logger: Logger;
  config: {
    /**
     * Global kill switch. Checked first in execute() so an already-enqueued
     * mutation never opens IMAP after the switch flips.
     */
    globalKillSwitch: boolean;
  };
}

export interface MutationJobInput {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly mutation: FolderMutation;
}

export class MutationExecutor {
  public constructor(private readonly deps: MutationExecutorDeps) {}

  public async execute(job: MutationJobInput): Promise<void> {
    const log = this.deps.logger.child({
      component: "mutation-executor",
      mailboxId: job.mailboxId,
      kind: job.mutation.kind,
    });
    // Global kill switch: skip content-free BEFORE any provider/IMAP contact.
    if (this.deps.config.globalKillSwitch) {
      log.warn("mutation_skipped_global_kill_switch");
      return;
    }
    const mailbox = await this.requireMailbox(job.mailboxId);
    const provider = await this.deps.providerFactory.create(mailbox);
    try {
      await provider.applyMutation(job.mutation);
      await this.deps.audit.append({
        workspaceId: job.workspaceId,
        mailboxId: job.mailboxId,
        eventType: "mutation_applied",
        detail: { kind: job.mutation.kind },
      });
      log.info("mutation_applied");
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
