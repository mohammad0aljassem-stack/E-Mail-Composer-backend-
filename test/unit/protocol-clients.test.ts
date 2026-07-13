import { describe, expect, it } from "vitest";
import {
  SmtpAmbiguousError,
  SmtpPreDataError,
} from "../../src/domain/errors.js";
import {
  buildImapFlowOptions,
  parseReferencesHeader,
} from "../../src/providers/imap-smtp/imap-client.js";
import {
  classify,
  type NodemailerError,
} from "../../src/providers/imap-smtp/smtp-client.js";

/**
 * T1 — pins the SMTP failure-classification table (pre-DATA vs ambiguous).
 * C8 — pins the IMAP client timeout wiring (incl. connectionTimeout).
 * C9 — pins the bounded References-header extraction used by live sync.
 */

function nmError(fields: {
  code?: string;
  command?: string;
  message?: string;
}): NodemailerError {
  const err: NodemailerError = new Error(fields.message ?? "smtp failure");
  if (fields.code !== undefined) err.code = fields.code;
  if (fields.command !== undefined) err.command = fields.command;
  return err;
}

describe("T1 — classify(): pre-DATA vs ambiguous", () => {
  it("EDNS is pre-DATA (nothing submitted)", () => {
    expect(() => classify(nmError({ code: "EDNS" }), "DATA")).toThrow(
      SmtpPreDataError,
    );
  });

  it("ECONNECTION is pre-DATA", () => {
    expect(() => classify(nmError({ code: "ECONNECTION" }), "DATA")).toThrow(
      SmtpPreDataError,
    );
  });

  it("EAUTH is pre-DATA", () => {
    expect(() => classify(nmError({ code: "EAUTH" }), "DATA")).toThrow(
      SmtpPreDataError,
    );
  });

  it("EENVELOPE (all recipients rejected) is pre-DATA", () => {
    expect(() => classify(nmError({ code: "EENVELOPE" }), "DATA")).toThrow(
      SmtpPreDataError,
    );
  });

  it("a failure on the MAIL command is pre-DATA even without a known code", () => {
    expect(() => classify(nmError({ command: "MAIL" }), "DATA")).toThrow(
      SmtpPreDataError,
    );
  });

  it("a TLS-shaped error (no known code, no pre-DATA command) is AMBIGUOUS", () => {
    // The conservative default: anything not PROVABLY pre-DATA is treated as
    // "the message may have been delivered" → needs_human_review, no resend.
    const tlsShaped = nmError({
      message: "unable to verify the first certificate",
    });
    expect(() => classify(tlsShaped, "DATA")).toThrow(SmtpAmbiguousError);
  });

  it("classification is content-free (code + command only)", () => {
    try {
      classify(nmError({ code: "ETIMEDOUT", command: "DATA" }), "DATA");
      expect.unreachable();
    } catch (err) {
      const amb = err as SmtpAmbiguousError;
      expect(amb.context).toEqual({ code: "ETIMEDOUT", command: "DATA" });
    }
  });
});

describe("C8 — IMAP client options include a bounded connectionTimeout", () => {
  it("sets connection/greeting/socket timeouts to the configured bound", () => {
    const opts = buildImapFlowOptions({
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "u", pass: "p" },
      timeoutMs: 12_345,
    });
    expect(opts.connectionTimeout).toBe(12_345);
    expect(opts.greetingTimeout).toBe(12_345);
    expect(opts.socketTimeout).toBe(12_345);
    expect(opts.secure).toBe(true);
    expect(opts.logger).toBe(false); // content-free: imapflow never logs
  });
});

describe("C9 — References header extraction (bounded, headers only)", () => {
  it("parses a simple References header", () => {
    const headers = Buffer.from(
      "Message-ID: <c@x>\r\nReferences: <a@x> <b@x>\r\n\r\n",
    );
    expect(parseReferencesHeader(headers)).toBe("<a@x> <b@x>");
  });

  it("unfolds a folded References header", () => {
    const headers = Buffer.from(
      "References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nSubject: s\r\n",
    );
    expect(parseReferencesHeader(headers)).toBe("<a@x> <b@x> <c@x>");
  });

  it("returns null when absent or when no headers were fetched", () => {
    expect(parseReferencesHeader(Buffer.from("Subject: s\r\n"))).toBeNull();
    expect(parseReferencesHeader(undefined)).toBeNull();
    expect(parseReferencesHeader(Buffer.from("References: \r\n"))).toBeNull();
  });

  it("bounds a pathological header to 4000 chars", () => {
    const huge = `References: ${"<x@x> ".repeat(2000)}\r\n`;
    const parsed = parseReferencesHeader(Buffer.from(huge));
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBeLessThanOrEqual(4000);
  });
});
