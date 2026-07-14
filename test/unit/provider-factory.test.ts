import { describe, expect, it } from "vitest";
import { AesGcmCredentialCipher } from "../../src/crypto/aes-gcm-cipher.js";
import { TransportError } from "../../src/domain/errors.js";
import { ImapSmtpProviderFactory } from "../../src/workers/provider-factory.js";
import { FakeCredentialRepo } from "../fakes/in-memory-repos.js";
import { sendableMailbox } from "../helpers/send-fixtures.js";

/**
 * Phase 3B (Phase 7) — the production ProviderFactory splits IMAP and SMTP
 * endpoint validation. Each capability-scoped method validates ONLY its own
 * protocol's endpoint:
 *   - createImapSession runs the IMAP gate alone → it must succeed for a
 *     sync-only mailbox whose SMTP config is null, and reject an insecure or
 *     incomplete IMAP config.
 *   - createSubmission runs the SMTP gate alone → it must not require IMAP, and
 *     rejects an insecure or incomplete SMTP config.
 * A gate that PASSES reaches the next check (credential_missing here, with an
 * empty credential repo — no network is ever touched), which is how the tests
 * prove acceptance without a plaintext (or any) connection.
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

describe("ImapSmtpProviderFactory — plaintext transport is refused (per protocol)", () => {
  it("createImapSession rejects imap_security = 'none'; createSubmission is unaffected", async () => {
    const factory = makeFactory();
    const mailbox = sendableMailbox({ imapSecurity: "none" });
    // IMAP fails ONLY on the IMAP gate; the SMTP config is still valid.
    expect(await codeOf(factory.createImapSession(mailbox))).toBe(
      "config_invalid",
    );
    expect(await codeOf(factory.createSubmission(mailbox))).toBe(
      "credential_missing",
    );
  });

  it("createSubmission rejects smtp_security = 'none'; createImapSession is unaffected", async () => {
    const factory = makeFactory();
    const mailbox = sendableMailbox({ smtpSecurity: "none" });
    expect(await codeOf(factory.createSubmission(mailbox))).toBe(
      "config_invalid",
    );
    expect(await codeOf(factory.createImapSession(mailbox))).toBe(
      "credential_missing",
    );
  });

  it("a null imap_security fails ONLY the IMAP method; a null smtp_security fails ONLY the SMTP method", async () => {
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
    // The other protocol's method still passes its own (valid) gate.
    expect(
      await codeOf(
        factory.createSubmission(sendableMailbox({ imapSecurity: null })),
      ),
    ).toBe("credential_missing");
    expect(
      await codeOf(
        factory.createImapSession(sendableMailbox({ smtpSecurity: null })),
      ),
    ).toBe("credential_missing");
  });
});

describe("ImapSmtpProviderFactory — IMAP and SMTP endpoints validate independently", () => {
  it("valid IMAP + null SMTP config → createImapSession passes its gate (sync-only mailbox)", async () => {
    const factory = makeFactory();
    // A sync-only mailbox: no SMTP host/port/security at all.
    const syncOnly = sendableMailbox({
      smtpHost: null,
      smtpPort: null,
      smtpSecurity: null,
    });
    expect(await codeOf(factory.createImapSession(syncOnly))).toBe(
      "credential_missing", // IMAP gate passed; no SMTP requirement leaked in
    );
    // ...and constructing a submission for that same mailbox correctly refuses.
    expect(await codeOf(factory.createSubmission(syncOnly))).toBe(
      "config_invalid",
    );
  });

  it("valid SMTP + null IMAP config → createSubmission passes its gate (send-only)", async () => {
    const factory = makeFactory();
    const sendOnly = sendableMailbox({
      imapHost: null,
      imapPort: null,
      imapSecurity: null,
    });
    expect(await codeOf(factory.createSubmission(sendOnly))).toBe(
      "credential_missing", // SMTP gate passed; no IMAP requirement leaked in
    );
    expect(await codeOf(factory.createImapSession(sendOnly))).toBe(
      "config_invalid",
    );
  });

  it("missing IMAP host/port fails ONLY createImapSession", async () => {
    const factory = makeFactory();
    expect(
      await codeOf(
        factory.createImapSession(sendableMailbox({ imapHost: null })),
      ),
    ).toBe("config_invalid");
    expect(
      await codeOf(
        factory.createSubmission(sendableMailbox({ imapHost: null })),
      ),
    ).toBe("credential_missing");
  });

  it("accepts 'ssl' on both protocols (each method reaches its credential check)", async () => {
    const factory = makeFactory();
    expect(await codeOf(factory.createImapSession(sendableMailbox()))).toBe(
      "credential_missing",
    );
    expect(await codeOf(factory.createSubmission(sendableMailbox()))).toBe(
      "credential_missing",
    );
  });
});
