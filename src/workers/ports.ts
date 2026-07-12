import type { SendIntentRow } from "../domain/models.js";
import type {
  MailProvider,
  OutboundMessage,
} from "../providers/mail-provider.js";
import type { MailboxRow } from "../domain/models.js";

/**
 * Ports the workers depend on, so protocol, credential decryption and payload
 * assembly are all swappable in tests.
 */

/** Builds a connected MailProvider for a mailbox (resolves + decrypts creds). */
export interface ProviderFactory {
  /**
   * Only ever called when the transport feature flag is ON. Resolves the active
   * credential, decrypts it (worker-only), and returns a connected provider.
   */
  create(mailbox: MailboxRow): Promise<MailProvider>;
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
