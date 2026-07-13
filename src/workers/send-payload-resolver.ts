import { TransportError } from "../domain/errors.js";
import type { DraftVersionRow, SendIntentRow } from "../domain/models.js";
import type { DraftVersionReader } from "../db/repository-interfaces.js";
import { renderDraftBody } from "../mime/draft-renderer.js";
import type { ResolvedSendPayload, SendPayloadResolver } from "./ports.js";

/**
 * Production send-payload resolver (Phase 3B C4): reconstructs the confirmed
 * body for an IMMUTABLE send intent from the append-only draft snapshot table.
 *
 * Source hierarchy (exactly, in order):
 *  1. The immutable send_intents row itself — sender, recipients, subject and
 *     Message-ID are ECHOED from the intent, never substituted; the executor's
 *     verifyIntegrity proves the echo.
 *  2. The public.draft_versions snapshot with the intent's EXACT
 *     source_revision (highest version_no if several). The mutable drafts row
 *     is NEVER read — this resolver deliberately has no drafts dependency, so
 *     later edits cannot leak into a confirmed send.
 *  3. The deterministic worker renderer (../mime/draft-renderer.js) turns the
 *     snapshot's body_json into html + text. The executor then re-hashes the
 *     rendered bodies and verifies them against the intent's
 *     html_hash/text_hash BEFORE any SMTP byte — renderer divergence can only
 *     FAIL the send, never change what is sent.
 *
 * Fail-closed rules (content-free reason codes, surfaced via
 * TransportError.context.reason and classified by the executor as
 * failed_before_delivery — non-retryable, zero SMTP bytes):
 *  - `attachments_unsupported`      — the intent declares attachments. The
 *    worker has NO Supabase Storage client, so attachment BYTES are
 *    unreachable; Gate G specifies zero attachments, and attachment streaming
 *    is a separately-authorized later step. (The executor's manifestEqual
 *    check independently keeps guarding payload-vs-intent.)
 *  - `draft_revision_snapshot_missing` — no snapshot exists for the exact
 *    confirmed revision. Snapshots are checkpoints, not guaranteed per
 *    revision; a near-miss revision is NEVER substituted (specified behavior).
 *  - `draft_version_unreadable`     — the snapshot SELECT itself failed. The
 *    canonical migrations currently grant transport_worker NO SELECT on
 *    public.draft_versions, so this is the expected production outcome until
 *    a future additive UI grant migration lands (see DraftVersionRepository).
 *  - `draft_version_scope_mismatch` — a returned row does not match the
 *    intent's workspace/draft/revision (impossible via the WHERE clause;
 *    asserted anyway — defense in depth).
 *  - `draft_body_bounds_exceeded` / `draft_render_failed` — the snapshot body
 *    violates the 1 MiB bound or the canonical node/mark subset.
 */
export class DraftVersionSendPayloadResolver implements SendPayloadResolver {
  public constructor(
    private readonly deps: {
      draftVersions: DraftVersionReader;
    },
  ) {}

  public async resolve(intent: SendIntentRow): Promise<ResolvedSendPayload> {
    // Zero-attachment policy: fail closed BEFORE touching the database.
    if (intent.attachmentManifest.length > 0) {
      throw this.refuse("attachments_unsupported");
    }

    let row: DraftVersionRow | null;
    try {
      row = await this.deps.draftVersions.findDraftVersion(
        intent.workspaceId,
        intent.draftId,
        intent.draftRevision,
      );
    } catch {
      // Content-free: the underlying driver error (which may name columns) is
      // deliberately NOT propagated or logged here.
      throw this.refuse("draft_version_unreadable");
    }
    if (row === null) {
      throw this.refuse("draft_revision_snapshot_missing");
    }
    if (
      row.workspaceId !== intent.workspaceId ||
      row.draftId !== intent.draftId ||
      row.sourceRevision !== intent.draftRevision
    ) {
      throw this.refuse("draft_version_scope_mismatch");
    }

    let rendered: { html: string; text: string };
    try {
      rendered = renderDraftBody(row.bodyJson);
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
      revision: row.sourceRevision,
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
