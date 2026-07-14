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
  | "mime_artifact_rejected"
  | "snapshot_unavailable"
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
 * The private snapshot accessor (transport.get_send_snapshot /
 * transport.get_mirror_snapshot) refused to return a snapshot: the intent is
 * missing, legacy (proof-v1 / contract != 2), or its bound draft_versions row is
 * missing/inconsistent — the function raises a single uniform P0002 for all of
 * them, so the worker cannot (and must not) tell which. Content-free by
 * construction: it names no column, body, or identifier. Fail-closed — the send
 * path never constructs SMTP, the mirror path skips.
 */
export class SnapshotUnavailableError extends TransportError {
  public constructor(context?: Record<string, string | number | boolean>) {
    super("snapshot_unavailable", "confirmed snapshot not available", {
      retryable: false,
      ...(context !== undefined ? { context } : {}),
    });
    this.name = "SnapshotUnavailableError";
  }
}

/**
 * The private exact-MIME persistence path
 * (transport.create_or_verify_send_mime_artifact) refused to create or verify an
 * artifact: the attempt was not exactly 'claimed', the parent chain
 * (attempt/intent/workspace/message_id) was inconsistent, the exact-bytes
 * hash/size/25MiB-bound did not hold, or a restart/reconciliation VERIFY diverged
 * from the stored durable digest/size/bytes. The function raises a single uniform
 * 23514 for all of them, so the worker cannot (and must not) tell which. Content-
 * free by construction: names no column, body, or identifier. Fail-closed — the
 * send path never constructs SMTP.
 */
export class MimeArtifactError extends TransportError {
  public constructor(context?: Record<string, string | number | boolean>) {
    super("mime_artifact_rejected", "MIME artifact create/verify refused", {
      retryable: false,
      ...(context !== undefined ? { context } : {}),
    });
    this.name = "MimeArtifactError";
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
