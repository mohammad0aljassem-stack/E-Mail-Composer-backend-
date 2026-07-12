/**
 * Credential cipher contract.
 *
 * Authenticated encryption of IMAP/SMTP secrets. The ciphertext is bound via
 * AAD to the workspace + mailbox identity, so a ciphertext row cannot be
 * replayed against a different mailbox. Errors are constant-shape and never
 * echo secret material.
 */
import type { TransportError } from "../domain/errors.js";

/** The identity a ciphertext is cryptographically bound to (becomes the AAD). */
export interface CredentialAad {
  workspaceId: string;
  mailboxId: string;
  /** Purpose discriminator, e.g. "imap" | "smtp" | "combined". */
  purpose: string;
}

/** On-the-wire encrypted record — maps 1:1 to transport.mailbox_credentials. */
export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  algorithm: string;
  keyVersion: number;
  /** The canonical AAD string that was authenticated (stored for audit/rebind). */
  aad: string;
}

export interface CredentialCipher {
  readonly algorithm: string;
  /** Key version new ciphertext is written with. */
  readonly activeKeyVersion: number;

  encrypt(plaintext: Buffer, aad: CredentialAad): EncryptedCredential;

  /**
   * Decrypt. MUST fail closed (throw a constant-shape {@link TransportError})
   * on: unknown key version, AAD mismatch, tampered ciphertext/tag, wrong key.
   * The provided `aad` must reconstruct exactly the value used at encrypt time.
   */
  decrypt(record: EncryptedCredential, aad: CredentialAad): Buffer;
}

/** Canonical, stable serialization of the AAD (order-fixed; no secrets). */
export function serializeAad(aad: CredentialAad): string {
  return `v1|ws=${aad.workspaceId}|mb=${aad.mailboxId}|p=${aad.purpose}`;
}

export type { TransportError };
