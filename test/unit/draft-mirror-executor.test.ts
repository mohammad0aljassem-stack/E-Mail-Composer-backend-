import { describe, expect, it } from "vitest";
import type { DraftVersionRow } from "../../src/domain/models.js";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  DraftMirrorExecutor,
  type DraftPayloadResolver,
} from "../../src/workers/draft-mirror-executor.js";
import { DraftVersionMirrorPayloadResolver } from "../../src/workers/draft-mirror-payload-resolver.js";
import {
  FakeAuditRepo,
  FakeDraftMirrorRepo,
  FakeDraftVersionRepo,
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
  const smtp = new FakeSmtpClient();
  const factory = new FakeProviderFactory(server, smtp);
  const payloadResolver: DraftPayloadResolver = {
    resolve: (j) =>
      Promise.resolve(
        availableRevisions.includes(j.revision)
          ? { revision: j.revision, mime: mime(j.revision) }
          : null,
      ),
  };
  const logger = new JsonLogger({ level: "error", sink: { write: () => {} } });
  const depsSurface = {
    mailboxes,
    mirrors,
    audit,
    providerFactory: factory,
    payloadResolver,
    logger,
    config: { draftsFolder: "Drafts" },
  };
  const exec = new DraftMirrorExecutor(depsSurface);
  return { exec, mirrors, server, audit, factory, smtp, depsSurface };
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

  // C6: the mirror path has NO way to create a send intent or enqueue a send —
  // its deps surface carries no queue/enqueue/intent writer at all, and the
  // provider counters prove no SMTP channel is ever constructed.
  it("never constructs SMTP and has no send-enqueue dependency surface", async () => {
    const h = makeHarness();
    await h.exec.execute(job(1n));
    expect(h.factory.submissionsCreated).toBe(0);
    expect(h.smtp.submissions).toHaveLength(0);
    const depKeys = Object.keys(h.depsSurface).sort();
    expect(depKeys).toEqual([
      "audit",
      "config",
      "logger",
      "mailboxes",
      "mirrors",
      "payloadResolver",
      "providerFactory",
    ]);
    expect(depKeys.join(",")).not.toMatch(/queue|enqueue|intent|send/i);
  });
});

describe("DraftVersionMirrorPayloadResolver (C6, production resolver)", () => {
  const SNAPSHOT_DOC = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "mirrored draft body" }],
      },
    ],
  };

  function versionRow(
    overrides: Partial<DraftVersionRow> = {},
  ): DraftVersionRow {
    return {
      id: "77777777-7777-7777-7777-777777777777",
      workspaceId: WORKSPACE_ID,
      draftId: DRAFT_ID,
      versionNo: 2n,
      sourceRevision: 3n,
      subject: "Mirrored subject",
      bodyJson: SNAPSHOT_DOC,
      createdAt: new Date("2026-07-02T08:30:00Z"),
      ...overrides,
    };
  }

  function makeResolver(rows: DraftVersionRow[] = [versionRow()]) {
    const versions = new FakeDraftVersionRepo();
    versions.rows.push(...rows);
    const mailboxes = new FakeMailboxRepo();
    mailboxes.rows.set(MAILBOX_ID, sendableMailbox());
    return {
      versions,
      mailboxes,
      resolver: new DraftVersionMirrorPayloadResolver({
        draftVersions: versions,
        mailboxes,
      }),
    };
  }

  it("builds a deterministic MIME from the exact immutable revision", async () => {
    const { resolver } = makeResolver();
    const payload = await resolver.resolve(job(3n));
    expect(payload).not.toBeNull();
    expect(payload!.revision).toBe(3n);
    const raw = payload!.mime.toString("utf8");
    expect(raw).toContain("Subject: Mirrored subject");
    expect(raw).toContain("From: sender@mail.example.com");
    expect(raw).toContain("mirrored draft body");
    // Deterministic, non-routable, revision-scoped Message-ID; pinned Date
    // from the immutable snapshot timestamp → idempotent rebuilds.
    expect(raw).toContain(`Message-ID: <draft-${DRAFT_ID}.r3@mirror.invalid>`);
    expect(raw).toContain("Date: Thu, 02 Jul 2026 08:30:00 +0000");
    const again = await resolver.resolve(job(3n));
    expect(again!.mime.toString("utf8")).toContain(
      "Date: Thu, 02 Jul 2026 08:30:00 +0000",
    );
  });

  it("fails closed (null) when the exact revision snapshot is missing", async () => {
    const { resolver } = makeResolver([versionRow({ sourceRevision: 2n })]);
    expect(await resolver.resolve(job(3n))).toBeNull();
  });

  it("fails closed (null) when the snapshot table is unreadable", async () => {
    const { versions, resolver } = makeResolver();
    versions.failWith = new Error("permission denied");
    expect(await resolver.resolve(job(3n))).toBeNull();
  });

  it("fails closed (null) on an invalid snapshot body or missing mailbox", async () => {
    const invalid = makeResolver([versionRow({ bodyJson: { type: "nope" } })]);
    expect(await invalid.resolver.resolve(job(3n))).toBeNull();

    const { resolver, mailboxes } = makeResolver();
    mailboxes.rows.clear();
    expect(await resolver.resolve(job(3n))).toBeNull();
  });

  it("drives the executor end-to-end: mirrored via IMAP only, zero SMTP", async () => {
    const { resolver } = makeResolver();
    const mailboxes = new FakeMailboxRepo();
    mailboxes.rows.set(MAILBOX_ID, sendableMailbox());
    const mirrors = new FakeDraftMirrorRepo();
    const server = new FakeImapServer();
    server.addFolder({ name: "Drafts", role: "drafts", uidvalidity: 7n });
    const factory = new FakeProviderFactory(server, new FakeSmtpClient());
    const exec = new DraftMirrorExecutor({
      mailboxes,
      mirrors,
      audit: new FakeAuditRepo(),
      providerFactory: factory,
      payloadResolver: resolver,
      logger: new JsonLogger({ level: "error", sink: { write: () => {} } }),
      config: { draftsFolder: "Drafts" },
    });
    expect(await exec.execute(job(3n))).toBe("mirrored");
    const row = await mirrors.getByDraftAndMailbox(DRAFT_ID, MAILBOX_ID);
    expect(row?.mirroredRevision).toBe(3n);
    expect(factory.imapSessionsCreated).toBe(1);
    expect(factory.submissionsCreated).toBe(0);

    // A missing revision fails closed through the executor too.
    expect(await exec.execute(job(9n))).toBe("skipped_missing_payload");
    expect(factory.submissionsCreated).toBe(0);
  });
});
