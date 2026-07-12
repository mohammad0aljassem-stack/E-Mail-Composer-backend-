import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AesGcmCredentialCipher } from "../../src/crypto/aes-gcm-cipher.js";
import type { CredentialAad } from "../../src/crypto/credential-cipher.js";
import { TransportError } from "../../src/domain/errors.js";
import { checkProductionRefusal } from "../../src/entrypoints/provision-credential.js";

function key(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

const AAD: CredentialAad = {
  workspaceId: "ws-1",
  mailboxId: "mb-1",
  purpose: "combined",
};

function cipherWith(version = 1): AesGcmCredentialCipher {
  const keyring = new Map<number, Buffer>([
    [1, key(0x11)],
    [2, key(0x22)],
  ]);
  return new AesGcmCredentialCipher({ keyring, activeKeyVersion: version });
}

describe("AesGcmCredentialCipher", () => {
  // Test 38: encrypt/decrypt round-trip.
  it("round-trips plaintext under the correct key + AAD", () => {
    const cipher = cipherWith();
    const secret = Buffer.from(
      JSON.stringify({ user: "u", pass: "p" }),
      "utf8",
    );
    const enc = cipher.encrypt(secret, AAD);
    expect(enc.algorithm).toBe("aes-256-gcm");
    expect(enc.keyVersion).toBe(1);
    expect(enc.ciphertext.equals(secret)).toBe(false); // not plaintext
    const dec = cipher.decrypt(enc, AAD);
    expect(dec.toString("utf8")).toBe(secret.toString("utf8"));
  });

  // Test 39: wrong AAD must fail closed.
  it("fails with wrong AAD", () => {
    const cipher = cipherWith();
    const enc = cipher.encrypt(Buffer.from("secret"), AAD);
    try {
      cipher.decrypt(enc, { ...AAD, mailboxId: "OTHER" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError);
      expect((e as TransportError).code).toBe("crypto_aad_mismatch");
    }
  });

  // Test 40: unknown key version must fail closed (no fallback key).
  it("fails on unknown key version", () => {
    const cipher = cipherWith();
    const enc = cipher.encrypt(Buffer.from("secret"), AAD);
    const tampered = { ...enc, keyVersion: 99 };
    try {
      cipher.decrypt(tampered, AAD);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TransportError).code).toBe("crypto_key_version_unknown");
    }
  });

  it("fails when the key for a version is the wrong key", () => {
    // Encrypt under v1, then present the record as v2 (different key) → auth fail.
    const cipher = cipherWith();
    const enc = cipher.encrypt(Buffer.from("secret"), AAD);
    const asV2 = { ...enc, keyVersion: 2 };
    try {
      cipher.decrypt(asV2, AAD);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TransportError).code).toBe("crypto_auth_failed");
    }
  });

  // Test 41: tampered ciphertext must fail authentication.
  it("fails on tampered ciphertext", () => {
    const cipher = cipherWith();
    const enc = cipher.encrypt(Buffer.from("secret"), AAD);
    const bad = Buffer.from(enc.ciphertext);
    bad[0] = bad[0]! ^ 0xff;
    try {
      cipher.decrypt({ ...enc, ciphertext: bad }, AAD);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TransportError).code).toBe("crypto_auth_failed");
    }
  });

  it("fails on tampered auth tag", () => {
    const cipher = cipherWith();
    const enc = cipher.encrypt(Buffer.from("secret"), AAD);
    const badTag = Buffer.from(enc.authTag);
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => cipher.decrypt({ ...enc, authTag: badTag }, AAD)).toThrow(
      TransportError,
    );
  });

  it("rejects a keyring key that is not 32 bytes", () => {
    const keyring = new Map<number, Buffer>([[1, Buffer.alloc(16, 1)]]);
    expect(
      () => new AesGcmCredentialCipher({ keyring, activeKeyVersion: 1 }),
    ).toThrow(TransportError);
  });
});

// Test 43: provisioning CLI refuses production references.
describe("provisioning production refusal", () => {
  it("refuses the production project ref", () => {
    const r = checkProductionRefusal(
      "postgresql://u@db.fpanvpxjjddhasjmpflz.supabase.co:5432/postgres",
    );
    expect(r.refused).toBe(true);
  });
  it("refuses any hosted *.supabase.co URL", () => {
    const r = checkProductionRefusal("https://abcd.supabase.co");
    expect(r.refused).toBe(true);
  });
  it("allows a local test database", () => {
    const r = checkProductionRefusal(
      "postgresql://transport_worker@localhost:54329/e_mail_composer",
    );
    expect(r.refused).toBe(false);
  });
});

// Test 42: no plaintext credential fixtures are committed.
describe("no plaintext secret fixtures in the repo", () => {
  it("contains no obvious plaintext credential fixtures", () => {
    const root = join(import.meta.dirname, "..", "..");
    const offenders: string[] = [];
    const skip = new Set(["node_modules", ".git", "dist", "coverage"]);
    // A synthetic secret marker that must never appear in a committed fixture.
    const patterns = [
      /BEGIN (?:RSA |EC )?PRIVATE KEY/,
      /"pass"\s*:\s*"(?!p")[^"]{8,}"/, // long literal passwords (allow test "p")
    ];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (/\.(ts|json|env|txt|pem|key)$/.test(name)) {
          // Do not scan this very test file (it names the patterns).
          if (full.endsWith("crypto.test.ts")) continue;
          const content = readFileSync(full, "utf8");
          for (const p of patterns) {
            if (p.test(content)) offenders.push(`${full}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
