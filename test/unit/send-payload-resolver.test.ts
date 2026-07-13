import { beforeEach, describe, expect, it } from "vitest";
import { recomputeConfirmationProof } from "../../src/domain/confirmation-proof.js";
import { TransportError } from "../../src/domain/errors.js";
import type { DraftVersionRow } from "../../src/domain/models.js";
import { renderDraftBody } from "../../src/mime/draft-renderer.js";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  SendExecutor,
  type SendExecutorDeps,
} from "../../src/workers/send-executor.js";
import { DraftVersionSendPayloadResolver } from "../../src/workers/send-payload-resolver.js";
import {
  FakeAuditRepo,
  FakeDraftVersionRepo,
  FakeFolderRepo,
  FakeMailboxRepo,
  FakeSendAttemptRepo,
  FakeSendIntentRepo,
  FakeWorkerClaimRepo,
} from "../fakes/in-memory-repos.js";
import { FakeImapServer } from "../fakes/fake-imap.js";
import { FakeSmtpClient } from "../fakes/fake-smtp.js";
import { FakeProviderFactory } from "../fakes/fake-provider-factory.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  ATTEMPT_ID,
  buildFixture,
  DRAFT_ID,
  INTENT_ID,
  sendableMailbox,
  WORKSPACE_ID,
  type BuiltFixture,
} from "../helpers/send-fixtures.js";

/**
 * Phase 3B C4 — DraftVersionSendPayloadResolver. Sends reconstruct the
 * confirmed body from the IMMUTABLE draft_versions snapshot (exact
 * source_revision) and the deterministic renderer; every failure fails CLOSED
 * with a content-free reason and zero SMTP bytes.
 */

const SNAPSHOT_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Confirmed snapshot body" }],
    },
  ],
};

function versionRow(overrides: Partial<DraftVersionRow> = {}): DraftVersionRow {
  return {
    id: "77777777-7777-7777-7777-777777777777",
    workspaceId: WORKSPACE_ID,
    draftId: DRAFT_ID,
    versionNo: 4n,
    sourceRevision: 1n,
    subject: "Test subject",
    bodyJson: SNAPSHOT_DOC,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

interface Harness {
  exec: SendExecutor;
  deps: SendExecutorDeps;
  fixture: BuiltFixture;
  versions: FakeDraftVersionRepo;
  attempts: FakeSendAttemptRepo;
  smtp: FakeSmtpClient;
  factory: FakeProviderFactory;
}

/** Full send-executor harness whose payload resolver is the REAL one. */
async function makeHarness(): Promise<Harness> {
  // The intent's hashes are derived from the worker renderer's output for the
  // snapshot doc — i.e. the UI confirmed exactly what this snapshot renders to.
  const rendered = renderDraftBody(SNAPSHOT_DOC);
  const fixture = await buildFixture({
    html: rendered.html,
    text: rendered.text,
  });

  const versions = new FakeDraftVersionRepo();
  versions.rows.push(versionRow());

  const mailboxes = new FakeMailboxRepo();
  mailboxes.rows.set(fixture.intent.mailboxId, sendableMailbox());
  const intents = new FakeSendIntentRepo();
  intents.rows.set(INTENT_ID, fixture.intent);
  const attempts = new FakeSendAttemptRepo();
  attempts.rows.set(ATTEMPT_ID, fixture.attempt("confirmed"));

  const server = new FakeImapServer();
  server.addFolder({ name: "Sent", role: "sent" });
  const smtp = new FakeSmtpClient();
  const factory = new FakeProviderFactory(server, smtp);

  const deps: SendExecutorDeps = {
    intents,
    attempts,
    mailboxes,
    folders: new FakeFolderRepo(),
    claims: new FakeWorkerClaimRepo(),
    audit: new FakeAuditRepo(),
    providerFactory: factory,
    payloadResolver: new DraftVersionSendPayloadResolver({
      draftVersions: versions,
    }),
    clock: new TestClock(),
    logger: new JsonLogger({ level: "error", sink: { write: () => {} } }),
    config: {
      workerId: "worker-test",
      claimLeaseMs: 60_000,
      globalKillSwitch: false,
      sentFolder: "Sent",
    },
  };
  return {
    exec: new SendExecutor(deps),
    deps,
    fixture,
    versions,
    attempts,
    smtp,
    factory,
  };
}

const JOB = {
  sendIntentId: INTENT_ID,
  sendAttemptId: ATTEMPT_ID,
  workspaceId: WORKSPACE_ID,
};

async function reasonOf(h: Harness): Promise<unknown> {
  return (await h.attempts.getById(ATTEMPT_ID))?.evidence.reason;
}

describe("DraftVersionSendPayloadResolver — exact-revision resolution", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("happy path: rendered hashes match the intent → delivered exactly once", async () => {
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(1);
    expect(h.factory.submissionsCreated).toBe(1);
    expect((await h.attempts.getById(ATTEMPT_ID))?.state).toBe("completed");
  });

  it("picks the HIGHEST version_no among snapshots of the same source_revision", async () => {
    // An older checkpoint of the same revision with a different body: the
    // resolver must prefer version_no 4 (the canonical latest snapshot).
    h.versions.rows.push(
      versionRow({
        id: "88888888-8888-8888-8888-888888888888",
        versionNo: 2n,
        bodyJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "older checkpoint" }],
            },
          ],
        },
      }),
    );
    const resolver = new DraftVersionSendPayloadResolver({
      draftVersions: h.versions,
    });
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.revision).toBe(1n);
    expect(payload.message.html).toBe(renderDraftBody(SNAPSHOT_DOC).html);
    expect(payload.message.text).toBe(renderDraftBody(SNAPSHOT_DOC).text);
  });

  it("echoes sender/recipients/subject/Message-ID from the intent (no substitution)", async () => {
    const resolver = new DraftVersionSendPayloadResolver({
      draftVersions: h.versions,
    });
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.message.sender).toBe(h.fixture.intent.sender);
    expect(payload.message.recipients).toEqual(h.fixture.intent.recipients);
    expect(payload.message.subject).toBe(h.fixture.intent.subject);
    expect(payload.message.messageId).toBe(h.fixture.intent.messageId);
    expect(payload.message.attachments).toEqual([]);
  });

  it("ignores the mutable draft entirely — the resolver has NO drafts dependency", async () => {
    // The deps surface is exactly one SELECT-only snapshot reader: there is no
    // drafts repository to read, so a later edit can never leak into a send.
    const deps = { draftVersions: h.versions };
    const resolver = new DraftVersionSendPayloadResolver(deps);
    expect(Object.keys(deps)).toEqual(["draftVersions"]);
    // Even if the "current" draft changed to revision 9, the intent's revision
    // 1 snapshot is what resolves.
    h.versions.rows.push(
      versionRow({
        id: "99999999-9999-9999-9999-999999999999",
        versionNo: 9n,
        sourceRevision: 9n,
        bodyJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "newer unconfirmed edit" }],
            },
          ],
        },
      }),
    );
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.message.html).toContain("Confirmed snapshot body");
    expect(payload.message.html).not.toContain("newer unconfirmed edit");
  });
});

describe("DraftVersionSendPayloadResolver — fail-closed paths", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("missing exact-revision snapshot → failed_before_delivery, zero SMTP", async () => {
    h.versions.rows.length = 0; // no snapshot for the confirmed revision
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_revision_snapshot_missing");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
    expect((await h.attempts.getById(ATTEMPT_ID))?.state).toBe(
      "failed_before_delivery",
    );
  });

  it("a NEAR-MISS revision is never substituted (source_revision must be exact)", async () => {
    h.versions.rows.length = 0;
    h.versions.rows.push(versionRow({ sourceRevision: 2n })); // off by one
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_revision_snapshot_missing");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  it("unreadable snapshot table (no SELECT privilege) → draft_version_unreadable", async () => {
    h.versions.failWith = new Error(
      "permission denied for table draft_versions",
    );
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_version_unreadable");
    expect(h.smtp.submissions).toHaveLength(0);
    // The driver error text (which names the table) never reaches evidence.
    const evidence = JSON.stringify(
      (await h.attempts.getById(ATTEMPT_ID))?.evidence,
    );
    expect(evidence).not.toContain("permission denied");
  });

  it("non-empty attachment manifest → attachments_unsupported, no SMTP", async () => {
    h.fixture.intent.attachmentManifest = [
      {
        filename: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        sha256: "b".repeat(64),
      },
    ];
    h.fixture.intent.confirmationProof = recomputeConfirmationProof(
      h.fixture.intent,
    );
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("attachments_unsupported");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  it("a cross-scope row from a misbehaving reader is rejected (assert)", async () => {
    const resolver = new DraftVersionSendPayloadResolver({
      draftVersions: {
        findDraftVersion: () =>
          Promise.resolve(
            versionRow({
              workspaceId: "99999999-9999-9999-9999-999999999999",
            }),
          ),
      },
    });
    await expect(resolver.resolve(h.fixture.intent)).rejects.toMatchObject({
      context: { reason: "draft_version_scope_mismatch" },
    });
  });

  it("an invalid snapshot body → draft_render_failed", async () => {
    h.versions.rows[0] = versionRow({ bodyJson: { type: "not-a-doc" } });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_render_failed");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  it("a snapshot body over the 1 MiB bound → draft_body_bounds_exceeded", async () => {
    h.versions.rows[0] = versionRow({
      bodyJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "z".repeat(1_100_000) }],
          },
        ],
      },
    });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_body_bounds_exceeded");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  it("resolver failures raise TransportError with content-free context only", async () => {
    h.versions.rows.length = 0;
    const resolver = new DraftVersionSendPayloadResolver({
      draftVersions: h.versions,
    });
    try {
      await resolver.resolve(h.fixture.intent);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      const e = err as TransportError;
      expect(e.code).toBe("send_precondition_failed");
      expect(e.retryable).toBe(false); // non-retryable, always
      expect(JSON.stringify(e.context)).not.toContain("Confirmed snapshot");
    }
  });
});

describe("DraftVersionSendPayloadResolver — the executor hash gate stays intact", () => {
  it("a tampered intent html_hash still fails closed AFTER resolution (no SMTP)", async () => {
    const h = await makeHarness();
    h.fixture.intent.htmlHash = "a".repeat(64);
    // Recompute the proof so ONLY the body hash disagrees with the render.
    h.fixture.intent.confirmationProof = recomputeConfirmationProof(
      h.fixture.intent,
    );
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("html_hash_mismatch");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  it("renderer divergence can only FAIL the send, never change its content", async () => {
    // Simulate divergence: the UI confirmed different bytes than the worker
    // renderer produces for this snapshot (hashes computed over other html).
    const h = await makeHarness();
    const divergent = await buildFixture({
      html: "<p>what the UI rendered</p>",
      text: "what the UI rendered",
    });
    h.deps.intents = new FakeSendIntentRepo();
    (h.deps.intents as FakeSendIntentRepo).rows.set(
      INTENT_ID,
      divergent.intent,
    );
    h.exec = new SendExecutor(h.deps);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
  });
});
