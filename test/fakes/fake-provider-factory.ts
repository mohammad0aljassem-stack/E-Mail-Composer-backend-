import type { MailboxRow } from "../../src/domain/models.js";
import type { MailProvider } from "../../src/providers/mail-provider.js";
import { ImapSmtpProvider } from "../../src/providers/imap-smtp/imap-smtp-provider.js";
import type { ProviderFactory } from "../../src/workers/ports.js";
import { FakeImapClient, type FakeImapServer } from "./fake-imap.js";
import { FakeSmtpClient } from "./fake-smtp.js";

/**
 * ProviderFactory that assembles the REAL ImapSmtpProvider over the in-repo
 * fake protocol clients. This exercises the provider logic (append-then-retire,
 * Sent-copy search, Message-ID reuse) while keeping delivery deterministic.
 */
export class FakeProviderFactory implements ProviderFactory {
  public createdCount = 0;
  public constructor(
    public readonly server: FakeImapServer,
    public readonly smtp: FakeSmtpClient,
  ) {}

  public async create(_mailbox: MailboxRow): Promise<MailProvider> {
    this.createdCount += 1;
    const imap = new FakeImapClient(this.server);
    const provider = new ImapSmtpProvider({ imap, smtp: this.smtp });
    await provider.verifyConnection();
    return provider;
  }
}
