/**
 * Constant-shape, content-free error taxonomy.
 *
 * Errors NEVER carry secret material (passwords, ciphertext, plaintext bodies,
 * raw MIME, connection strings, keys). A `code` plus a short, static `message`
 * is the entire public surface; anything variable goes in `context` which the
 * logger is responsible for keeping content-free.
 */

export type TransportErrorCode =
  | "config_invalid"
  | "transport_disabled"
  | "mailbox_disabled"
  | "kill_switch_engaged"
  | "credential_missing"
  | "credential_decrypt_failed"
  | "crypto_key_invalid"
  | "crypto_aad_mismatch"
  | "crypto_key_version_unknown"
  | "crypto_auth_failed"
  | "provider_connect_failed"
  | "provider_auth_failed"
  | "provider_protocol_error"
  | "provider_timeout"
  | "provider_disconnected"
  | "uidvalidity_changed"
  | "mime_limit_exceeded"
  | "mime_parse_failed"
  | "send_precondition_failed"
  | "send_ambiguous"
  | "send_pre_data_failed"
  | "state_conflict"
  | "not_found"
  | "provisioning_refused";

export class TransportError extends Error {
  public readonly code: TransportErrorCode;
  public readonly retryable: boolean;
  public readonly context: Readonly<Record<string, string | number | boolean>>;

  public constructor(
    code: TransportErrorCode,
    message: string,
    options?: {
      retryable?: boolean;
      context?: Record<string, string | number | boolean>;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "TransportError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.context = Object.freeze({ ...(options?.context ?? {}) });
  }
}

/**
 * A pre-DATA SMTP failure (connect/auth/local validation, no DATA submitted).
 * Delivery definitively did NOT happen → safe to mark failed_before_delivery,
 * but STILL never auto-retried by the send queue.
 */
export class SmtpPreDataError extends TransportError {
  public constructor(
    message: string,
    context?: Record<string, string | number | boolean>,
    cause?: unknown,
  ) {
    super("send_pre_data_failed", message, {
      retryable: false,
      ...(context !== undefined ? { context } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "SmtpPreDataError";
  }
}

/**
 * An ambiguous SMTP outcome: DATA may or may not have been accepted (timeout or
 * disconnect during/after DATA, lost response, restart mid-flight). The message
 * MIGHT have been delivered. → needs_human_review, zero auto-retry, preserve
 * Message-ID + evidence, never auto-enqueue another send.
 */
export class SmtpAmbiguousError extends TransportError {
  public constructor(
    message: string,
    context?: Record<string, string | number | boolean>,
    cause?: unknown,
  ) {
    super("send_ambiguous", message, {
      retryable: false,
      ...(context !== undefined ? { context } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "SmtpAmbiguousError";
  }
}
