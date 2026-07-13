import type { SendIntentRow } from "../domain/models.js";
import type {
  ImapSessionProvider,
  OutboundMessage,
  SubmissionProvider,
} from "../providers/mail-provider.js";
import type { MailboxRow } from "../domain/models.js";

/**
 * Ports the workers depend on, so protocol, credential decryption and payload
 * assembly are all swappable in tests.
 */

/**
 * Capability-scoped provider factory. Each method resolves + decrypts the
 * mailbox credential (worker-only) and constructs ONLY the protocol client the
 * capability needs — a read-only sync can never contact SMTP.
 */
export interface ProviderFactory {
  /**
   * Build a connected, IMAP-verified session. Only ever called when the
   * relevant transport capability flag is ON. NEVER constructs an SMTP client.
   */
  createImapSession(mailbox: MailboxRow): Promise<ImapSessionProvider>;

  /**
   * Build an SMTP submission channel. Called ONLY by the send executor AFTER
   * its sender-authority + payload-integrity guards passed. Does NOT
   * auto-verify — the executor decides; construction opens no connection.
   */
  createSubmission(mailbox: MailboxRow): Promise<SubmissionProvider>;
}

/**
 * Reconstructs the concrete outbound payload (bodies + attachment bytes) for an
 * immutable send intent. The executor re-verifies the resolved payload's
 * hashes/manifest/revision/recipients against the intent BEFORE any SMTP.
 */
export interface SendPayloadResolver {
  resolve(intent: SendIntentRow): Promise<ResolvedSendPayload>;
}

export interface ResolvedSendPayload {
  /** drafts.revision the payload was reconstructed from. */
  readonly revision: bigint;
  readonly message: OutboundMessage;
}
