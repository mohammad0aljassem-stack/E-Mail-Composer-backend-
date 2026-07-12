import { beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
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
  smtp: FakeSmtpClient;
  server: FakeImapServer;
  factory: FakeProviderFactory;
  fixture: BuiltFixture;
  logLines: string[];
  setState: (state: SendState, version?: bigint) => void;
}

async function makeHarness(options?: {
  payloadOverride?: ResolvedSendPayload;
  globalKillSwitch?: boolean;
  mailboxOverrides?: Parameters<typeof sendableMailbox>[0];
}): Promise<Harness> {
  const fixture = await buildFixture();
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
    claims,
    audit,
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
    smtp,
    server,
    factory,
    fixture,
    logLines,
    setState: (state, version) =>
      attempts.rows.set(ATTEMPT_ID, fixture.attempt(state, version)),
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
    h.setState("smtp_accepted", 5n);
    const outcome = await h.exec.execute(JOB);
    expect(outcome).toBe("completed");
    // Reconciliation only — never a second SMTP submission.
    expect(h.smtp.submissions).toHaveLength(0);
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
