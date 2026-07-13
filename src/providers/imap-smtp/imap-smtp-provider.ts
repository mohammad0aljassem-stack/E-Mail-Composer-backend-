import { buildOutboundMime } from "../../mime/outbound-builder.js";
import type {
  AppendResult,
  DiscoveredFolder,
  FetchedMessageMeta,
  FolderMutation,
  IdleChange,
  ImapSessionProvider,
  OutboundMessage,
  ProviderCapabilities,
  SendResult,
  SubmissionProvider,
  SyncCursor,
  SynchronizeResult,
} from "../mail-provider.js";
import { MAIL_PROVIDER_CONTRACT_VERSION } from "../mail-provider.js";
import type { ImapClient, ImapFetchedMessage, SmtpClient } from "./ports.js";

/**
 * IONOS-style IMAP session (ImapSmtpProvider) + SMTP submission
 * (SmtpSubmission), capability-scoped.
 *
 * Built on the ImapClient/SmtpClient ports (ImapFlow + Nodemailer in prod;
 * in-repo fakes in tests). Deliberately NOT Gmail/Graph-shaped: no server-side
 * threads, no client-chosen UIDs, IMAP APPEND assigns a fresh UID. Draft
 * replacement is append-then-retire because IMAP cannot update in place.
 *
 * The IMAP session and the SMTP submission are SEPARATE objects over separate
 * clients so read-only work (sync, mutation, draft mirror, Sent-copy
 * reconciliation) can never carry SMTP capability.
 */
export const IMAP_SMTP_CAPABILITIES: ProviderCapabilities = {
  contractVersion: MAIL_PROVIDER_CONTRACT_VERSION,
  supportsImapIdle: true,
  supportsDraftAppend: true,
  supportsSentAppend: true,
  supportsMessageIdControl: true, // via the MIME we APPEND / submit
  supportsFolderMutation: true,
  supportsNativeThreads: false, // plain IMAP has no server thread ids
};

function toMeta(m: ImapFetchedMessage): FetchedMessageMeta {
  return {
    uid: m.uid,
    uidvalidity: m.uidvalidity,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    referencesHeader: m.referencesHeader,
    subject: m.subject,
    fromSummary: m.fromSummary,
    toSummary: m.toSummary,
    internalDate: m.internalDate,
    sizeBytes: m.sizeBytes,
    flags: m.flags,
    hasAttachments: m.hasAttachments,
  };
}

export class ImapSmtpProvider implements ImapSessionProvider {
  public readonly capabilities = IMAP_SMTP_CAPABILITIES;
  private readonly imap: ImapClient;

  public constructor(deps: { imap: ImapClient }) {
    this.imap = deps.imap;
  }

  public async verifyImap(): Promise<void> {
    await this.imap.connect();
  }

  public async discoverFolders(): Promise<readonly DiscoveredFolder[]> {
    const folders = await this.imap.listFolders();
    return folders.map((f) => ({
      name: f.name,
      role: f.role,
      uidvalidity: f.uidvalidity,
      uidnext: f.uidnext,
    }));
  }

  public async synchronizeFolder(
    folder: string,
    cursor: SyncCursor | null,
    options: { batchSize: number },
  ): Promise<SynchronizeResult> {
    const status = await this.imap.statusFolder(folder);

    // UIDVALIDITY change: the old UID namespace is invalid. Signal the caller;
    // we do NOT mix new UIDs into the old cursor here.
    if (cursor !== null && status.uidvalidity !== cursor.uidvalidity) {
      return {
        messages: [],
        cursor: {
          uidvalidity: status.uidvalidity,
          uidnext: status.uidnext,
          lastSeenUid: 0n,
          highestModseq: status.highestModseq,
        },
        uidValidityChanged: true,
      };
    }

    const sinceUid = cursor?.lastSeenUid ?? 0n;
    const { uidvalidity, messages } = await this.imap.fetchSince(
      folder,
      sinceUid,
      options.batchSize,
    );

    // Guard against a race where uidvalidity flipped between STATUS and FETCH.
    if (cursor !== null && uidvalidity !== cursor.uidvalidity) {
      return {
        messages: [],
        cursor: {
          uidvalidity,
          uidnext: status.uidnext,
          lastSeenUid: 0n,
          highestModseq: status.highestModseq,
        },
        uidValidityChanged: true,
      };
    }

    let maxUid = sinceUid;
    for (const m of messages) {
      if (m.uid > maxUid) maxUid = m.uid;
    }

    return {
      messages: messages.map(toMeta),
      cursor: {
        uidvalidity,
        uidnext: status.uidnext,
        lastSeenUid: maxUid,
        highestModseq: status.highestModseq,
      },
      uidValidityChanged: false,
    };
  }

  public async waitForChanges(
    folder: string,
    timeoutMs: number,
  ): Promise<IdleChange | null> {
    const signal = await this.imap.idle(folder, timeoutMs);
    return signal === null ? null : { kind: signal.kind };
  }

  public async fetchMessage(
    folder: string,
    uid: bigint,
    uidvalidity: bigint,
  ): Promise<FetchedMessageMeta | null> {
    const { uidvalidity: current, message } = await this.imap.fetchOne(
      folder,
      uid,
    );
    if (current !== uidvalidity) return null; // stale namespace
    return message === null ? null : toMeta(message);
  }

  public async appendDraft(
    folder: string,
    mime: Buffer,
  ): Promise<AppendResult> {
    return this.imap.append(folder, mime, ["\\Draft"]);
  }

  public async replaceOrSupersedeDraft(
    folder: string,
    previousUid: bigint | null,
    mime: Buffer,
  ): Promise<AppendResult> {
    // Append the new revision FIRST, so an interruption never leaves the
    // mailbox without a draft. Only after a durable new UID do we retire the
    // old one (\Deleted). No uncontrolled duplicate is created.
    const appended = await this.imap.append(folder, mime, ["\\Draft"]);
    if (previousUid !== null && previousUid !== appended.uid) {
      await this.imap.addFlags(folder, previousUid, ["\\Deleted"]);
    }
    return appended;
  }

  public async appendSentCopy(
    folder: string,
    mime: Buffer,
  ): Promise<AppendResult> {
    return this.imap.append(folder, mime, ["\\Seen"]);
  }

  public async findByMessageId(
    folder: string,
    messageId: string,
  ): Promise<bigint | null> {
    return this.imap.searchByMessageId(folder, messageId);
  }

  public async applyMutation(mutation: FolderMutation): Promise<void> {
    switch (mutation.kind) {
      case "add_flags":
        await this.imap.addFlags(mutation.folder, mutation.uid, mutation.flags);
        return;
      case "remove_flags":
        await this.imap.removeFlags(
          mutation.folder,
          mutation.uid,
          mutation.flags,
        );
        return;
      case "move":
        await this.imap.moveMessage(
          mutation.folder,
          mutation.uid,
          mutation.toFolder,
        );
        return;
    }
  }

  public async disconnect(): Promise<void> {
    await this.imap.logout();
  }
}

/**
 * SMTP submission channel over the SmtpClient port. Constructed ONLY via
 * ProviderFactory.createSubmission — i.e. only by the send executor after its
 * sender-authority + payload-integrity guards. verifySmtp() is explicit and
 * never runs implicitly on construction.
 */
export class SmtpSubmission implements SubmissionProvider {
  private readonly smtp: SmtpClient;

  public constructor(deps: { smtp: SmtpClient }) {
    this.smtp = deps.smtp;
  }

  public async verifySmtp(): Promise<void> {
    await this.smtp.verify();
  }

  public async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const built = await buildOutboundMime(message);
    const envelopeTo = [
      ...message.recipients.to,
      ...(message.recipients.cc ?? []),
      ...(message.recipients.bcc ?? []),
    ];
    const result = await this.smtp.send({
      messageId: message.messageId,
      envelopeFrom: message.sender,
      envelopeTo,
      raw: built.raw,
    });
    return {
      messageId: message.messageId,
      response: result.response,
      accepted: result.accepted,
      rejected: result.rejected,
    };
  }

  public async close(): Promise<void> {
    await this.smtp.close();
  }
}
