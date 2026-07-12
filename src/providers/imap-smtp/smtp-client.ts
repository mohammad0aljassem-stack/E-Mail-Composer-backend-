import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { SmtpAmbiguousError, SmtpPreDataError } from "../../domain/errors.js";
import type { SmtpClient, SmtpSendCommand, SmtpSendResult } from "./ports.js";

/**
 * Real SMTP submission adapter over Nodemailer.
 *
 * SMTP is not exactly-once delivery. This adapter's ONLY job beyond submission
 * is to classify failures so the send worker can apply the correct terminal
 * state:
 *   - pre-DATA (connect/auth/envelope, nothing submitted) → SmtpPreDataError
 *     → failed_before_delivery, never auto-retried.
 *   - during/after DATA, or lost response → SmtpAmbiguousError
 *     → needs_human_review, never auto-retried, evidence preserved.
 * When in doubt we choose AMBIGUOUS (the safe, no-resend classification).
 */

interface NodemailerError extends Error {
  code?: string;
  responseCode?: number;
  command?: string;
}

/** Nodemailer error codes that unambiguously occur BEFORE any DATA is sent. */
const PRE_DATA_CODES = new Set([
  "ECONNECTION",
  "EAUTH",
  "EENVELOPE",
  "EDNS",
  "EPROTOCOL",
]);

function classify(err: NodemailerError, command: string): never {
  const code = err.code ?? "";
  // If the failing command is known to be before DATA, it's a clean pre-DATA
  // failure. Nodemailer sets `command` on envelope/greeting errors.
  const failedCommand = err.command ?? command;
  const preDataCommand =
    failedCommand === "CONN" ||
    failedCommand === "EHLO" ||
    failedCommand === "HELO" ||
    failedCommand === "AUTH" ||
    failedCommand === "MAIL" ||
    failedCommand === "RCPT";
  if (PRE_DATA_CODES.has(code) || preDataCommand) {
    throw new SmtpPreDataError("smtp failed before data", {
      code,
      command: failedCommand,
    });
  }
  // Everything else (timeout/socket/lost response during or after DATA, or an
  // unknown failure) is treated as AMBIGUOUS: the message may have been
  // delivered. Never auto-retry.
  throw new SmtpAmbiguousError("smtp outcome ambiguous", {
    code,
    command: failedCommand,
  });
}

export class NodemailerSmtpClient implements SmtpClient {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  public constructor(options: {
    host: string;
    port: number;
    secure: boolean;
    requireTls?: boolean;
    auth: { user: string; pass: string };
    timeoutMs: number;
  }) {
    const transportOptions: SMTPTransport.Options = {
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.requireTls ?? !options.secure,
      auth: { user: options.auth.user, pass: options.auth.pass },
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    };
    this.transporter = nodemailer.createTransport(transportOptions);
  }

  public async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (err) {
      classify(err as NodemailerError, "CONN");
    }
  }

  public async send(command: SmtpSendCommand): Promise<SmtpSendResult> {
    try {
      const info: SMTPTransport.SentMessageInfo =
        await this.transporter.sendMail({
          envelope: {
            from: command.envelopeFrom,
            to: [...command.envelopeTo],
          },
          raw: command.raw,
        });
      const accepted: readonly (string | { address: string })[] = info.accepted;
      const rejected: readonly (string | { address: string })[] = info.rejected;
      return {
        response: String(info.response).slice(0, 4000),
        accepted: accepted.map((a) => (typeof a === "string" ? a : a.address)),
        rejected: rejected.map((a) => (typeof a === "string" ? a : a.address)),
      };
    } catch (err) {
      classify(err as NodemailerError, "DATA");
    }
  }

  public async close(): Promise<void> {
    this.transporter.close();
    await Promise.resolve();
  }
}
