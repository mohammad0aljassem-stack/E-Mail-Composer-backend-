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
import { buildOutboundMime } from "../mime/outbound-builder.js";
import type { Logger } from "../observability/logger.js";
import type {
  AuditWriter,
  MailboxReader,
  SendAttemptStore,
  SendIntentReader,
  WorkerClaimStore,
} from "../db/repository-interfaces.js";
import type {
  MailProvider,
  OutboundMessage,
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
  claims: WorkerClaimStore;
  audit: AuditWriter;
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

    // (9) Already accepted → Sent-copy reconciliation ONLY.
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

      // (4) Integrity re-verification from the `claimed` state.
      const payload = await this.deps.payloadResolver.resolve(intent);
      const integrity = await this.verifyIntegrity(intent, payload);
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

      const outbound: OutboundMessage = {
        ...payload.message,
        messageId: intent.messageId,
      };
      const provider = await this.deps.providerFactory.create(mailbox);
      try {
        return await this.deliver(
          intent,
          cur.id,
          cur.version,
          provider,
          outbound,
          log,
        );
      } finally {
        await provider.disconnect().catch(() => undefined);
      }
    } finally {
      await this.deps.claims.release(cur.id).catch(() => undefined);
    }
  }

  private async deliver(
    intent: SendIntentRow,
    attemptId: string,
    versionAtClaimed: bigint,
    provider: MailProvider,
    outbound: OutboundMessage,
    log: Logger,
  ): Promise<SendOutcome> {
    // claimed -> smtp_in_progress (a crash from here = ambiguous on restart).
    const inProgress = await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: versionAtClaimed,
      expectedState: "claimed",
      toState: "smtp_in_progress",
      fields: { messageId: intent.messageId },
    });
    if (inProgress === null) return "claim_lost";

    await this.deps.audit.append({
      workspaceId: intent.workspaceId,
      mailboxId: intent.mailboxId,
      eventType: "smtp_send_started",
      sendIntentId: intent.id,
      sendAttemptId: attemptId,
      messageId: intent.messageId,
    });

    let sendResponse: string;
    try {
      const result = await provider.sendMessage(outbound); // OUTSIDE any txn
      sendResponse = result.response;
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

    const accepted = await this.deps.attempts.compareAndSet({
      id: attemptId,
      expectedVersion: inProgress.version,
      expectedState: "smtp_in_progress",
      toState: "smtp_accepted",
      fields: { smtpResponse: sendResponse.slice(0, 4000) },
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

    return this.appendSentAndComplete(
      intent,
      attemptId,
      accepted.version,
      "smtp_accepted",
      provider,
      outbound,
      log,
    );
  }

  private async appendSentAndComplete(
    intent: SendIntentRow,
    attemptId: string,
    version: bigint,
    fromState: "smtp_accepted" | "sent_copy_pending",
    provider: MailProvider,
    outbound: OutboundMessage,
    log: Logger,
  ): Promise<SendOutcome> {
    const sentFolder = this.deps.config.sentFolder;
    try {
      const existing = await provider.findByMessageId(
        sentFolder,
        intent.messageId,
      );
      if (existing === null) {
        const built = await buildOutboundMime(outbound);
        await provider.appendSentCopy(sentFolder, built.raw);
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
    const provider = await this.deps.providerFactory.create(mailbox);
    try {
      const payload = await this.deps.payloadResolver.resolve(intent);
      const outbound: OutboundMessage = {
        ...payload.message,
        messageId: intent.messageId,
      };
      return await this.appendSentAndComplete(
        intent,
        attemptId,
        version,
        state,
        provider,
        outbound,
        log,
      );
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
  }

  // ---- verification helpers ------------------------------------------------

  private async mailboxSendable(mailboxId: string): Promise<boolean> {
    if (this.deps.config.globalKillSwitch) return false;
    const mailbox = await this.deps.mailboxes.getById(mailboxId);
    return mailbox !== null && mailbox.enabled && !mailbox.killSwitch;
  }

  private async verifyIntegrity(
    intent: SendIntentRow,
    payload: ResolvedSendPayload,
  ): Promise<IntegrityResult> {
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
    const built = await buildOutboundMime({
      ...m,
      messageId: intent.messageId,
    });
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
