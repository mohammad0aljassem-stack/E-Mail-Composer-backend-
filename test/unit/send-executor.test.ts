import { beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  buildOutboundMime,
  sha256Hex,
} from "../../src/mime/outbound-builder.js";
import {
  SendExecutor,
  type SendExecutorDeps,
} from "../../src/workers/send-executor.js";
import type {
  ResolvedSendPayload,
  SendPayloadResolver,
} from "../../src/workers/ports.js";
import type { SendState } from "../../src/domain/send-state.js";
import {
  FakeAuditRepo,
  FakeFolderRepo,
  FakeMailboxRepo,
  FakeMimeArtifactRepo,
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
  INTENT_ID,
  MESSAGE_ID,
  sendableMailbox,
  WORKSPACE_ID,
  type BuiltFixture,
} from "../helpers/send-fixtures.js";

interface Harness {
  deps: SendExecutorDeps;
  exec: SendExecutor;
  attempts: FakeSendAttemptRepo;
  audit: FakeAuditRepo;
  claims: FakeWorkerClaimRepo;
  folders: FakeFolderRepo;
  mimeArtifacts: FakeMimeArtifactRepo;
  smtp: FakeSmtpClient;
  server: FakeImapServer;
  factory: FakeProviderFactory;
  fixture: BuiltFixture;
  logLines: string[];
  setState: (state: SendState, version?: bigint) => void;
  /**
   * Seed a retained MIME artifact for the attempt, as if a prior execution had
   * persisted it before SMTP. Builds the exact bytes (pinned date) so the
   * restart/reconciliation path can append the EXACT stored bytes without ever
   * rebuilding MIME. Returns the stored Buffer for byte-identity assertions.
   */
  seedArtifact: () => Promise<Buffer>;
}

const PINNED_MIME_DATE = new Date(1_700_000_000_000);

async function makeHarness(options?: {
  payloadOverride?: ResolvedSendPayload;
  globalKillSwitch?: boolean;
  mailboxOverrides?: Parameters<typeof sendableMailbox>[0];
  fixtureOptions?: Parameters<typeof buildFixture>[0];
}): Promise<Harness> {
  const fixture = await buildFixture(options?.fixtureOptions);
  const mailboxes = new FakeMailboxRepo();
  mailboxes.rows.set(
    fixture.intent.mailboxId,
    sendableMailbox(options?.mailboxOverrides),
  );
  const intents = new FakeSendIntentRepo();
  intents.rows.set(INTENT_ID, fixture.intent);
  const attempts = new FakeSendAttemptRepo();
  attempts.rows.set(ATTEMPT_ID, fixture.attempt("confirmed"));
  const claims = new FakeWorkerClaimRepo();
  const audit = new FakeAuditRepo();
  const folders = new FakeFolderRepo();

  // Phase 6: the exact-MIME artifact store + the two cross-guards that mirror
  // the DB. createOrVerify first-creates only while the attempt is 'claimed'
  // (attemptState reads the live attempt), and the claimed -> smtp_in_progress
  // transition is rejected (23514) unless a valid retained artifact exists
  // (mimeArtifactGuard mirrors trg_send_attempts_require_mime_before_smtp).
  const mimeArtifacts = new FakeMimeArtifactRepo();
  mimeArtifacts.attemptState = (id) => attempts.rows.get(id)?.state ?? null;
  attempts.mimeArtifactGuard = (id) => {
    const art = mimeArtifacts.rows.get(id);
    return art !== undefined && art.rawMime !== null;
  };

  const server = new FakeImapServer();
  server.addFolder({ name: "Sent", role: "sent" });
  const smtp = new FakeSmtpClient();
  const factory = new FakeProviderFactory(server, smtp);

  const payloadResolver: SendPayloadResolver = {
    resolve: () => Promise.resolve(options?.payloadOverride ?? fixture.payload),
  };

  const logLines: string[] = [];
  const logger = new JsonLogger({
    level: "debug",
    sink: { write: (l) => logLines.push(l) },
  });

  const deps: SendExecutorDeps = {
    intents,
    attempts,
    mailboxes,
    folders,
    claims,
    audit,
    mimeArtifacts,
    providerFactory: factory,
    payloadResolver,
    clock: new TestClock(),
    logger,
    config: {
      workerId: "worker-test",
      claimLeaseMs: 60_000,
      globalKillSwitch: options?.globalKillSwitch ?? false,
      sentFolder: "Sent",
    },
  };
  return {
    deps,
    exec: new SendExecutor(deps),
    attempts,
    audit,
    claims,
    folders,
    mimeArtifacts,
    smtp,
    server,
    factory,
    fixture,
    logLines,
    setState: (state, version) =>
      attempts.rows.set(ATTEMPT_ID, fixture.attempt(state, version)),
    seedArtifact: async () => {
      const built = await buildOutboundMime(fixture.message, {
        date: PINNED_MIME_DATE,
      });
      const row = mimeArtifacts.seed({
        sendAttemptId: ATTEMPT_ID,
        sendIntentId: INTENT_ID,
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        rawMime: built.raw,
      });
      return row.rawMime!;
    },
  };
}

const JOB = {
  sendIntentId: INTENT_ID,
  sendAttemptId: ATTEMPT_ID,
  workspaceId: WORKSPACE_ID,
};

describe("SendExecutor — happy path", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  // Test 18: a confirmed intent is delivered exactly once and completes.
  it("delivers and completes", async () => {
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(1);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("completed");
    // C1: exactly ONE submission channel was constructed (after the guards),
    // and the Sent copy went through an IMAP session.
    expect(h.factory.submissionsCreated).toBe(1);
    expect(h.factory.imapSessionsCreated).toBe(1);
  });

  // Test 19: the pre-generated Message-ID is reused for SMTP + Sent copy.
  it("reuses the immutable Message-ID for SMTP and the Sent copy", async () => {
    await h.exec.execute(JOB);
    expect(h.smtp.submissions[0]?.messageId).toBe(MESSAGE_ID);
    // The Sent folder now holds a copy carrying the SAME Message-ID.
    const sentMessages = [...h.server.folder("Sent").messages.values()];
    expect(sentMessages.some((m) => m.messageId === MESSAGE_ID)).toBe(true);
  });

  // Test 20: completed attempts never re-enter the send path (idempotent).
  it("skips a terminal (completed) attempt without re-sending", async () => {
    await h.exec.execute(JOB);
    h.smtp.submissions.length = 0;
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("skipped_terminal");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  // Test 21: exactly-once delivery under a duplicate job (single submission).
  it("does not double-send when invoked twice concurrently-ish", async () => {
    await Promise.all([h.exec.execute(JOB), h.exec.execute(JOB)]);
    expect(h.smtp.submissions.length).toBeLessThanOrEqual(1);
  });
});

describe("SendExecutor — pre-send verification", () => {
  // Test 22: global kill switch aborts without consuming the attempt.
  it("aborts on the global kill switch", async () => {
    const h = await makeHarness({ globalKillSwitch: true });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("aborted_precheck");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("confirmed");
  });

  // Test 23: a disabled mailbox aborts.
  it("aborts when the mailbox is disabled", async () => {
    const h = await makeHarness({ mailboxOverrides: { enabled: false } });
    expect(await h.exec.execute(JOB)).toBe("aborted_precheck");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  // Test 24: a mailbox kill switch aborts.
  it("aborts when the mailbox kill switch is engaged", async () => {
    const h = await makeHarness({ mailboxOverrides: { killSwitch: true } });
    expect(await h.exec.execute(JOB)).toBe("aborted_precheck");
  });

  // Test 25: a tampered confirmation proof → needs_human_review (no send).
  it("routes a tampered confirmation proof to human review", async () => {
    const h = await makeHarness();
    h.fixture.intent.confirmationProof = "f".repeat(64); // wrong but well-formed
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("needs_human_review");
    expect(h.smtp.submissions).toHaveLength(0);
    // C1: integrity verification precedes submission construction.
    expect(h.factory.submissionsCreated).toBe(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("needs_human_review");
  });

  // Test 26: a body-hash mismatch → failed_before_delivery (no send).
  it("fails before delivery on a body hash mismatch", async () => {
    const h = await makeHarness();
    h.fixture.intent.htmlHash = "a".repeat(64);
    // Recompute the proof so ONLY the body hash disagrees with the payload.
    const { recomputeConfirmationProof } =
      await import("../../src/domain/confirmation-proof.js");
    h.fixture.intent.confirmationProof = recomputeConfirmationProof(
      h.fixture.intent,
    );
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe(
      "failed_before_delivery",
    );
  });

  // Test 27: a recipients mismatch → failed_before_delivery.
  it("fails before delivery on a recipients mismatch", async () => {
    const h = await makeHarness();
    h.fixture.intent.recipients = { to: ["someone-else@example.com"] };
    // Recompute proof so ONLY recipients differ from the payload.
    const { recomputeConfirmationProof } =
      await import("../../src/domain/confirmation-proof.js");
    h.fixture.intent.confirmationProof = recomputeConfirmationProof(
      h.fixture.intent,
    );
    expect(await h.exec.execute(JOB)).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
  });

  // Test 28: a draft-revision mismatch → failed_before_delivery.
  it("fails before delivery on a revision mismatch", async () => {
    const h = await makeHarness();
    h.fixture.intent.draftRevision = 999n;
    const { recomputeConfirmationProof } =
      await import("../../src/domain/confirmation-proof.js");
    h.fixture.intent.confirmationProof = recomputeConfirmationProof(
      h.fixture.intent,
    );
    expect(await h.exec.execute(JOB)).toBe("failed_before_delivery");
  });
});

describe("SendExecutor — SMTP failure classification", () => {
  // Test 29: pre-DATA failure → failed_before_delivery, no retry, nothing sent.
  it("classifies a pre-DATA failure as failed_before_delivery", async () => {
    const h = await makeHarness();
    h.smtp.behavior = "pre_data";
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe(
      "failed_before_delivery",
    );
    expect(h.smtp.submissions).toHaveLength(0);
  });

  // Test 32: ambiguous during/after DATA → needs_human_review.
  it("classifies an ambiguous failure as needs_human_review", async () => {
    const h = await makeHarness();
    h.smtp.behavior = "ambiguous";
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("needs_human_review");
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("needs_human_review");
  });

  // Test 33: ambiguous failure preserves the Message-ID + evidence.
  it("preserves Message-ID + evidence on ambiguous failure", async () => {
    const h = await makeHarness();
    h.smtp.behavior = "ambiguous";
    await h.exec.execute(JOB);
    const row = h.attempts.rows.get(ATTEMPT_ID)!;
    expect(row.messageId).toBe(MESSAGE_ID);
    expect(row.evidence.classification).toBe("ambiguous");
    // No confirmed delivery was recorded, and none is auto-enqueued.
    expect(h.smtp.submissions).toHaveLength(0);
  });
});

describe("SendExecutor — restart safety", () => {
  // Test 30: a restart after smtp_accepted does NOT re-send SMTP.
  it("does not re-send after acceptance; only reconciles the Sent copy", async () => {
    const h = await makeHarness();
    await h.seedArtifact(); // the prior execution persisted the exact bytes
    h.setState("smtp_accepted", 5n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    // Reconciliation only — never a second SMTP submission.
    expect(h.smtp.submissions).toHaveLength(0);
    // C1: reconciliation is IMAP-only — no submission channel is even built.
    expect(h.factory.submissionsCreated).toBe(0);
    expect(h.factory.imapSessionsCreated).toBe(1);
  });

  // Test 31: a restart while smtp_in_progress → needs_human_review (no resend).
  it("routes a restart during smtp_in_progress to human review", async () => {
    const h = await makeHarness();
    h.setState("smtp_in_progress", 5n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("needs_human_review");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("needs_human_review");
  });

  // Test 34: a lost claim (another worker holds it) does not send.
  it("does not send when the claim is already held", async () => {
    const h = await makeHarness();
    // Simulate another worker already holding the claim.
    await h.claims.tryClaim({
      sendAttemptId: ATTEMPT_ID,
      workerId: "other",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    // Move to queued so the executor tries to claim.
    h.setState("queued", 1n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("claim_lost");
    expect(h.smtp.submissions).toHaveLength(0);
  });
});

describe("SendExecutor — Sent copy reconciliation", () => {
  // Test 36: Sent-append failure parks in sent_copy_pending (not a resend).
  it("parks in sent_copy_pending when Sent append fails", async () => {
    const h = await makeHarness();
    // Remove the Sent folder so appendSentCopy throws.
    const empty = new FakeImapServer(); // no Sent folder
    h.deps.providerFactory = new FakeProviderFactory(empty, h.smtp);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("sent_copy_pending");
    // Delivery still happened exactly once.
    expect(h.smtp.submissions).toHaveLength(1);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("sent_copy_pending");
  });
});

describe("SendExecutor — authoritative sender at execution (B5)", () => {
  // Sender matches the mailbox address (after normalization) → proceeds + sends.
  it("proceeds when the intent sender matches the mailbox address", async () => {
    const h = await makeHarness();
    // Prove normalization is applied: mixed case + surrounding space still match.
    h.deps.mailboxes = new FakeMailboxRepo();
    (h.deps.mailboxes as FakeMailboxRepo).rows.set(
      h.fixture.intent.mailboxId,
      sendableMailbox({ emailAddress: "  Sender@Mail.Example.com " }),
    );
    h.exec = new SendExecutor(h.deps);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(1);
  });

  // Mismatch → failed_before_delivery BEFORE any SMTP byte, content-free reason.
  it("fails closed before SMTP when the sender does not match the mailbox", async () => {
    const h = await makeHarness({
      mailboxOverrides: { emailAddress: "someone-else@example.com" },
    });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    // ZERO SMTP bytes submitted.
    expect(h.smtp.submissions).toHaveLength(0);
    // C1: the submission channel was never even CONSTRUCTED — the guard runs
    // strictly before createSubmission.
    expect(h.factory.submissionsCreated).toBe(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe(
      "failed_before_delivery",
    );
    // Content-free failure code only.
    expect(h.attempts.rows.get(ATTEMPT_ID)?.evidence.reason).toBe(
      "sender_authority_mismatch",
    );
  });

  // Mismatch is terminal-for-this-attempt: the executor never re-enqueues, and
  // the send queue is retryLimit 0, so there is no auto-retry.
  it("does not auto-retry or re-enqueue on a sender mismatch", async () => {
    const h = await makeHarness({
      mailboxOverrides: { emailAddress: "someone-else@example.com" },
    });
    await h.exec.execute(JOB);
    // A second execution sees a non-terminal failed_before_delivery but STILL
    // never sends (sender is still wrong); no SMTP is ever submitted.
    await h.exec.execute(JOB);
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0); // never constructed either
  });

  // A workspace mismatch on the loaded mailbox also fails closed.
  it("fails closed when the mailbox belongs to a different workspace", async () => {
    const h = await makeHarness({
      mailboxOverrides: { workspaceId: "99999999-9999-9999-9999-999999999999" },
    });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0); // C1: never constructed
    expect(h.attempts.rows.get(ATTEMPT_ID)?.evidence.reason).toBe(
      "sender_authority_workspace_mismatch",
    );
  });
});

describe("SendExecutor — partial RCPT rejection (C1)", () => {
  const partialHarness = () =>
    makeHarness({
      fixtureOptions: {
        recipients: {
          to: [
            "recipient@example.com",
            "second@example.com",
            "third@example.com",
          ],
        },
      },
    });

  it("routes a partial rejection to needs_human_review, never completed", async () => {
    const h = await partialHarness();
    h.smtp.behavior = "partial_reject";
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("needs_human_review");
    const row = h.attempts.rows.get(ATTEMPT_ID)!;
    expect(row.state).toBe("needs_human_review");
    // The message WAS transmitted to the accepted subset: exactly ONE submission.
    expect(h.smtp.submissions).toHaveLength(1);
    expect(row.evidence.reason).toBe("rcpt_partial_rejection");
    expect(row.evidence.accepted_count).toBe(1);
    expect(row.evidence.rejected_count).toBe(2);
  });

  it("never retries or re-enqueues after a partial rejection", async () => {
    const h = await partialHarness();
    h.smtp.behavior = "partial_reject";
    await h.exec.execute(JOB);
    // A duplicate job sees the terminal needs_human_review state: no new SMTP.
    const second = await h.exec.execute(JOB);
    expect(second).toBe("skipped_terminal");
    expect(h.smtp.submissions).toHaveLength(1);
  });

  it("keeps partial-rejection evidence content-free (counts, never addresses)", async () => {
    const h = await partialHarness();
    h.smtp.behavior = "partial_reject";
    await h.exec.execute(JOB);
    const row = h.attempts.rows.get(ATTEMPT_ID)!;
    const evidence = JSON.stringify(row.evidence);
    expect(evidence).not.toContain("example.com");
    expect(evidence).not.toContain("recipient");
    expect(evidence).not.toContain("second");
    expect(evidence).not.toContain("third");
    // The audit detail is equally content-free.
    const review = h.audit.events.find(
      (e) => e.eventType === "send_needs_human_review",
    );
    expect(review).toBeDefined();
    expect(JSON.stringify(review?.detail ?? {})).not.toContain("example.com");
  });

  it("full acceptance of multiple recipients still completes (unchanged)", async () => {
    const h = await partialHarness();
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(1);
    expect(h.smtp.submissions[0]?.envelopeTo).toHaveLength(3);
  });
});

describe("SendExecutor — Sent folder resolved from discovery (C3)", () => {
  it("appends the Sent copy to the discovered localized sent-role folder", async () => {
    const h = await makeHarness();
    h.server.addFolder({ name: "Gesendete Objekte", role: "sent" });
    await h.folders.upsertDiscovered({
      workspaceId: WORKSPACE_ID,
      mailboxId: h.fixture.intent.mailboxId,
      name: "Gesendete Objekte",
      role: "sent",
      uidvalidity: 1n,
      uidnext: 1n,
    });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    const localized = [
      ...h.server.folder("Gesendete Objekte").messages.values(),
    ];
    expect(localized.some((m) => m.messageId === MESSAGE_ID)).toBe(true);
    // Nothing went into the hard-coded default.
    expect(h.server.folder("Sent").messages.size).toBe(0);
  });

  it("falls back to the configured default when no sent-role folder exists", async () => {
    const h = await makeHarness(); // folder repo has NO sent-role row
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    const sent = [...h.server.folder("Sent").messages.values()];
    expect(sent.some((m) => m.messageId === MESSAGE_ID)).toBe(true);
  });
});

describe("SendExecutor — stale-claim recovery is conservative (C7)", () => {
  it("yields claim_lost with zero SMTP for a claimed attempt after lease expiry", async () => {
    const h = await makeHarness();
    // A crashed worker left the attempt in `claimed` with a stale claim row.
    h.setState("claimed", 3n);
    await h.claims.tryClaim({
      sendAttemptId: ATTEMPT_ID,
      workerId: "crashed-worker",
      leaseUntil: new Date(Date.now() - 60_000), // already expired
    });
    const expired = await h.claims.expireStale(new Date());
    expect(expired).toBe(1);
    // The normal path never resumes delivery from `claimed`: the attempt must
    // be re-driven through its ordinary claim + state flow. No silent send.
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("claim_lost");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("claimed");
  });
});

describe("SendExecutor — re-entry pins (T2/T3/T4)", () => {
  it("T2: needs_human_review is terminal — re-entry is skipped with 0 submissions", async () => {
    const h = await makeHarness();
    h.setState("needs_human_review", 7n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("skipped_terminal");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.state).toBe("needs_human_review");
  });

  it("T3: sent_copy_pending re-entry completes via Sent copy, 0 SMTP submissions", async () => {
    const h = await makeHarness();
    await h.seedArtifact();
    h.setState("sent_copy_pending", 6n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0); // C1: IMAP-only re-entry
    const sent = [...h.server.folder("Sent").messages.values()];
    expect(sent.filter((m) => m.messageId === MESSAGE_ID)).toHaveLength(1);
  });

  it("T4: Sent-copy dedup — an existing Message-ID is never appended twice", async () => {
    const h = await makeHarness();
    h.server.seedMessage("Sent", { messageId: MESSAGE_ID });
    h.setState("smtp_accepted", 5n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(0);
    const copies = [...h.server.folder("Sent").messages.values()].filter(
      (m) => m.messageId === MESSAGE_ID,
    );
    expect(copies).toHaveLength(1);
  });
});

describe("SendExecutor — attachment-manifest mismatch (T5)", () => {
  it("fails before delivery when the payload carries an undeclared attachment", async () => {
    const h = await makeHarness();
    h.deps.payloadResolver = {
      resolve: () =>
        Promise.resolve({
          revision: h.fixture.payload.revision,
          message: {
            ...h.fixture.message,
            attachments: [
              {
                filename: "undeclared.bin",
                contentType: "application/octet-stream",
                content: Buffer.from("not in the confirmed manifest"),
              },
            ],
          },
        }),
    };
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.evidence.reason).toBe(
      "attachment_manifest_mismatch",
    );
  });
});

describe("SendExecutor — audit-event assertions (T6)", () => {
  it("happy path emits started -> accepted -> completed, all content-free", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    const types = h.audit.events.map((e) => e.eventType);
    const started = types.indexOf("smtp_send_started");
    const acceptedIdx = types.indexOf("smtp_accepted");
    const completedIdx = types.indexOf("send_completed");
    expect(started).toBeGreaterThan(-1);
    expect(acceptedIdx).toBeGreaterThan(started);
    expect(completedIdx).toBeGreaterThan(acceptedIdx);
    // No event or detail carries body text or a recipient address.
    const serialized = JSON.stringify(h.audit.events);
    expect(serialized).not.toContain("Hello");
    expect(serialized).not.toContain("<p>");
    expect(serialized).not.toContain("recipient@example.com");
  });

  it("ambiguous path emits send_needs_human_review", async () => {
    const h = await makeHarness();
    h.smtp.behavior = "ambiguous";
    await h.exec.execute(JOB);
    expect(
      h.audit.events.some((e) => e.eventType === "send_needs_human_review"),
    ).toBe(true);
    expect(JSON.stringify(h.audit.events)).not.toContain(
      "recipient@example.com",
    );
  });
});

describe("SendExecutor — build once, reuse exact bytes (C5)", () => {
  const PINNED_MS = 1_700_000_000_000; // TestClock start
  const pinnedUtc = new Date(PINNED_MS).toUTCString();
  const pinnedHeader = `Date: ${pinnedUtc.replace("GMT", "+0000")}`;

  it("the appended Sent copy is byte-identical to the SMTP submission", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    expect(h.smtp.submissions).toHaveLength(1);
    const submitted = h.smtp.submissions[0]!.raw;
    const sent = [...h.server.folder("Sent").messages.values()].find(
      (m) => m.messageId === MESSAGE_ID,
    );
    expect(sent?.raw).not.toBeNull();
    // ONE build per execution: submitted raw === appended raw, byte for byte.
    expect(sent!.raw!.equals(submitted)).toBe(true);
  });

  it("persists the pinned MIME date content-free in evidence at build time", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    const row = h.attempts.rows.get(ATTEMPT_ID)!;
    expect(row.evidence.mime_date).toBe(pinnedUtc);
    // The submitted Date header carries exactly the persisted date.
    expect(h.smtp.submissions[0]!.raw.toString("utf8")).toContain(pinnedHeader);
  });

  it("restart reconcile appends the EXACT stored artifact bytes, never rebuilds", async () => {
    const h = await makeHarness();
    const stored = await h.seedArtifact();
    h.setState("smtp_accepted", 5n);
    // A rebuild is impossible without re-resolving the payload; assert it is
    // never called (proxy for buildOutboundMime never running on restart).
    let resolves = 0;
    h.deps.payloadResolver = {
      resolve: () => {
        resolves += 1;
        return Promise.resolve(h.fixture.payload);
      },
    };
    h.exec = new SendExecutor(h.deps);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(0); // never SMTP again
    expect(resolves).toBe(0); // never re-resolved => never rebuilt
    const sent = [...h.server.folder("Sent").messages.values()].find(
      (m) => m.messageId === MESSAGE_ID,
    );
    // Sent-bytes === artifact-bytes, byte for byte.
    expect(sent?.raw?.equals(stored)).toBe(true);
  });

  it("reconcile with an existing Sent copy never loads or rebuilds bytes", async () => {
    const h = await makeHarness();
    await h.seedArtifact();
    h.server.seedMessage("Sent", { messageId: MESSAGE_ID });
    h.setState("smtp_accepted", 5n);
    let resolves = 0;
    h.deps.payloadResolver = {
      resolve: () => {
        resolves += 1;
        return Promise.resolve(h.fixture.payload);
      },
    };
    h.exec = new SendExecutor(h.deps);
    expect(await h.exec.execute(JOB)).toBe("completed");
    // findByMessageId runs FIRST; the stored bytes are only loaded when an
    // append is actually needed — here it never is.
    expect(resolves).toBe(0);
  });

  it("parks sent_copy_pending when no stored artifact is available on restart", async () => {
    const h = await makeHarness();
    // No artifact was persisted (or it was lost): the restart path must NEVER
    // rebuild and NEVER re-enter SMTP — it fails closed to sent_copy_pending.
    h.setState("smtp_accepted", 5n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("sent_copy_pending");
    expect(h.server.folder("Sent").messages.size).toBe(0);
    expect(h.smtp.submissions).toHaveLength(0);
  });
});

describe("SendExecutor — exact MIME artifact persistence (Phase 6)", () => {
  // The artifact is persisted (createOrVerify) BEFORE the claimed ->
  // smtp_in_progress transition, so the exact bytes exist before any SMTP byte.
  it("persists the artifact BEFORE the smtp_in_progress transition", async () => {
    const h = await makeHarness();
    const order: string[] = [];
    const origCreate = h.mimeArtifacts.createOrVerify.bind(h.mimeArtifacts);
    h.mimeArtifacts.createOrVerify = (input) => {
      order.push("createOrVerify");
      return origCreate(input);
    };
    const origCas = h.attempts.compareAndSet.bind(h.attempts);
    h.attempts.compareAndSet = (input) => {
      if (input.toState === "smtp_in_progress") order.push("smtp_in_progress");
      return origCas(input);
    };
    h.exec = new SendExecutor(h.deps);
    expect(await h.exec.execute(JOB)).toBe("completed");
    expect(order.indexOf("createOrVerify")).toBeGreaterThan(-1);
    expect(order.indexOf("createOrVerify")).toBeLessThan(
      order.indexOf("smtp_in_progress"),
    );
    expect(h.mimeArtifacts.createOrVerifyCalls).toBe(1);
  });

  // The DB ordering guard (trg_send_attempts_require_mime_before_smtp) rejects a
  // claimed -> smtp_in_progress transition with no valid retained artifact.
  it("the fake attempt store rejects claimed -> smtp_in_progress without an artifact (23514)", async () => {
    const attempts = new FakeSendAttemptRepo();
    attempts.mimeArtifactGuard = () => false; // no valid retained artifact
    attempts.rows.set(ATTEMPT_ID, {
      id: ATTEMPT_ID,
      workspaceId: WORKSPACE_ID,
      sendIntentId: INTENT_ID,
      state: "claimed",
      claimedBy: "w",
      claimedAt: new Date(),
      messageId: MESSAGE_ID,
      smtpResponse: null,
      evidence: {},
      version: 3n,
    });
    await expect(
      attempts.compareAndSet({
        id: ATTEMPT_ID,
        expectedVersion: 3n,
        expectedState: "claimed",
        toState: "smtp_in_progress",
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  // Executor maps that guard 23514 to failed_before_delivery with ZERO SMTP.
  it("fails closed (zero SMTP) when the ordering guard rejects the transition", async () => {
    const h = await makeHarness();
    h.attempts.mimeArtifactGuard = () => false; // guard rejects at the boundary
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.attempts.rows.get(ATTEMPT_ID)?.evidence.reason).toBe(
      "mime_artifact_missing_before_smtp",
    );
  });

  // The EXACT bytes submitted to SMTP === the persisted artifact bytes.
  it("submits the EXACT persisted artifact bytes to SMTP (byte compare)", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    const submitted = h.smtp.submissions[0]!.raw;
    const artifact = h.mimeArtifacts.rows.get(ATTEMPT_ID)!;
    expect(artifact.rawMime).not.toBeNull();
    expect(submitted.equals(artifact.rawMime!)).toBe(true);
  });

  // The EXACT bytes appended to Sent === the persisted artifact bytes.
  it("appends the EXACT persisted artifact bytes to Sent (byte compare)", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    const artifact = h.mimeArtifacts.rows.get(ATTEMPT_ID)!;
    const sent = [...h.server.folder("Sent").messages.values()].find(
      (m) => m.messageId === MESSAGE_ID,
    );
    expect(sent?.raw?.equals(artifact.rawMime!)).toBe(true);
  });

  // Forged / divergent artifact bytes → create-or-verify rejects (uniform
  // 23514) → failed_before_delivery, ZERO SMTP, submission never constructed.
  it("fails closed with zero SMTP when the persisted artifact diverges (forged bytes)", async () => {
    const h = await makeHarness();
    h.mimeArtifacts.seed({
      sendAttemptId: ATTEMPT_ID,
      sendIntentId: INTENT_ID,
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      rawMime: Buffer.from(
        "forged divergent bytes not matching the built MIME",
      ),
    });
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("failed_before_delivery");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0); // never even constructed
    expect(h.attempts.rows.get(ATTEMPT_ID)?.evidence.reason).toBe(
      "mime_artifact_rejected",
    );
  });

  // A restart (smtp_accepted, artifact present) uses the STORED bytes and does
  // NOT re-resolve/rebuild MIME and does NOT submit SMTP again.
  it("restart uses stored bytes, never rebuilds, never re-submits SMTP", async () => {
    const h = await makeHarness();
    const stored = await h.seedArtifact();
    h.setState("smtp_accepted", 5n);
    let resolves = 0;
    h.deps.payloadResolver = {
      resolve: () => {
        resolves += 1;
        return Promise.resolve(h.fixture.payload);
      },
    };
    h.exec = new SendExecutor(h.deps);
    expect(await h.exec.execute(JOB)).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(resolves).toBe(0);
    const sent = [...h.server.folder("Sent").messages.values()].find(
      (m) => m.messageId === MESSAGE_ID,
    );
    expect(sent?.raw?.equals(stored)).toBe(true);
  });

  // No SMTP resend from sent_copy_pending — reconcile only, using stored bytes.
  it("reconciles sent_copy_pending from stored bytes with zero SMTP", async () => {
    const h = await makeHarness();
    await h.seedArtifact();
    h.setState("sent_copy_pending", 6n);
    expect(await h.exec.execute(JOB)).toBe("completed");
    expect(h.smtp.submissions).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  // create-or-verify is idempotent: an identical replay returns the same row.
  it("createOrVerify is idempotent — identical replay returns the same artifact", async () => {
    const repo = new FakeMimeArtifactRepo();
    repo.attemptState = () => "claimed";
    const raw = Buffer.from("exact mime bytes for idempotency");
    const input = {
      sendAttemptId: ATTEMPT_ID,
      sendIntentId: INTENT_ID,
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      mimeSha256: sha256Hex(raw),
      sizeBytes: BigInt(raw.length),
      rawMime: raw,
    };
    const first = await repo.createOrVerify(input);
    const second = await repo.createOrVerify(input);
    expect(second.id).toBe(first.id);
    expect(second.mimeSha256).toBe(first.mimeSha256);
    expect(repo.createOrVerifyCalls).toBe(2);
  });

  // A first-create while the attempt is NOT 'claimed' is rejected (state gate).
  it("createOrVerify refuses a first-create unless the attempt is claimed", async () => {
    const repo = new FakeMimeArtifactRepo();
    repo.attemptState = () => "queued"; // not claimed
    const raw = Buffer.from("bytes");
    await expect(
      repo.createOrVerify({
        sendAttemptId: ATTEMPT_ID,
        sendIntentId: INTENT_ID,
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        mimeSha256: sha256Hex(raw),
        sizeBytes: BigInt(raw.length),
        rawMime: raw,
      }),
    ).rejects.toMatchObject({ code: "mime_artifact_rejected" });
  });
});

// Test 37: end-to-end, no body/credential/attachment bytes appear in logs.
describe("SendExecutor — content-free logging", () => {
  it("never logs body/credential/attachment content", async () => {
    const h = await makeHarness();
    await h.exec.execute(JOB);
    const joined = h.logLines.join("\n");
    expect(joined).not.toContain("Hello"); // body text
    expect(joined).not.toContain("<p>Hello</p>"); // body html
    expect(joined).not.toContain("recipient@example.com"); // recipient PII in bodies
    // It DOES contain the content-free Message-ID and state labels.
    expect(joined).toContain("send_completed");
  });
});
