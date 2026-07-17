import { recomputeConfirmationProof } from "../domain/confirmation-proof.js";
import {
  SmtpAmbiguousError,
  SmtpPreDataError,
  TransportError,
} from "../domain/errors.js";
import type { Clock } from "../domain/clock.js";
import type {
  AttachmentManifestEntry,
  MailboxRow,
  SendIntentRow,
  SendRecipients,
} from "../domain/models.js";
import { isPostAcceptance, isTerminal } from "../domain/send-state.js";
import { buildOutboundMime, sha256Hex } from "../mime/outbound-builder.js";
import type { BuiltMime } from "../mime/outbound-builder.js";
import type { Logger } from "../observability/logger.js";
import type {
  AuditWriter,
  FolderRoleReader,
  MailboxReader,
  MimeArtifactStore,
  SendAttemptStore,
  SendIntentReader,
  WorkerClaimStore,
} from "../db/repository-interfaces.js";
import type {
  ImapSessionProvider,
  OutboundMessage,
  SendResult,
  SubmissionProvider,
} from "../providers/mail-provider.js";
import type {
  ProviderFactory,
  ResolvedSendPayload,
  SendPayloadResolver,
} from "./ports.js";

/**
 * Safe-send executor — exactly-once INTENT, never blind-retry DELIVERY.
 * See docs/adr/0003-safe-send.md.
 *
 * Ordered guarantees:
 *  1. Sends derive from the IMMUTABLE send_intents snapshot, never a draft row.
 *  2. Kill switches / mailbox-enabled are checked before anything is claimed.
 *  3. An atomic claim ensures at most one worker delivers.
 *  4. Integrity (confirmation-proof, revision, recipients, body hashes,
 *     attachment manifest + sizes, Message-ID) is re-verified AFTER claim, from
 *     the `claimed` state (the only state from which needs_human_review /
 *     failed_before_delivery are legal transitions).
 *  5. The SMTP network call runs OUTSIDE any DB transaction.
 *  6. Restart while smtp_in_progress → needs_human_review (never auto-send).
 *  7. Pre-DATA failure → failed_before_delivery (no retry).
 *  8. Ambiguous failure → needs_human_review, evidence + Message-ID preserved,
 *     never auto-enqueue another send.
 *  9. After acceptance: Sent-copy reconciliation only, never SMTP again.
 */

export type SendOutcome =
  | "completed"
  | "sent_copy_pending"
  | "failed_before_delivery"
  | "needs_human_review"
  | "skipped_terminal"
  | "claim_lost"
  | "aborted_precheck";

export interface SendExecutorDeps {
  intents: SendIntentReader;
  attempts: SendAttemptStore;
  mailboxes: MailboxReader;
  folders: FolderRoleReader;
  claims: WorkerClaimStore;
  audit: AuditWriter;
  mimeArtifacts: MimeArtifactStore;
  providerFactory: ProviderFactory;
  payloadResolver: SendPayloadResolver;
  clock: Clock;
  logger: Logger;
  config: {
    workerId: string;
    claimLeaseMs: number;
    globalKillSwitch: boolean;
    sentFolder: string;
  };
}

export interface SendJob {
  readonly sendIntentId: string;
  readonly sendAttemptId: string;
  readonly workspaceId: string;
}

/**
 * True when an error carries the Postgres SQLSTATE 23514 (check/trigger
 * violation) — used to recognise the DB artifact-before-SMTP ordering guard
 * (trg_send_attempts_require_mime_before_smtp) rejecting a claimed ->
 * smtp_in_progress transition without a valid retained artifact. Content-free:
 * only the SQLSTATE is inspected, never the driver message.
 */
function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23514"
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function recipientsEqual(a: SendRecipients, b: SendRecipients): boolean {
  return (
    arraysEqual(a.to, b.to) &&
    arraysEqual(a.cc ?? [], b.cc ?? []) &&
    arraysEqual(a.bcc ?? [], b.bcc ?? [])
  );
}

function manifestEqual(
  a: readonly AttachmentManifestEntry[],
  b: readonly AttachmentManifestEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      y !== undefined &&
      x.filename === y.filename &&
      x.contentType === y.contentType &&
      x.sizeBytes === y.sizeBytes &&
      x.sha256 === y.sha256
    );
  });
}

type IntegrityResult =
  | { kind: "ok" }
  | { kind: "human"; reason: string }
  | { kind: "failed"; reason: string };

export class SendExecutor {
  public constructor(private readonly deps: SendExecutorDeps) {}

  public async execute(job: SendJob): Promise<SendOutcome> {
    const { attempts, intents, logger } = this.deps;
    const log = logger.child({
      component: "send-executor",
      sendIntentId: job.sendIntentId,
      sendAttemptId: job.sendAttemptId,
    });

    const attempt = await attempts.getById(job.sendAttemptId);
    if (attempt === null) {
      throw new TransportError("not_found", "send attempt not found");
    }
    const intent = await intents.getById(job.sendIntentId);
    if (intent === null) {
      throw new TransportError("not_found", "send intent not found");
    }

    // (1a) Idempotency: terminal states never re-enter the send path.
    if (isTerminal(attempt.state)) {
      log.info("send_skipped_terminal", { state: attempt.state });
      return "skipped_terminal";
    }

    // (6) Restart safety: DATA may be in flight → never auto-send.
    if (attempt.state === "smtp_in_progress") {
      await this.toNeedsHumanReview(
        intent,
        attempt.id,
        attempt.version,
        "smtp_in_progress",
        {
          reason: "restart_during_smtp_in_progress",
        },
      );
      log.warn("send_restart_ambiguous", { state: attempt.state });
      return "needs_human_review";
    }

    // (9) Already accepted → Sent-copy reconciliation ONLY. Never SMTP again.
    if (isPostAcceptance(attempt.state)) {
      return this.reconcileSentCopy(
        intent,
        attempt.id,
        attempt.version,
        attempt.state as "smtp_accepted" | "sent_copy_pending" | "completed",
        log,
      );
    }

    // (2) Kill switch / disabled mailbox — abort WITHOUT consuming the attempt.
    if (!(await this.mailboxSendable(intent.mailboxId))) {
      log.warn("send_aborted_killswitch_or_disabled");
      return "aborted_precheck";
    }

    // (3) confirmed -> queued -> claimed with an atomic lease.
    let cur = attempt;
    if (cur.state === "confirmed") {
      const q = await attempts.compareAndSet({
        id: cur.id,
        expectedVersion: cur.version,
        expectedState: "confirmed",
        toState: "queued",
      });
      if (q === null) return "claim_lost";
      cur = q;
    }
    if (cur.state !== "queued") return "claim_lost";

    const leaseUntil = new Date(
      this.deps.clock.nowMs() + this.deps.config.claimLeaseMs,
    );
    const won = await this.deps.claims.tryClaim({
      sendAttemptId: cur.id,
      workerId: this.deps.config.workerId,
      leaseUntil,
    });
    if (!won) {
      log.info("send_claim_lost");
      return "claim_lost";
    }

    try {
      const claimed = await attempts.compareAndSet({
        id: cur.id,
        expectedVersion: cur.version,
        expectedState: "queued",
        toState: "claimed",
        fields: {
          claimedBy: this.deps.config.workerId,
          claimedAt: this.deps.clock.now(),
        },
      });
      if (claimed === null) {
        await this.deps.claims.release(cur.id);
        return "claim_lost";
      }
      cur = claimed;

      // (4) Integrity re-verification from the `claimed` state. Payload
      // resolution failures (missing immutable snapshot, unreadable snapshot
      // table, unsupported attachments, render failure) fail CLOSED right
      // here: a content-free reason code, ZERO SMTP bytes, non-retryable
      // (failed_before_delivery is never auto-re-enqueued and the send queue
      // is retryLimit 0).
      let payload: ResolvedSendPayload;
      try {
        payload = await this.deps.payloadResolver.resolve(intent);
      } catch (err) {
        const reason =
          err instanceof TransportError &&
          typeof err.context.reason === "string"
            ? err.context.reason
            : "payload_resolution_failed";
        await this.toFailedBeforeDelivery(intent, cur.id, cur.version, {
          reason,
        });
        log.warn("send_payload_resolution_failed", { reason });
        return "failed_before_delivery";
      }
      // (C5) BUILD ONCE: the raw MIME for this execution is constructed here
      // — a single time — with a Date pinned from the worker clock. The SAME
      // built artifact then serves (a) the hash re-verification below, (b)
      // the SMTP submission and (c) the Sent-folder append, so the bytes the
      // user's mailbox stores are byte-identical to the bytes submitted. The
      // pinned date is persisted content-free in the attempt evidence
      // (mime_date) at the smtp_in_progress transition so a RESTART rebuild
      // reproduces the same Date header.
      const outbound: OutboundMessage = {
        ...payload.message,
        messageId: intent.messageId,
      };
      const mimeDate = this.deps.clock.now();
      const built = await buildOutboundMime(outbound, { date: mimeDate });

      const integrity = this.verifyIntegrity(intent, payload, built);
      if (integrity.kind === "human") {
        await this.toNeedsHumanReview(intent, cur.id, cur.version, "claimed", {
          reason: integrity.reason,
        });
        log.warn("send_integrity_human", { reason: integrity.reason });
        return "needs_human_review";
      }
      if (integrity.kind === "failed") {
        await this.toFailedBeforeDelivery(intent, cur.id, cur.version, {
          reason: integrity.reason,
        });
        log.warn("send_integrity_failed", { reason: integrity.reason });
        return "failed_before_delivery";
      }

      // (4b) SENDER AUTHORITY (fail-closed, BEFORE any SMTP byte). The
      // authoritative sender is the immutable persisted send_intents.sender. We
      // load the mailbox for the SAME mailbox/workspace and cross-check that the
      // intent's sender still equals the mailbox address (trim + lowercase). On
      // ANY mismatch we submit ZERO SMTP bytes, record only a content-free
      // failure code, do NOT auto-retry, do NOT silently correct the sender, and
      // do NOT recompute the confirmation proof with a different sender.
      const mailbox = await this.requireMailbox(intent.mailboxId);
      const authority = this.checkSenderAuthority(intent, mailbox);
      if (!authority.ok) {
        await this.toFailedBeforeDelivery(intent, cur.id, cur.version, {
          reason: authority.reason,
        });
        log.warn("send_sender_authority_failed", { reason: authority.reason });
        return "failed_before_delivery";
      }

      // (C5/Phase 6) PERSIST THE EXACT MIME ARTIFACT BEFORE SMTP. The sha256 +
      // byte length are computed from the EXACT built Buffer, and the bytes are
      // persisted through the SECURITY DEFINER create-or-verify function while
      // the attempt is still 'claimed' (the worker holds NO direct INSERT). Any
      // rejection is a uniform, content-free 23514 → MimeArtifactError: fail
      // CLOSED (failed_before_delivery, ZERO SMTP bytes). This is the durable,
      // byte-bound evidence the DB ordering guard re-verifies at the
      // claimed -> smtp_in_progress boundary.
      const mimeSha256 = sha256Hex(built.raw);
      const sizeBytes = BigInt(built.raw.length);
      let artifact;
      try {
        artifact = await this.deps.mimeArtifacts.createOrVerify({
          sendAttemptId: cur.id,
          sendIntentId: intent.id,
          workspaceId: intent.workspaceId,
          messageId: intent.messageId,
          mimeSha256,
          sizeBytes,
          rawMime: built.raw,
        });
      } catch {
        await this.toFailedBeforeDelivery(intent, cur.id, cur.version, {
          reason: "mime_artifact_rejected",
        });
        log.warn("send_mime_artifact_rejected");
        return "failed_before_delivery";
      }
      // (j) The persisted artifact MUST bind the exact bytes we built. A
      // divergence here (defence in depth over the function's own re-hash) fails
      // CLOSED before a single SMTP byte.
      if (
        artifact.mimeSha256 !== mimeSha256 ||
        artifact.sizeBytes !== sizeBytes ||
        artifact.messageId !== intent.messageId
      ) {
        await this.toFailedBeforeDelivery(intent, cur.id, cur.version, {
          reason: "mime_artifact_mismatch",
        });
        log.warn("send_mime_artifact_mismatch");
        return "failed_before_delivery";
      }

      // (C1) Capability-scoped construction: the SMTP submission channel is
      // built ONLY here — strictly AFTER the integrity verification (4), the
      // sender-authority guard (4b) and the exact-MIME persistence above. No
      // other code path may call createSubmission.
      const submission =
        await this.deps.providerFactory.createSubmission(mailbox);
      try {
        return await this.deliver(
          intent,
          cur.id,
          cur.version,
          mailbox,
          submission,
          outbound,
          built,
          mimeDate.toUTCString(),
          log,
        );
      } finally {
        await submission.close().catch(() => undefined);
      }
    } finally {
      await this.deps.claims.release(cur.id).catch(() => undefined);
    }
  }

  private async deliver(
    intent: SendIntentRow,
    attemptId: string,
    versionAtClaimed: bigint,
    mailbox: MailboxRow,
    submission: SubmissionProvider,
    outbound: OutboundMessage,
    built: BuiltMime,
    mimeDate: string,
    log: Logger,
  ): Promise<SendOutcome> {
    // claimed -> smtp_in_progress (a crash from here = ambiguous on restart).
    // The pinned MIME Date is persisted content-free (an RFC-2822 date names
    // no body/recipient) BEFORE the network call. The DB ordering guard
    // (trg_send_attempts_require_mime_before_smtp) re-verifies a valid retained
    // MIME artifact exists at exactly this boundary: a missing/invalid artifact
    // makes this UPDATE raise 23514, which we treat as failed_before_delivery
    // with ZERO SMTP bytes (the attempt is still 'claimed').
    let inProgress;
    try {
      inProgress = await this.deps.attempts.compareAndSet({
        id: attemptId,
        expectedVersion: versionAtClaimed,
        expectedState: "claimed",
        toState: "smtp_in_progress",
        fields: {
          messageId: intent.messageId,
          evidence: { mime_date: mimeDate },
        },
      });
    } catch (err) {
      if (isCheckViolation(err)) {
        await this.toFailedBeforeDelivery(intent, attemptId, versionAtClaimed, {
          reason: "mime_artifact_missing_before_smtp",
        });
        log.warn("send_mime_artifact_missing_before_smtp");
        return "failed_before_delivery";
      }
      throw err;
    }
    if (inProgress === null) return "claim_lost";

    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "smtp_send_started",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
    });

    let sendResult: SendResult;
    try {
      // OUTSIDE any txn. The prebuilt artifact carries the wire bytes: the
      // submission must NOT rebuild (build-once, C5).
      sendResult = await submission.sendMessage(outbound, built);
    } catch (err) {
      if (err instanceof SmtpPreDataError) {
        await this.deps.attempts.compareAndSet({
          id: attemptId,
          expectedVersion: inProgress.version,
          expectedState: "smtp_in_progress",
          toState: "failed_before_delivery",
          fields: {
            smtpResponse: "pre-data failure",
            evidence: { ...err.context, classification: "pre_data" },
          },
        });
        await this.deps.audit.append({
          workspaceId: intent.workspaceId,
          mailboxId: intent.mailboxId,
          eventType: "smtp_failed_before_delivery",
          sendIntentId: intent.id,
          sendAttemptId: attemptId,
          messageId: intent.messageId,
        });
        log.warn("smtp_pre_data_failure");
        return "failed_before_delivery";
      }
      // Ambiguous (or any unknown error) → needs_human_review.
      const ctx =
        err instanceof SmtpAmbiguousError
          ? err.context
          : { classification: "unknown_error" };
      await this.toNeedsHumanReview(
        intent,
        attemptId,
        inProgress.version,
        "smtp_in_progress",
        {
          ...ctx,
          classification: "ambiguous",
        },
      );
      log.error("smtp_ambiguous_failure");
      return "needs_human_review";
    }

    // Partial RCPT rejection: the SMTP server accepted DATA for SOME recipients
    // and rejected others. The message WAS transmitted (to the accepted set),
    // so this must never look like a clean completion and must NEVER be
    // retried (a retry would double-deliver to the accepted recipients).
    // Evidence is counts only — never a recipient address. (A fully rejected
    // envelope throws EENVELOPE before DATA and takes the pre-DATA path; a
    // resolved result with rejections is therefore handled conservatively
    // whenever rejected_count > 0.)
    const acceptedCount = sendResult.accepted.length;
    const rejectedCount = sendResult.rejected.length;
    if (rejectedCount > 0) {
      await this.toNeedsHumanReview(
        intent,
        attemptId,
        inProgress.version,
        "smtp_in_progress",
        {
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          reason: "rcpt_partial_rejection",
        },
      );
      log.warn("smtp_partial_rejection", {
        accepted_count: acceptedCount,
        rejected_count: rejectedCount,
      });
      return "needs_human_review";
    }

    const accepted = await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: inProgress.version,
      expectedState: "smtp_in_progress",
      toState: "smtp_accepted",
      fields: { smtpResponse: sendResult.response.slice(0, 4000) },
    });
    if (accepted === null) return "claim_lost";

    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "smtp_accepted",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
    });

    // In-run path: the Sent copy is the EXACT Buffer just submitted — no
    // rebuild, byte-identical by construction (C5).
    return this.appendSentAndComplete(
      intent,
      attemptId,
      accepted.version,
      "smtp_accepted",
      mailbox,
      () => Promise.resolve(built.raw),
      log,
    );
  }

  private async appendSentAndComplete(
    intent: SendIntentRow,
    attemptId: string,
    version: bigint,
    fromState: "smtp_accepted" | "sent_copy_pending",
    mailbox: MailboxRow,
    rawForAppend: () => Promise<Buffer>,
    log: Logger,
  ): Promise<SendOutcome> {
    // Sent-copy work is IMAP-ONLY: an IMAP session is created here and NEVER a
    // submission — after acceptance the message must never be re-submitted.
    let session: ImapSessionProvider | null = null;
    try {
      session = await this.deps.providerFactory.createImapSession(mailbox);
      // Resolve the DISCOVERED sent-role folder for this mailbox (IONOS
      // localizes it, e.g. "Gesendete Objekte"); fall back to the configured
      // default when discovery has no sent-role row. Used by both the direct
      // completion path and reconcileSentCopy (which delegates here).
      const sentFolder = await this.resolveSentFolder(intent.mailboxId);
      // Message-ID search FIRST: an existing copy is never appended twice, and
      // the raw bytes are only (re)materialized when an append is needed.
      const existing = await session.findByMessageId(
        sentFolder,
        intent.messageId,
      );
      if (existing === null) {
        await session.appendSentCopy(sentFolder, await rawForAppend());
      }
    } catch {
      await this.deps.attempts.compareAndSet({
        id: attemptId,
        expectedVersion: version,
        expectedState: fromState,
        toState: "sent_copy_pending",
        fields: { evidence: { sent_copy: "pending" } },
      });
      log.warn("sent_copy_pending");
      return "sent_copy_pending";
    } finally {
      if (session !== null) {
        await session.disconnect().catch(() => undefined);
      }
    }

    const completed = await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: version,
      expectedState: fromState,
      toState: "completed",
      fields: { evidence: { sent_copy: "appended" } },
    });
    if (completed === null) return "claim_lost";
    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "send_completed",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
    });
    log.info("send_completed");
    return "completed";
  }

  private async reconcileSentCopy(
    intent: SendIntentRow,
    attemptId: string,
    version: bigint,
    state: "smtp_accepted" | "sent_copy_pending" | "completed",
    log: Logger,
  ): Promise<SendOutcome> {
    if (state === "completed") return "completed";
    const mailbox = await this.requireMailbox(intent.mailboxId);
    // RESTART / RECONCILIATION (Phase 6): the Sent copy is the EXACT stored
    // artifact bytes — NEVER a rebuild. We load the retained artifact only when
    // findByMessageId shows the copy is actually missing (lazy), and re-verify
    // it as defence in depth: bytes present, Message-ID matches the intent,
    // sizeBytes == octet length, and mimeSha256 == sha256(rawMime). Any
    // divergence (or a cleared/missing artifact) throws → the catch in
    // appendSentAndComplete parks sent_copy_pending: nothing is appended, and
    // SMTP is never re-entered.
    const rawForAppend = async (): Promise<Buffer> => {
      const artifact =
        await this.deps.mimeArtifacts.getBySendAttempt(attemptId);
      if (
        artifact === null ||
        artifact.rawMime === null ||
        artifact.messageId !== intent.messageId ||
        artifact.sizeBytes !== BigInt(artifact.rawMime.length) ||
        sha256Hex(artifact.rawMime) !== artifact.mimeSha256
      ) {
        throw new TransportError(
          "send_precondition_failed",
          "stored MIME artifact unavailable or inconsistent",
        );
      }
      return artifact.rawMime;
    };
    // Delegates to appendSentAndComplete, which opens an IMAP session ONLY.
    // Reconciliation after acceptance must NEVER construct a submission.
    return this.appendSentAndComplete(
      intent,
      attemptId,
      version,
      state,
      mailbox,
      rawForAppend,
      log,
    );
  }

  // ---- verification helpers ------------------------------------------------

  /**
   * The Sent folder as DISCOVERED for this mailbox (`mailbox_folders` role =
   * 'sent'), falling back to the configured default name. Read-only lookup.
   */
  private async resolveSentFolder(mailboxId: string): Promise<string> {
    const row = await this.deps.folders.findByRole(mailboxId, "sent");
    return row?.name ?? this.deps.config.sentFolder;
  }

  private async mailboxSendable(mailboxId: string): Promise<boolean> {
    if (this.deps.config.globalKillSwitch) return false;
    const mailbox = await this.deps.mailboxes.getById(mailboxId);
    return mailbox !== null && mailbox.enabled && !mailbox.killSwitch;
  }

  /**
   * Compares the resolved payload AND the once-built MIME artifact against the
   * immutable intent. `built` is the same artifact later submitted/appended
   * (build-once, C5), so what is verified here is literally what goes on the
   * wire.
   */
  private verifyIntegrity(
    intent: SendIntentRow,
    payload: ResolvedSendPayload,
    built: BuiltMime,
  ): IntegrityResult {
    // Confirmation presence + proof integrity → human review on mismatch.
    if (
      intent.confirmedBy.length === 0 ||
      !/^[a-f0-9]{64}$/.test(intent.confirmationProof)
    ) {
      return { kind: "human", reason: "confirmation_missing" };
    }
    if (recomputeConfirmationProof(intent) !== intent.confirmationProof) {
      return { kind: "human", reason: "confirmation_proof_mismatch" };
    }
    // Payload must reconstruct the confirmed bytes exactly → failed on mismatch.
    if (payload.revision !== intent.draftRevision) {
      return { kind: "failed", reason: "revision_mismatch" };
    }
    const m = payload.message;
    if (m.messageId !== intent.messageId) {
      return { kind: "failed", reason: "message_id_mismatch" };
    }
    if (!recipientsEqual(m.recipients, intent.recipients)) {
      return { kind: "failed", reason: "recipients_mismatch" };
    }
    if ((intent.htmlHash ?? null) !== (built.htmlHash ?? null)) {
      return { kind: "failed", reason: "html_hash_mismatch" };
    }
    if ((intent.textHash ?? null) !== (built.textHash ?? null)) {
      return { kind: "failed", reason: "text_hash_mismatch" };
    }
    if (!manifestEqual(built.attachmentManifest, intent.attachmentManifest)) {
      return { kind: "failed", reason: "attachment_manifest_mismatch" };
    }
    return { kind: "ok" };
  }

  /**
   * Authoritative-sender cross-check. The confirmation proof is already bound to
   * `intent.sender`; here we additionally prove — at execution time, from the
   * live mailbox row — that the immutable sender still equals the mailbox
   * address (and belongs to the same workspace). Normalization is the same
   * trim + lowercase the SQL RPC applied, so a legitimately-authored intent
   * always passes and a tampered/stale one fails closed. Content-free reasons.
   */
  private checkSenderAuthority(
    intent: SendIntentRow,
    mailbox: MailboxRow,
  ): { ok: true } | { ok: false; reason: string } {
    if (mailbox.workspaceId !== intent.workspaceId) {
      return { ok: false, reason: "sender_authority_workspace_mismatch" };
    }
    const norm = (s: string): string => s.trim().toLowerCase();
    if (norm(intent.sender) !== norm(mailbox.emailAddress)) {
      return { ok: false, reason: "sender_authority_mismatch" };
    }
    return { ok: true };
  }

  private async requireMailbox(mailboxId: string): Promise<MailboxRow> {
    const mailbox = await this.deps.mailboxes.getById(mailboxId);
    if (mailbox === null) {
      throw new TransportError("not_found", "mailbox not found");
    }
    return mailbox;
  }

  private async toNeedsHumanReview(
    intent: SendIntentRow,
    attemptId: string,
    version: bigint,
    fromState: import("../domain/send-state.js").SendState,
    evidence: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: version,
      expectedState: fromState,
      toState: "needs_human_review",
      fields: { messageId: intent.messageId, evidence },
    });
    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "send_needs_human_review",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
      detail: evidence,
    });
  }

  private async toFailedBeforeDelivery(
    intent: SendIntentRow,
    attemptId: string,
    version: bigint,
    evidence: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: version,
      expectedState: "claimed",
      toState: "failed_before_delivery",
      fields: { evidence },
    });
    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "send_precheck_failed",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
      detail: evidence,
    });
  }
}
