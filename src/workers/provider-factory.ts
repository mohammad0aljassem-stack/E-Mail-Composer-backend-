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
 * mirror work can never contact an SMTP server. Both methods run the SAME
 * fail-closed configuration gate first (host/port presence + plaintext refusal
 * for BOTH imap_security and smtp_security): a mailbox row with an insecure or
 * incomplete transport config is refused as a whole — deliberately, as a
 * config-integrity check — before any credential is read or decrypted.
 */

interface DecryptedCredential {
  user: string;
  pass: string;
}

/** Mailbox transport endpoints after the fail-closed configuration gate. */
interface SecureEndpoints {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  imapSecurity: "ssl" | "starttls";
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
    const endpoints = requireSecureEndpoints(mailbox);
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
    const endpoints = requireSecureEndpoints(mailbox);
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
 * Fail-closed transport-config gate, shared by BOTH factory methods. A mailbox
 * row whose imap_security or smtp_security is 'none' (or unset) must NEVER
 * produce a cleartext session that would carry the credential and message
 * bytes in plaintext — even for the capability that would not use that
 * protocol (config integrity is checked as a whole). Runs BEFORE any
 * credential is read or decrypted.
 */
function requireSecureEndpoints(mailbox: MailboxRow): SecureEndpoints {
  if (
    mailbox.imapHost === null ||
    mailbox.imapPort === null ||
    mailbox.smtpHost === null ||
    mailbox.smtpPort === null
  ) {
    throw new TransportError(
      "config_invalid",
      "mailbox missing host/port config",
    );
  }
  if (mailbox.imapSecurity === "none" || mailbox.imapSecurity === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox imap_security must be ssl or starttls (plaintext refused)",
    );
  }
  if (mailbox.smtpSecurity === "none" || mailbox.smtpSecurity === null) {
    throw new TransportError(
      "config_invalid",
      "mailbox smtp_security must be ssl or starttls (plaintext refused)",
    );
  }
  return {
    imapHost: mailbox.imapHost,
    imapPort: mailbox.imapPort,
    smtpHost: mailbox.smtpHost,
    smtpPort: mailbox.smtpPort,
    imapSecurity: mailbox.imapSecurity,
    smtpSecurity: mailbox.smtpSecurity,
  };
}
