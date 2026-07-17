import { TransportError } from "../domain/errors.js";
import type { SendIntentRow } from "../domain/models.js";
import type { SendSnapshotReader } from "../db/repository-interfaces.js";
import { renderDraftBody } from "../mime/draft-renderer.js";
import type { ResolvedSendPayload, SendPayloadResolver } from "./ports.js";

/**
 * Production send-payload resolver (Phase 3B, contract v2): reconstructs the
 * confirmed body for an IMMUTABLE send intent from the EXACT draft snapshot the
 * intent is bound to — resolved by send_intent_id through the private
 * transport.get_send_snapshot(send_intent_id) function.
 *
 * Source hierarchy (exactly, in order):
 *  1. The immutable send_intents row itself — sender, recipients, subject and
 *     Message-ID are ECHOED from the intent, never substituted; the executor's
 *     verifyIntegrity proves the echo.
 *  2. The confirmed snapshot the intent is bound to, obtained SOLELY via
 *     getSendSnapshot(intent.id). The function returns exactly the
 *     draft_versions row referenced by the intent's draft_version_id and only
 *     when the intent is a fully-formed v2 confirmation whose snapshot matches
 *     its EXACT workspace/draft/revision. The worker has NO grant on
 *     public.draft_versions and NEVER reads the mutable draft, a near-miss
 *     revision, the newest snapshot, or a caller-supplied snapshot id — so a
 *     later edit or a legacy (proof-v1) intent can never leak into a send.
 *  3. The deterministic worker renderer (../mime/draft-renderer.js) turns the
 *     snapshot's body_json into html + text. The executor then re-hashes the
 *     rendered bodies and verifies them against the intent's
 *     html_hash/text_hash BEFORE any SMTP byte — renderer divergence can only
 *     FAIL the send, never change what is sent.
 *
 * Fail-closed rules (content-free reason codes, surfaced via
 * TransportError.context.reason and classified by the executor as
 * failed_before_delivery — non-retryable, zero SMTP bytes):
 *  - `attachments_unsupported` — the intent declares attachments. The worker
 *    has NO Supabase Storage client, so attachment BYTES are unreachable; Gate
 *    G specifies zero attachments, and attachment streaming is a
 *    separately-authorized later step. Checked BEFORE any DB access.
 *  - `snapshot_unavailable` — get_send_snapshot raised the uniform P0002
 *    (missing intent, legacy proof-v1 / contract != 2, or a missing/inconsistent
 *    bound snapshot) OR the accessor was otherwise unreadable. A single
 *    non-disclosing code: the worker cannot tell which check failed, by design.
 *  - `draft_body_bounds_exceeded` / `draft_render_failed` — the snapshot body
 *    violates the 1 MiB bound or the canonical node/mark subset.
 */
export class DraftVersionSendPayloadResolver implements SendPayloadResolver {
  public constructor(
    private readonly deps: {
      sendSnapshots: SendSnapshotReader;
    },
  ) {}

  public async resolve(intent: SendIntentRow): Promise<ResolvedSendPayload> {
    // Zero-attachment policy: fail closed BEFORE touching the database.
    if (intent.attachmentManifest.length > 0) {
      throw this.refuse("attachments_unsupported");
    }

    let snapshot;
    try {
      // Resolve by send_intent_id ONLY. The private function returns the exact
      // bound snapshot or raises a uniform P0002 (mapped to a content-free
      // SnapshotUnavailableError by the repository). Any failure here — missing,
      // legacy, inconsistent, or unreadable — is a single fail-closed outcome.
      snapshot = await this.deps.sendSnapshots.getSendSnapshot(intent.id);
    } catch {
      throw this.refuse("snapshot_unavailable");
    }

    let rendered: { html: string; text: string };
    try {
      rendered = renderDraftBody(snapshot.bodyJson);
    } catch (err) {
      throw this.refuse(
        err instanceof TransportError && err.code === "mime_limit_exceeded"
          ? "draft_body_bounds_exceeded"
          : "draft_render_failed",
      );
    }

    // Envelope + headers all ECHO the immutable intent. The executor's
    // verifyIntegrity re-checks revision, Message-ID, recipients, body hashes
    // and the attachment manifest — nothing here weakens that gate.
    return {
      revision: snapshot.sourceRevision,
      message: {
        messageId: intent.messageId,
        sender: intent.sender,
        recipients: intent.recipients,
        subject: intent.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: [],
      },
    };
  }

  private refuse(reason: string): TransportError {
    return new TransportError(
      "send_precondition_failed",
      "send payload resolution refused",
      { context: { reason } },
    );
  }
}
