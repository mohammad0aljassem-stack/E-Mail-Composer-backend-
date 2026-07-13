import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  DraftMirrorExecutor,
  type DraftPayloadResolver,
} from "../../src/workers/draft-mirror-executor.js";
import {
  FakeAuditRepo,
  FakeDraftMirrorRepo,
  FakeMailboxRepo,
} from "../fakes/in-memory-repos.js";
import { FakeImapServer } from "../fakes/fake-imap.js";
import { FakeSmtpClient } from "../fakes/fake-smtp.js";
import { FakeProviderFactory } from "../fakes/fake-provider-factory.js";
import {
  DRAFT_ID,
  MAILBOX_ID,
  sendableMailbox,
  WORKSPACE_ID,
} from "../helpers/send-fixtures.js";

function mime(rev: bigint): Buffer {
  return Buffer.from(
    `Message-ID: <draft-${rev}@x>\r\nSubject: draft rev ${rev}\r\n\r\nbody`,
    "utf8",
  );
}

function makeHarness(availableRevisions: bigint[] = [1n, 2n, 3n]) {
  const mailboxes = new FakeMailboxRepo();
  mailboxes.rows.set(MAILBOX_ID, sendableMailbox());
  const mirrors = new FakeDraftMirrorRepo();
  const audit = new FakeAuditRepo();
  const server = new FakeImapServer();
  server.addFolder({ name: "Drafts", role: "drafts", uidvalidity: 7n });
  const factory = new FakeProviderFactory(server, new FakeSmtpClient());
  const payloadResolver: DraftPayloadResolver = {
    resolve: (_draftId, revision) =>
      Promise.resolve(
        availableRevisions.includes(revision)
          ? { revision, mime: mime(revision) }
          : null,
      ),
  };
  const logger = new JsonLogger({ level: "error", sink: { write: () => {} } });
  const exec = new DraftMirrorExecutor({
    mailboxes,
    mirrors,
    audit,
    providerFactory: factory,
    payloadResolver,
    logger,
    config: { draftsFolder: "Drafts" },
  });
  return { exec, mirrors, server, audit, factory };
}

function job(revision: bigint) {
  return {
    workspaceId: WORKSPACE_ID,
    mailboxId: MAILBOX_ID,
    draftId: DRAFT_ID,
    revision,
  };
}

describe("DraftMirrorExecutor", () => {
  // Test 13: mirrors a draft, records the remote UID + revision (namespaced).
  it("mirrors a draft and records the remote UID + UIDVALIDITY", async () => {
    const h = makeHarness();
    const outcome = await h.exec.execute(job(1n));
    expect(outcome).toBe("mirrored");
    const row = await h.mirrors.getByDraftAndMailbox(DRAFT_ID, MAILBOX_ID);
    expect(row?.mirroredRevision).toBe(1n);
    expect(row?.remoteUid).toBe(1n);
    expect(row?.remoteUidvalidity).toBe(7n); // UID namespaced by UIDVALIDITY
    expect(h.server.folder("Drafts").messages.size).toBe(1);
    // C1 (Phase 3B): mirroring uses an IMAP session ONLY — never a submission.
    expect(h.factory.imapSessionsCreated).toBe(1);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  // Test 14: idempotent on (draftId, revision) — re-running does not duplicate.
  it("is idempotent for the same revision", async () => {
    const h = makeHarness();
    await h.exec.execute(job(1n));
    const outcome = await h.exec.execute(job(1n));
    expect(outcome).toBe("skipped_stale");
    // No second append (idempotent).
    expect(h.server.folder("Drafts").messages.size).toBe(1);
  });

  // Test 15: replace = append-then-retire (new UID; old UID flagged \Deleted).
  it("replaces a draft by append-then-retire", async () => {
    const h = makeHarness();
    await h.exec.execute(job(1n));
    const outcome = await h.exec.execute(job(2n));
    expect(outcome).toBe("mirrored");
    const drafts = h.server.folder("Drafts");
    expect(drafts.messages.size).toBe(2); // both UIDs still present...
    const oldMsg = drafts.messages.get("1");
    expect(oldMsg?.flags.has("\\Deleted")).toBe(true); // ...old one retired
    const row = await h.mirrors.getByDraftAndMailbox(DRAFT_ID, MAILBOX_ID);
    expect(row?.mirroredRevision).toBe(2n);
    expect(row?.remoteUid).toBe(2n);
  });

  // Test 16: a newer local revision is never overwritten by an older queued job.
  it("never overwrites a newer revision with an older job", async () => {
    const h = makeHarness();
    await h.exec.execute(job(3n)); // newer mirrored first
    const outcome = await h.exec.execute(job(2n)); // stale job arrives late
    expect(outcome).toBe("skipped_stale");
    const row = await h.mirrors.getByDraftAndMailbox(DRAFT_ID, MAILBOX_ID);
    expect(row?.mirroredRevision).toBe(3n);
  });

  // Test 17: a missing payload is skipped safely (no uncontrolled duplicate).
  it("skips when the draft payload is unavailable", async () => {
    const h = makeHarness([1n]); // revision 5 not available
    const outcome = await h.exec.execute(job(5n));
    expect(outcome).toBe("skipped_missing_payload");
    expect(h.server.folder("Drafts").messages.size).toBe(0);
  });
});
