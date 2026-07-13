import type { DraftVersionRow } from "../domain/models.js";
import type {
  DraftVersionReader,
  MailboxReader,
} from "../db/repository-interfaces.js";
import { renderDraftBody } from "../mime/draft-renderer.js";
import { buildOutboundMime } from "../mime/outbound-builder.js";
import type {
  DraftPayload,
  DraftPayloadResolver,
  DraftMirrorJobInput,
} from "./draft-mirror-executor.js";

/**
 * Production draft-mirror payload resolver (Phase 3B C6): reconstructs the
 * exact draft MIME for a (workspace, mailbox, draft, immutable revision)
 * mirror job from the SAME immutable public.draft_versions snapshot + the
 * SAME deterministic renderer + the SAME buildOutboundMime pipeline the send
 * path uses.
 *
 * Fail-closed rules — any gap returns null, which the executor maps to
 * skipped_missing_payload (nothing appended, nothing retired):
 *  - No snapshot exists for the EXACT source_revision the job names (a
 *    near-miss revision is never substituted), or the snapshot table is
 *    unreadable (the canonical grants give transport_worker no SELECT on
 *    draft_versions yet — same documented follow-up as the send resolver).
 *  - The snapshot body violates the canonical node/mark subset or 1 MiB bound.
 *  - The mailbox row is missing (the From header derives from it).
 *
 * Determinism/idempotency: the MIME's Message-ID is DERIVED deterministically
 * from (draftId, revision) under the RFC 2606 reserved `.invalid` TLD — it is
 * never random, never routable, and never collides with a send intent's
 * Message-ID (this is NOT new send Message-ID generation; send intents keep
 * their immutable ids). The Date header is pinned to the snapshot's immutable
 * created_at. Attachments are NEVER included (zero-attachment policy, same as
 * the send path: the worker has no Storage access; draft_attachments stay
 * UI-side).
 *
 * A mirror NEVER creates a send intent and NEVER constructs SMTP — the
 * executor opens an IMAP session only, proven by the C1 construction counters.
 */
export class DraftVersionMirrorPayloadResolver implements DraftPayloadResolver {
  public constructor(
    private readonly deps: {
      draftVersions: DraftVersionReader;
      mailboxes: MailboxReader;
    },
  ) {}

  public async resolve(job: DraftMirrorJobInput): Promise<DraftPayload | null> {
    let row: DraftVersionRow | null;
    try {
      row = await this.deps.draftVersions.findDraftVersion(
        job.workspaceId,
        job.draftId,
        job.revision,
      );
    } catch {
      return null; // unreadable snapshot table → fail closed, content-free
    }
    if (
      row === null ||
      row.workspaceId !== job.workspaceId ||
      row.draftId !== job.draftId ||
      row.sourceRevision !== job.revision
    ) {
      return null;
    }

    const mailbox = await this.deps.mailboxes.getById(job.mailboxId);
    if (mailbox === null || mailbox.workspaceId !== job.workspaceId) {
      return null; // no authoritative From address → fail closed
    }

    let rendered: { html: string; text: string };
    try {
      rendered = renderDraftBody(row.bodyJson);
    } catch {
      return null; // invalid/oversized snapshot body → fail closed
    }

    const built = await buildOutboundMime(
      {
        // Deterministic, non-routable draft Message-ID (idempotent per
        // draft+revision; distinct from any send intent's immutable id).
        messageId: `<draft-${job.draftId}.r${job.revision.toString()}@mirror.invalid>`,
        sender: mailbox.emailAddress,
        recipients: { to: [] }, // a draft need not have recipients yet
        subject: row.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: [],
      },
      { date: row.createdAt }, // pinned to the immutable snapshot timestamp
    );
    return { revision: row.sourceRevision, mime: built.raw };
  }
}
