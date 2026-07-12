import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { TransportError } from "../domain/errors.js";
import {
  serializeAad,
  type CredentialAad,
  type CredentialCipher,
  type EncryptedCredential,
} from "./credential-cipher.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // 96-bit GCM nonce (recommended)
const TAG_LEN = 16; // 128-bit auth tag

/**
 * AES-256-GCM credential cipher with a versioned keyring.
 *
 * Security properties:
 *  - Strict key-length validation (every keyring key must be exactly 32 bytes).
 *  - Random 96-bit nonce per encryption (never reused deterministically).
 *  - AAD binds the ciphertext to workspace+mailbox+purpose; a wrong AAD fails
 *    authentication (constant-shape error).
 *  - Constant-shape errors: decrypt failures never reveal *why* beyond a code.
 *  - Best-effort plaintext buffer zeroing after use (see zeroBuffer helper).
 *  - NO secret is ever logged or embedded in an error message.
 */
export class AesGcmCredentialCipher implements CredentialCipher {
  public readonly algorithm = ALGORITHM;
  public readonly activeKeyVersion: number;
  private readonly keyring: ReadonlyMap<number, Buffer>;
  private readonly randomSource: (n: number) => Buffer;

  public constructor(options: {
    keyring: ReadonlyMap<number, Buffer>;
    activeKeyVersion: number;
    /** Injectable for deterministic nonces in tests. */
    randomSource?: (n: number) => Buffer;
  }) {
    for (const [version, key] of options.keyring) {
      if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
        throw new TransportError(
          "crypto_key_invalid",
          "keyring key must be exactly 32 bytes for AES-256",
          { context: { keyVersion: version } },
        );
      }
    }
    if (!options.keyring.has(options.activeKeyVersion)) {
      throw new TransportError(
        "crypto_key_invalid",
        "active key version is not present in the keyring",
      );
    }
    this.keyring = options.keyring;
    this.activeKeyVersion = options.activeKeyVersion;
    this.randomSource = options.randomSource ?? randomBytes;
  }

  public encrypt(plaintext: Buffer, aad: CredentialAad): EncryptedCredential {
    const key = this.keyring.get(this.activeKeyVersion);
    if (key === undefined) {
      throw new TransportError("crypto_key_invalid", "active key missing");
    }
    const nonce = this.randomSource(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) {
      throw new TransportError(
        "crypto_key_invalid",
        "nonce source returned wrong length",
      );
    }
    const aadString = serializeAad(aad);
    const cipher = createCipheriv(ALGORITHM, key, nonce, {
      authTagLength: TAG_LEN,
    });
    cipher.setAAD(Buffer.from(aadString, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext,
      nonce,
      authTag,
      algorithm: ALGORITHM,
      keyVersion: this.activeKeyVersion,
      aad: aadString,
    };
  }

  public decrypt(record: EncryptedCredential, aad: CredentialAad): Buffer {
    if (record.algorithm !== ALGORITHM) {
      throw new TransportError("crypto_auth_failed", "unsupported algorithm");
    }
    const key = this.keyring.get(record.keyVersion);
    if (key === undefined) {
      // Unknown key version → fail closed, do not fall back to any other key.
      throw new TransportError(
        "crypto_key_version_unknown",
        "unknown key version",
        {
          context: { keyVersion: record.keyVersion },
        },
      );
    }
    const expectedAad = serializeAad(aad);
    // The caller-reconstructed AAD must match the stored one (defense in depth:
    // GCM auth would also fail, but this gives a precise, still-constant error).
    const storedAadBuf = Buffer.from(record.aad, "utf8");
    const expectedAadBuf = Buffer.from(expectedAad, "utf8");
    if (
      storedAadBuf.length !== expectedAadBuf.length ||
      !timingSafeEqual(storedAadBuf, expectedAadBuf)
    ) {
      throw new TransportError("crypto_aad_mismatch", "aad mismatch");
    }
    if (
      record.nonce.length !== NONCE_LEN ||
      record.authTag.length !== TAG_LEN
    ) {
      throw new TransportError(
        "crypto_auth_failed",
        "malformed nonce or auth tag",
      );
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, record.nonce, {
        authTagLength: TAG_LEN,
      });
      decipher.setAAD(expectedAadBuf);
      decipher.setAuthTag(record.authTag);
      return Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]);
    } catch (cause) {
      // Wrong key or tampered ciphertext/tag → GCM authentication fails here.
      // Constant-shape error; never surface the underlying reason or bytes.
      throw new TransportError("crypto_auth_failed", "authentication failed", {
        cause,
      });
    }
  }
}

/** Best-effort in-place zeroing of a plaintext buffer once it is no longer needed. */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
