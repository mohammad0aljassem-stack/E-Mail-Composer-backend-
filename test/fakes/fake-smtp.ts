import {
  SmtpAmbiguousError,
  SmtpPreDataError,
} from "../../src/domain/errors.js";
import type {
  SmtpClient,
  SmtpSendCommand,
  SmtpSendResult,
} from "../../src/providers/imap-smtp/ports.js";

/**
 * Deterministic fake SMTP client with explicit failure injection.
 *
 *  "accept"    → normal acceptance (records the submission).
 *  "pre_data"  → SmtpPreDataError (connect/auth/envelope; nothing submitted).
 *  "ambiguous" → SmtpAmbiguousError (timeout/disconnect during-or-after DATA;
 *                delivery may or may not have happened).
 *  "partial_reject" → the server accepts DATA for the FIRST recipient and
 *                rejects the rest (partial RCPT rejection). The message WAS
 *                transmitted, so the submission IS recorded.
 *  "verify_fail" → verify() throws pre-data (connection/auth failure).
 *
 * Records every accepted submission so tests can assert exactly-once delivery
 * and Message-ID reuse.
 */
export type FakeSmtpBehavior =
  "accept" | "pre_data" | "ambiguous" | "partial_reject";

export interface RecordedSubmission {
  messageId: string;
  envelopeFrom: string;
  envelopeTo: string[];
  raw: Buffer;
}

export class FakeSmtpClient implements SmtpClient {
  public behavior: FakeSmtpBehavior = "accept";
  public verifyOk = true;
  public readonly submissions: RecordedSubmission[] = [];
  public closed = false;

  public verify(): Promise<void> {
    if (!this.verifyOk) {
      return Promise.reject(
        new SmtpPreDataError("verify failed", { command: "CONN" }),
      );
    }
    return Promise.resolve();
  }

  public send(command: SmtpSendCommand): Promise<SmtpSendResult> {
    if (this.behavior === "pre_data") {
      // Nothing is submitted; do NOT record.
      return Promise.reject(
        new SmtpPreDataError("mailbox unavailable", { command: "RCPT" }),
      );
    }
    if (this.behavior === "ambiguous") {
      // The bytes MAY have been delivered — record nothing certain, but the
      // real world might have. We deliberately do not record a submission so
      // tests can assert "no confirmed delivery" while the outcome is ambiguous.
      return Promise.reject(
        new SmtpAmbiguousError("connection dropped during DATA", {
          command: "DATA",
        }),
      );
    }
    if (this.behavior === "partial_reject") {
      // DATA was accepted for the first recipient only: the message WAS
      // transmitted, so record exactly one submission and surface the split.
      const [first, ...rest] = command.envelopeTo;
      this.submissions.push({
        messageId: command.messageId,
        envelopeFrom: command.envelopeFrom,
        envelopeTo: first === undefined ? [] : [first],
        raw: command.raw,
      });
      return Promise.resolve({
        response: "250 2.0.0 OK accepted (partial)",
        accepted: first === undefined ? [] : [first],
        rejected: rest,
      });
    }
    this.submissions.push({
      messageId: command.messageId,
      envelopeFrom: command.envelopeFrom,
      envelopeTo: [...command.envelopeTo],
      raw: command.raw,
    });
    return Promise.resolve({
      response: "250 2.0.0 OK accepted",
      accepted: [...command.envelopeTo],
      rejected: [],
    });
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
