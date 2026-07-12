/**
 * Low-level protocol ports.
 *
 * The IMAP-SMTP MailProvider is built on these two narrow ports rather than
 * directly on ImapFlow/Nodemailer. Production wires the real adapters
 * (./imap-client.ts, ./smtp-client.ts). Tests wire in-repo fake protocol
 * servers (test/fakes) implementing the SAME ports — deterministic, no network,
 * with injectable disconnects / timeouts / ambiguous-DATA failures. The
 * container registry is blocked, so this port boundary — not testcontainers —
 * is where integration coverage lives.
 */

export interface ImapFolderStatus {
  readonly name: string;
  readonly uidvalidity: bigint;
  readonly uidnext: bigint;
  /** Best-effort role hint derived from SPECIAL-USE / name. */
  readonly role:
    "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "other" | null;
  readonly highestModseq: bigint | null;
}

export interface ImapFetchedMessage {
  readonly uid: bigint;
  readonly uidvalidity: bigint;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly referencesHeader: string | null;
  readonly subject: string | null;
  readonly fromSummary: string | null;
  readonly toSummary: string | null;
  readonly internalDate: Date | null;
  readonly sizeBytes: bigint | null;
  readonly flags: readonly string[];
  readonly hasAttachments: boolean;
}

export interface ImapAppendResult {
  readonly uid: bigint;
  readonly uidvalidity: bigint;
}

export interface ImapIdleSignal {
  readonly kind: "exists" | "expunge" | "flags";
}

/** One connected IMAP session. Bounded, one active command stream at a time. */
export interface ImapClient {
  connect(): Promise<void>;
  listFolders(): Promise<readonly ImapFolderStatus[]>;
  statusFolder(folder: string): Promise<ImapFolderStatus>;
  /**
   * Fetch messages with UID strictly greater than `sinceUid`, up to `limit`,
   * ordered ascending. Returns the folder's current uidvalidity too, so the
   * caller can detect a change.
   */
  fetchSince(
    folder: string,
    sinceUid: bigint,
    limit: number,
  ): Promise<{ uidvalidity: bigint; messages: readonly ImapFetchedMessage[] }>;
  fetchOne(
    folder: string,
    uid: bigint,
  ): Promise<{ uidvalidity: bigint; message: ImapFetchedMessage | null }>;
  append(
    folder: string,
    mime: Buffer,
    flags: readonly string[],
  ): Promise<ImapAppendResult>;
  addFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void>;
  removeFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void>;
  moveMessage(folder: string, uid: bigint, toFolder: string): Promise<void>;
  searchByMessageId(folder: string, messageId: string): Promise<bigint | null>;
  idle(folder: string, timeoutMs: number): Promise<ImapIdleSignal | null>;
  logout(): Promise<void>;
}

export interface SmtpSendCommand {
  readonly messageId: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: readonly string[];
  /** Fully-built RFC 5322 message bytes (Message-ID header already embedded). */
  readonly raw: Buffer;
}

export interface SmtpSendResult {
  readonly response: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/**
 * One SMTP submission channel. Implementations MUST distinguish pre-DATA
 * failures from ambiguous during/after-DATA failures by throwing
 * SmtpPreDataError vs SmtpAmbiguousError (see src/domain/errors.ts). The
 * provider/worker never retries either.
 */
export interface SmtpClient {
  verify(): Promise<void>;
  send(command: SmtpSendCommand): Promise<SmtpSendResult>;
  close(): Promise<void>;
}
