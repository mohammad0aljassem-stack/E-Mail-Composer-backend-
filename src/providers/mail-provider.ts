/**
 * Versioned MailProvider contract.
 *
 * The provider abstraction is deliberately NOT Gmail/Graph-shaped. Capabilities
 * are declared explicitly so higher layers can adapt instead of assuming a
 * particular backend's semantics. The IONOS/IMAP-SMTP implementation lives in
 * ./imap-smtp and is built on ImapFlow (IMAP), Nodemailer (SMTP/MIME out) and
 * mailparser (inbound parsing).
 *
 * Provider-specific behaviour that stays behind this interface (documented in
 * docs/adr/0001-mail-provider.md): folder role heuristics, UID/UIDVALIDITY
 * namespacing, IDLE support, draft append-then-retire semantics, and the fact
 * that IMAP APPEND assigns a *new* UID the client cannot pre-choose.
 */
import type {
  AttachmentManifestEntry,
  FolderRole,
  SendRecipients,
} from "../domain/models.js";

export const MAIL_PROVIDER_CONTRACT_VERSION = 1 as const;

/** Explicit capability matrix — never inferred. */
export interface ProviderCapabilities {
  readonly contractVersion: typeof MAIL_PROVIDER_CONTRACT_VERSION;
  readonly supportsImapIdle: boolean;
  readonly supportsDraftAppend: boolean;
  readonly supportsSentAppend: boolean;
  /** Can the client dictate the stored Message-ID? (IMAP: only via the MIME it appends.) */
  readonly supportsMessageIdControl: boolean;
  readonly supportsFolderMutation: boolean;
  /** Server-side thread ids (Gmail X-GM-THRID etc.). IMAP: false. */
  readonly supportsNativeThreads: boolean;
}

/**
 * Synchronization cursor for a single folder. UID space is namespaced by
 * uidvalidity — a uidvalidity change invalidates every UID captured under the
 * previous value.
 */
export interface SyncCursor {
  readonly uidvalidity: bigint;
  readonly uidnext: bigint;
  readonly lastSeenUid: bigint;
  readonly highestModseq: bigint | null;
}

export interface DiscoveredFolder {
  readonly name: string;
  readonly role: FolderRole | null;
  readonly uidvalidity: bigint;
  readonly uidnext: bigint;
}

/** Message metadata as fetched from the provider (headers/flags/size only). */
export interface FetchedMessageMeta {
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

export interface SynchronizeResult {
  readonly messages: readonly FetchedMessageMeta[];
  readonly cursor: SyncCursor;
  /** True when the server's UIDVALIDITY differs from the cursor we passed in. */
  readonly uidValidityChanged: boolean;
}

export interface OutboundMessage {
  readonly messageId: string;
  readonly sender: string;
  readonly recipients: SendRecipients;
  readonly subject: string;
  readonly html: string | null;
  readonly text: string | null;
  readonly attachments: readonly OutboundAttachment[];
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OutboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  readonly contentId?: string;
}

export interface SendResult {
  /** The Message-ID actually submitted (echoes the pre-generated snapshot id). */
  readonly messageId: string;
  /** Raw SMTP acceptance response, truncated + content-free. */
  readonly response: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface AppendResult {
  readonly uid: bigint;
  readonly uidvalidity: bigint;
}

export interface IdleChange {
  /** A wake-up signal only — the caller must enqueue an incremental sync. */
  readonly kind: "exists" | "expunge" | "flags";
}

/**
 * The IMAP-session port. Every method is provider-agnostic; capabilities gate
 * what the caller may rely on. A single instance corresponds to one mailbox's
 * IMAP connection lifecycle.
 *
 * Deliberately EXCLUDES SMTP submission: read-only/mailbox-mutating work
 * (sync, folder mutation, draft mirror, Sent-copy reconciliation) must never
 * be able to contact an SMTP server. Submission lives on the separate
 * SubmissionProvider port below, constructed only by the send path.
 */
export interface ImapSessionProvider {
  readonly capabilities: ProviderCapabilities;

  /**
   * Establish + authenticate the IMAP session; throws provider_auth_failed /
   * provider_connect_failed. Never touches SMTP.
   */
  verifyImap(): Promise<void>;

  discoverFolders(): Promise<readonly DiscoveredFolder[]>;

  /**
   * Fetch new/changed messages for a folder since `cursor`. If `cursor` is
   * null, performs a bounded initial sync. Detects UIDVALIDITY changes.
   */
  synchronizeFolder(
    folder: string,
    cursor: SyncCursor | null,
    options: { batchSize: number },
  ): Promise<SynchronizeResult>;

  /** Begin IDLE and resolve on the first change signal, or on timeout (null). */
  waitForChanges(folder: string, timeoutMs: number): Promise<IdleChange | null>;

  /** Fetch a single message's metadata (no body persistence). */
  fetchMessage(
    folder: string,
    uid: bigint,
    uidvalidity: bigint,
  ): Promise<FetchedMessageMeta | null>;

  appendDraft(folder: string, mime: Buffer): Promise<AppendResult>;

  /**
   * Replace a draft by append-then-retire: append the new revision, then flag
   * the previous UID \Deleted. Never mutates in place (IMAP has no update).
   */
  replaceOrSupersedeDraft(
    folder: string,
    previousUid: bigint | null,
    mime: Buffer,
  ): Promise<AppendResult>;

  /** Append a copy of a sent message to the Sent folder (idempotent by search). */
  appendSentCopy(folder: string, mime: Buffer): Promise<AppendResult>;

  /** Search a folder for a Message-ID; used for Sent-copy reconciliation. */
  findByMessageId(folder: string, messageId: string): Promise<bigint | null>;

  applyMutation(mutation: FolderMutation): Promise<void>;

  disconnect(): Promise<void>;
}

/**
 * The SMTP-submission port. Constructed ONLY by the send executor, AFTER the
 * sender-authority and payload-integrity guards passed — never by sync,
 * mutation, draft-mirror, or Sent-copy reconciliation code.
 */
export interface SubmissionProvider {
  /**
   * Explicit SMTP connection/auth verification. Never invoked implicitly by
   * construction; the caller decides whether a pre-flight verify is wanted.
   */
  verifySmtp(): Promise<void>;

  sendMessage(message: OutboundMessage): Promise<SendResult>;

  /**
   * Release submission resources (no-op is acceptable for connectionless
   * per-send clients).
   */
  close(): Promise<void>;
}

export type FolderMutation =
  | { kind: "add_flags"; folder: string; uid: bigint; flags: readonly string[] }
  | {
      kind: "remove_flags";
      folder: string;
      uid: bigint;
      flags: readonly string[];
    }
  | { kind: "move"; folder: string; uid: bigint; toFolder: string };

export type { AttachmentManifestEntry };
