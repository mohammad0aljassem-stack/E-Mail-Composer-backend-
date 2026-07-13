import type { MailboxRow } from "../../src/domain/models.js";
import type {
  ImapSessionProvider,
  SubmissionProvider,
} from "../../src/providers/mail-provider.js";
import {
  ImapSmtpProvider,
  SmtpSubmission,
} from "../../src/providers/imap-smtp/imap-smtp-provider.js";
import type { ProviderFactory } from "../../src/workers/ports.js";
import { FakeImapClient, type FakeImapServer } from "./fake-imap.js";
import { FakeSmtpClient } from "./fake-smtp.js";

/**
 * ProviderFactory that assembles the REAL ImapSmtpProvider / SmtpSubmission
 * over the in-repo fake protocol clients. This exercises the provider logic
 * (append-then-retire, Sent-copy search, Message-ID reuse) while keeping
 * delivery deterministic.
 *
 * CONSTRUCTION COUNTERS (C1): tests assert capability scoping with them —
 * read-only work (sync/mutation/mirror/reconciliation) must finish with
 * submissionsCreated === 0, and a guard failure on the send path must never
 * have constructed a submission.
 */
export class FakeProviderFactory implements ProviderFactory {
  /** IMAP session construction attempts (counted even if verifyImap fails). */
  public imapSessionsCreated = 0;
  /** SMTP submission constructions — the SMTP capability, never implicit. */
  public submissionsCreated = 0;

  public constructor(
    public readonly server: FakeImapServer,
    public readonly smtp: FakeSmtpClient,
  ) {}

  public async createImapSession(
    _mailbox: MailboxRow,
  ): Promise<ImapSessionProvider> {
    this.imapSessionsCreated += 1;
    const imap = new FakeImapClient(this.server);
    const session = new ImapSmtpProvider({ imap });
    await session.verifyImap();
    return session;
  }

  public createSubmission(_mailbox: MailboxRow): Promise<SubmissionProvider> {
    this.submissionsCreated += 1;
    return Promise.resolve(new SmtpSubmission({ smtp: this.smtp }));
  }
}
