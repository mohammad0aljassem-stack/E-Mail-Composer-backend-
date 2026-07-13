import { describe, expect, it } from "vitest";
import { AesGcmCredentialCipher } from "../../src/crypto/aes-gcm-cipher.js";
import { TransportError } from "../../src/domain/errors.js";
import { ImapSmtpProviderFactory } from "../../src/workers/provider-factory.js";
import { FakeCredentialRepo } from "../fakes/in-memory-repos.js";
import { sendableMailbox } from "../helpers/send-fixtures.js";

/**
 * C2 — the production ProviderFactory must NEVER build a plaintext transport
 * session. A mailbox row whose imap_security or smtp_security is 'none' (or
 * unset) is rejected fail-closed with config_invalid BEFORE any credential is
 * read or decrypted — by BOTH capability-scoped methods (config integrity is
 * checked as a whole even for the protocol a method does not construct).
 * 'ssl' passes the security gate (proven here by reaching the subsequent
 * credential_missing check — no network is ever touched).
 */

function makeFactory(): ImapSmtpProviderFactory {
  return new ImapSmtpProviderFactory({
    credentials: new FakeCredentialRepo(), // empty: no active credential
    cipher: new AesGcmCredentialCipher({
      keyring: new Map([[1, Buffer.alloc(32, 7)]]),
      activeKeyVersion: 1,
    }),
    config: { imapCommandTimeoutMs: 1000, smtpTimeoutMs: 1000 },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no-error";
  } catch (err) {
    return err instanceof TransportError ? err.code : "not-transport-error";
  }
}

describe("ImapSmtpProviderFactory — plaintext transport is refused (C2)", () => {
  it("rejects imap_security = 'none' with config_invalid (both methods)", async () => {
    const factory = makeFactory();
    const mailbox = sendableMailbox({ imapSecurity: "none" });
    expect(await codeOf(factory.createImapSession(mailbox))).toBe(
      "config_invalid",
    );
    expect(await codeOf(factory.createSubmission(mailbox))).toBe(
      "config_invalid",
    );
  });

  it("rejects smtp_security = 'none' with config_invalid (both methods)", async () => {
    const factory = makeFactory();
    const mailbox = sendableMailbox({ smtpSecurity: "none" });
    expect(await codeOf(factory.createImapSession(mailbox))).toBe(
      "config_invalid",
    );
    expect(await codeOf(factory.createSubmission(mailbox))).toBe(
      "config_invalid",
    );
  });

  it("rejects a null imap_security / smtp_security (fail-closed)", async () => {
    const factory = makeFactory();
    expect(
      await codeOf(
        factory.createImapSession(sendableMailbox({ imapSecurity: null })),
      ),
    ).toBe("config_invalid");
    expect(
      await codeOf(
        factory.createSubmission(sendableMailbox({ smtpSecurity: null })),
      ),
    ).toBe("config_invalid");
  });

  it("accepts 'ssl' (proceeds past the security gate to the credential check)", async () => {
    const factory = makeFactory();
    // Both securities are 'ssl' in the fixture. With no active credential the
    // NEXT check fires — proving the security gate accepted the config and
    // that no plaintext (or any) connection was attempted, on BOTH methods.
    expect(await codeOf(factory.createImapSession(sendableMailbox()))).toBe(
      "credential_missing",
    );
    expect(await codeOf(factory.createSubmission(sendableMailbox()))).toBe(
      "credential_missing",
    );
  });
});
