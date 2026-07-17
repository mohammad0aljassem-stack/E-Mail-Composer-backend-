import { TransportError } from "../domain/errors.js";
import type { MailboxRow } from "../domain/models.js";
import type { CredentialCipher } from "../crypto/credential-cipher.js";
import { zeroBuffer } from "../crypto/aes-gcm-cipher.js";
import type { CredentialReader } from "../db/repository-interfaces.js";
import { ImapFlowClient } from "../providers/imap-smtp/imap-client.js";
import { NodemailerSmtpClient } from "../providers/imap-smtp/smtp-client.js";
import {
  ImapSmtpProvider,
  SmtpSubmission,
} from "../providers/imap-smtp/imap-smtp-provider.js";
import type {
  ImapSessionProvider,
  SubmissionProvider,
} from "../providers/mail-provider.js";
import type { ProviderFactory } from "./ports.js";

/**
 * Production ProviderFactory: worker-only credential decryption + real protocol
 * clients. Constructed ONLY when the transport flag is on; when off, no factory
 * is instantiated so no credential is ever decrypted.
 *
 * Capability-scoped (C1): createImapSession constructs ONLY the IMAP client and
 * createSubmission constructs ONLY the SMTP client, so read-only sync/mutation/
 * mirror work can never contact an SMTP server. Each method runs ONLY its own
 * protocol's fail-closed configuration gate (host/port presence + plaintext
 * refusal): createImapSession validates the IMAP endpoint alone (it succeeds
 * even when the mailbox has no SMTP config — a sync-only mailbox), and
 * createSubmission validates the SMTP endpoint alone (it never requires IMAP).
 * The gate runs BEFORE any credential is read or decrypted.
 */

interface DecryptedCredential {
  user: string;
  pass: string;
}

/** IMAP endpoint after the fail-closed IMAP configuration gate. */
interface SecureImapEndpoint {
  imapHost: string;
  imapPort: number;
  imapSecurity: "ssl" | "starttls";
}

/** SMTP endpoint after the fail-closed SMTP configuration gate. */
interface SecureSmtpEndpoint {
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls";
}

function parseCredential(plaintext: Buffer): DecryptedCredential {
  let obj: unknown;
  try {
    obj = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new TransportError(
      "credential_decrypt_failed",
      "credential payload not JSON",
    );
  }
  if (typeof obj !== "object" || obj === null) {
    throw new TransportError(
      "credential_decrypt_failed",
      "credential payload malformed",
    );
  }
  const rec = obj as Record<string, unknown>;
  const user = rec.user;
  const pass = rec.pass;
  if (typeof user !== "string" || typeof pass !== "string") {
    throw new TransportError(
      "credential_decrypt_failed",
      "credential payload malformed",
    );
  }
  return { user, pass };
}

export class ImapSmtpProviderFactory implements ProviderFactory {
  public constructor(
    private readonly deps: {
      credentials: CredentialReader;
      cipher: CredentialCipher;
      config: {
        imapCommandTimeoutMs: number;
        smtpTimeoutMs: number;
      };
    },
  ) {}

  public async createImapSession(
    mailbox: MailboxRow,
  ): Promise<ImapSessionProvider> {
    const endpoints = requireSecureImapEndpoint(mailbox);
    const cred = await this.decryptCredential(mailbox);

    // NOTE: IMAP "starttls" currently maps to implicit TLS (secure=true) — the
    // client does not negotiate STARTTLS upgrade yet. This is deliberately
    // fail-closed: the session is ALWAYS encrypted, never plaintext. 'none'
    // was rejected above.
    const imap = new ImapFlowClient({
      host: endpoints.imapHost,
      port: endpoints.imapPort,
      secure: true,
      auth: { user: cred.user, pass: cred.pass },
      timeoutMs: this.deps.config.imapCommandTimeoutMs,
    });

    const session = new ImapSmtpProvider({ imap });
    await session.verifyImap();
    return session;
  }

  public async createSubmission(
    mailbox: MailboxRow,
  ): Promise<SubmissionProvider> {
    const endpoints = requireSecureSmtpEndpoint(mailbox);
    const cred = await this.decryptCredential(mailbox);

    const smtp = new NodemailerSmtpClient({
      host: endpoints.smtpHost,
      port: endpoints.smtpPort,
      secure: endpoints.smtpSecurity === "ssl",
      requireTls: endpoints.smtpSecurity === "starttls",
      auth: { user: cred.user, pass: cred.pass },
      timeoutMs: this.deps.config.smtpTimeoutMs,
    });

    // Not auto-verified: the send executor decides when SMTP is contacted
    // (nodemailer connects on send). Construction opens no connection.
    return new SmtpSubmission({ smtp });
  }

  private async decryptCredential(
    mailbox: MailboxRow,
  ): Promise<DecryptedCredential> {
    const stored = await this.deps.credentials.getActiveByMailbox(mailbox.id);
    if (stored === null) {
      throw new TransportError("credential_missing", "no active credential");
    }
    if (stored.authTag === null) {
      throw new TransportError("credential_decrypt_failed", "missing auth tag");
    }

    const plaintext = this.deps.cipher.decrypt(
      {
        ciphertext: stored.ciphertext,
        nonce: stored.nonce,
        authTag: stored.authTag,
        algorithm: stored.algorithm,
        keyVersion: stored.keyVersion,
        aad: stored.aad,
      },
      {
        workspaceId: mailbox.workspaceId,
        mailboxId: mailbox.id,
        purpose: "combined",
      },
    );

    try {
      return parseCredential(plaintext);
    } finally {
      zeroBuffer(plaintext); // best-effort scrub after parse
    }
  }
}

/**
 * Fail-closed IMAP-config gate (createImapSession only). A mailbox row whose
 * imap_security is 'none' (or unset) — or which is missing its IMAP host/port —
 * must NEVER produce a cleartext IMAP session that would carry the credential
 * and message bytes in plaintext. It says NOTHING about the SMTP config, so a
 * sync-only mailbox (null smtpHost/smtpPort/smtpSecurity) opens an IMAP session
 * cleanly. Runs BEFORE any credential is read or decrypted.
 */
function requireSecureImapEndpoint(mailbox: MailboxRow): SecureImapEndpoint {
  if (mailbox.imapHost === null || mailbox.imapPort === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox missing imap host/port config",
    );
  }
  if (mailbox.imapSecurity === "none" || mailbox.imapSecurity === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox imap_security must be ssl or starttls (plaintext refused)",
    );
  }
  return {
    imapHost: mailbox.imapHost,
    imapPort: mailbox.imapPort,
    imapSecurity: mailbox.imapSecurity,
  };
}

/**
 * Fail-closed SMTP-config gate (createSubmission only). A mailbox row whose
 * smtp_security is 'none' (or unset) — or which is missing its SMTP host/port —
 * must NEVER produce a cleartext submission. It says NOTHING about the IMAP
 * config, so a send-only construction does not require IMAP. Runs BEFORE any
 * credential is read or decrypted.
 */
function requireSecureSmtpEndpoint(mailbox: MailboxRow): SecureSmtpEndpoint {
  if (mailbox.smtpHost === null || mailbox.smtpPort === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox missing smtp host/port config",
    );
  }
  if (mailbox.smtpSecurity === "none" || mailbox.smtpSecurity === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox smtp_security must be ssl or starttls (plaintext refused)",
    );
  }
  return {
    smtpHost: mailbox.smtpHost,
    smtpPort: mailbox.smtpPort,
    smtpSecurity: mailbox.smtpSecurity,
  };
}
