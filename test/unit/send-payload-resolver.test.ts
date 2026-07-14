import { beforeEach, describe, expect, it } from "vitest";
import { recomputeConfirmationProof } from "../../src/domain/confirmation-proof.js";
import {
  SnapshotUnavailableError,
  TransportError,
} from "../../src/domain/errors.js";
import type { SendSnapshotRow } from "../../src/domain/models.js";
import { renderDraftBody } from "../../src/mime/draft-renderer.js";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  SendExecutor,
  type SendExecutorDeps,
} from "../../src/workers/send-executor.js";
import { DraftVersionSendPayloadResolver } from "../../src/workers/send-payload-resolver.js";
import {
  FakeAuditRepo,
  FakeFolderRepo,
  FakeMailboxRepo,
  FakeSendAttemptRepo,
  FakeSendIntentRepo,
  FakeSendSnapshotRepo,
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
 * Phase 3B (contract v2) — DraftVersionSendPayloadResolver. Sends reconstruct
 * the confirmed body from the EXACT snapshot bound to the intent, resolved
 * SOLELY by send_intent_id through the private transport.get_send_snapshot
 * function. The resolver has NO drafts-table dependency at all; every failure
 * fails CLOSED with a content-free reason and zero SMTP bytes.
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

function snapshotRow(
  overrides: Partial<SendSnapshotRow> = {},
): SendSnapshotRow {
  return {
    draftVersionId: "77777777-7777-7777-7777-777777777777",
    workspaceId: WORKSPACE_ID,
    draftId: DRAFT_ID,
    sourceRevision: 1n,
    versionNo: 4n,
    subject: "Test subject",
    bodyJson: SNAPSHOT_DOC,
    ...overrides,
  };
}

interface Harness {
  exec: SendExecutor;
  deps: SendExecutorDeps;
  fixture: BuiltFixture;
  snapshots: FakeSendSnapshotRepo;
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

  // The snapshot is bound to the intent by its id — the sole resolution key.
  const snapshots = new FakeSendSnapshotRepo();
  snapshots.rows.set(INTENT_ID, snapshotRow());

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
      sendSnapshots: snapshots,
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
    snapshots,
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

describe("DraftVersionSendPayloadResolver — exact snapshot resolution", () => {
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

  it("renders EXACTLY the snapshot the function returned for the intent id", async () => {
    const resolver = new DraftVersionSendPayloadResolver({
      sendSnapshots: h.snapshots,
    });
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.revision).toBe(1n);
    expect(payload.message.html).toBe(renderDraftBody(SNAPSHOT_DOC).html);
    expect(payload.message.text).toBe(renderDraftBody(SNAPSHOT_DOC).text);
  });

  it("echoes sender/recipients/subject/Message-ID from the intent (no substitution)", async () => {
    const resolver = new DraftVersionSendPayloadResolver({
      sendSnapshots: h.snapshots,
    });
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.message.sender).toBe(h.fixture.intent.sender);
    expect(payload.message.recipients).toEqual(h.fixture.intent.recipients);
    expect(payload.message.subject).toBe(h.fixture.intent.subject);
    expect(payload.message.messageId).toBe(h.fixture.intent.messageId);
    expect(payload.message.attachments).toEqual([]);
  });

  it("has NO drafts-table dependency — its ONLY dep is the snapshot accessor", async () => {
    // The deps surface is exactly one accessor keyed by send_intent_id: there is
    // no drafts/draft_versions repository to read, and no workspace/draft/
    // revision lookup the worker controls, so a later edit or a near-miss
    // revision can never leak into a send.
    const deps = { sendSnapshots: h.snapshots };
    const resolver = new DraftVersionSendPayloadResolver(deps);
    expect(Object.keys(deps)).toEqual(["sendSnapshots"]);
    const payload = await resolver.resolve(h.fixture.intent);
    expect(payload.message.html).toContain("Confirmed snapshot body");
  });
});

describe("DraftVersionSendPayloadResolver — fail-closed paths", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("get_send_snapshot P0002 (missing/legacy/inconsistent intent) → snapshot_unavailable, zero SMTP", async () => {
    // A uniform P0002 — the worker can never tell whether the intent was
    // missing, legacy (proof-v1 / contract != 2), or bound to an inconsistent
    // snapshot; all collapse to one fail-closed code.
    h.snapshots.rows.clear();
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("snapshot_unavailable");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
    expect((await h.attempts.getById(ATTEMPT_ID))?.state).toBe(
      "failed_before_delivery",
    );
  });

  it("a wrong-workspace/draft/revision intent (P0002 from the function) fails closed identically", async () => {
    // Simulated exactly as the DB does: the private function raises P0002, the
    // repository maps it to SnapshotUnavailableError. The resolver cannot (and
    // does not) distinguish it from a missing intent.
    h.snapshots.failWith = new SnapshotUnavailableError();
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("snapshot_unavailable");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  it("an unreadable accessor (any driver error) also fails closed as snapshot_unavailable", async () => {
    h.snapshots.failWith = new Error("permission denied for function");
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("snapshot_unavailable");
    expect(h.smtp.submissions).toHaveLength(0);
    // The driver error text never reaches evidence.
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

  it("an invalid snapshot body → draft_render_failed", async () => {
    h.snapshots.rows.set(INTENT_ID, snapshotRow({ bodyJson: { type: "x" } }));
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_render_failed");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  it("a snapshot body over the 1 MiB bound → draft_body_bounds_exceeded", async () => {
    h.snapshots.rows.set(
      INTENT_ID,
      snapshotRow({
        bodyJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "z".repeat(1_100_000) }],
            },
          ],
        },
      }),
    );
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(await reasonOf(h)).toBe("draft_body_bounds_exceeded");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  it("resolver failures raise TransportError with content-free context only", async () => {
    h.snapshots.rows.clear();
    const resolver = new DraftVersionSendPayloadResolver({
      sendSnapshots: h.snapshots,
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
