import type {
  MailboxReader,
  MirrorSnapshotReader,
} from "../db/repository-interfaces.js";
import { renderDraftBody } from "../mime/draft-renderer.js";
import { buildOutboundMime } from "../mime/outbound-builder.js";
import type {
  DraftPayload,
  DraftPayloadResolver,
  DraftMirrorJobInput,
} from "./draft-mirror-executor.js";

/**
 * Deterministic, pinned Date for every mirrored draft's MIME. The private
 * mirror accessor (transport.get_mirror_snapshot) does not expose created_at,
 * so we pin a single fixed epoch instead: mirror MIME is a local Drafts-folder
 * artifact (never routed), and a constant Date keeps the header byte-stable
 * across rebuilds. The Message-ID (derived per draft+revision) is the real
 * idempotency anchor; the Date only needs to be deterministic.
 */
const MIRROR_MIME_DATE = new Date(0);

/**
 * Production draft-mirror payload resolver (Phase 3B, contract v2): reconstructs
 * the exact draft MIME for a (workspace, mailbox, draft, immutable revision)
 * mirror job from the confirmed snapshot resolved via the PRIVATE
 * transport.get_mirror_snapshot(workspace_id, draft_id, source_revision)
 * function + the SAME deterministic renderer + the SAME buildOutboundMime
 * pipeline the send path uses. The worker has NO grant on public.draft_versions;
 * this function is the sole read path and a near-miss revision is never
 * substituted (the workspace/draft/revision triple is the exact key).
 *
 * Fail-closed rules — any gap returns null, which the executor maps to
 * skipped_missing_payload (nothing appended, nothing retired):
 *  - No snapshot exists for the EXACT (workspace, draft, source_revision)
 *    triple the job names (get_mirror_snapshot raised P0002 → the repository's
 *    SnapshotUnavailableError), or the accessor was otherwise unreadable.
 *  - The snapshot body violates the canonical node/mark subset or 1 MiB bound.
 *  - The mailbox row is missing (the From header derives from it).
 *
 * Determinism/idempotency: the MIME's Message-ID is DERIVED deterministically
 * from (draftId, revision) under the RFC 2606 reserved `.invalid` TLD — it is
 * never random, never routable, and never collides with a send intent's
 * Message-ID (this is NOT new send Message-ID generation; send intents keep
 * their immutable ids). The Date header is pinned to a fixed epoch (see
 * MIRROR_MIME_DATE). Attachments are NEVER included (zero-attachment policy,
 * same as the send path: the worker has no Storage access; draft_attachments
 * stay UI-side).
 *
 * A mirror NEVER creates a send intent and NEVER constructs SMTP — the
 * executor opens an IMAP session only, proven by the C1 construction counters.
 */
export class DraftVersionMirrorPayloadResolver implements DraftPayloadResolver {
  public constructor(
    private readonly deps: {
      mirrorSnapshots: MirrorSnapshotReader;
      mailboxes: MailboxReader;
    },
  ) {}

  public async resolve(job: DraftMirrorJobInput): Promise<DraftPayload | null> {
    let snapshot;
    try {
      snapshot = await this.deps.mirrorSnapshots.getMirrorSnapshot(
        job.workspaceId,
        job.draftId,
        job.revision,
      );
    } catch {
      return null; // no snapshot / unreadable accessor → fail closed, content-free
    }

    const mailbox = await this.deps.mailboxes.getById(job.mailboxId);
    if (mailbox === null || mailbox.workspaceId !== job.workspaceId) {
      return null; // no authoritative From address → fail closed
    }

    let rendered: { html: string; text: string };
    try {
      rendered = renderDraftBody(snapshot.bodyJson);
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
        subject: snapshot.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: [],
      },
      { date: MIRROR_MIME_DATE }, // fixed epoch → byte-stable header
    );
    return { revision: job.revision, mime: built.raw };
  }
}
