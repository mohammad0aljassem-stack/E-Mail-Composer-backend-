import { TransportError } from "../domain/errors.js";
import type { MailboxRow } from "../domain/models.js";
import type { CredentialCipher } from "../crypto/credential-cipher.js";
import { zeroBuffer } from "../crypto/aes-gcm-cipher.js";
import type { CredentialReader } from "../db/repository-interfaces.js";
import { ImapFlowClient } from "../providers/imap-smtp/imap-client.js";
import { NodemailerSmtpClient } from "../providers/imap-smtp/smtp-client.js";
import { ImapSmtpProvider } from "../providers/imap-smtp/imap-smtp-provider.js";
import type { MailProvider } from "../providers/mail-provider.js";
import type { ProviderFactory } from "./ports.js";

/**
 * Production ProviderFactory: worker-only credential decryption + real protocol
 * clients. Constructed ONLY when the transport flag is on; when off, no factory
 * is instantiated so no credential is ever decrypted.
 */

interface DecryptedCredential {
  user: string;
  pass: string;
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

  public async create(mailbox: MailboxRow): Promise<MailProvider> {
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
    // Fail-closed transport security: a mailbox row whose imap_security or
    // smtp_security is 'none' (or unset) must NEVER produce a cleartext
    // session that would carry the credential and message bytes in plaintext.
    // Checked BEFORE any credential is read or decrypted.
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

    let cred: DecryptedCredential;
    try {
      cred = parseCredential(plaintext);
    } finally {
      zeroBuffer(plaintext); // best-effort scrub after parse
    }

    // NOTE: IMAP "starttls" currently maps to implicit TLS (secure=true) — the
    // client does not negotiate STARTTLS upgrade yet. This is deliberately
    // fail-closed: the session is ALWAYS encrypted, never plaintext. 'none'
    // was rejected above.
    const imap = new ImapFlowClient({
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      secure: true,
      auth: { user: cred.user, pass: cred.pass },
      timeoutMs: this.deps.config.imapCommandTimeoutMs,
    });
    const smtp = new NodemailerSmtpClient({
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      secure: mailbox.smtpSecurity === "ssl",
      requireTls: mailbox.smtpSecurity === "starttls",
      auth: { user: cred.user, pass: cred.pass },
      timeoutMs: this.deps.config.smtpTimeoutMs,
    });

    const provider = new ImapSmtpProvider({ imap, smtp });
    await provider.verifyConnection();
    return provider;
  }
}
