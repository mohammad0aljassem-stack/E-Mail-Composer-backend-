import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  singletonKeys,
} from "../../src/queues/queue-config.js";
import { SendExecutor } from "../../src/workers/send-executor.js";

/**
 * B6 — send-safety regression gates, asserted against the REAL queue config
 * (not a mock), plus B4 — a static proof that the sender-authority guard runs
 * before any SMTP submission on the single production send entry point.
 */

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("B6 — send_message has zero retry behavior (real QUEUE_DEFINITIONS)", () => {
  const send = QUEUE_DEFINITIONS[QUEUE_NAMES.sendMessage];

  it("retryLimit is exactly 0 and backoff is disabled", () => {
    expect(send.retryLimit).toBe(0);
    expect(send.retryBackoff).toBe(false);
    expect(send.retryDelay).toBe(0);
  });

  it("FAILS if send_message ever acquires a positive retry limit", () => {
    // Guards against a future edit reintroducing queue-level retries on delivery.
    expect(send.retryLimit ?? 0).not.toBeGreaterThan(0);
  });

  it("the send singleton key is deterministic in the immutable intent id", () => {
    expect(singletonKeys.sendMessage("intent-abc")).toBe("send:intent-abc");
    expect(singletonKeys.sendMessage("intent-abc")).toBe(
      singletonKeys.sendMessage("intent-abc"),
    );
  });
});

describe("B4 — the sender-authority guard precedes SMTP on the send path", () => {
  // The import above proves the module resolves; the ordering proof below reads
  // the authored .ts source.
  const ts = readSrc("../../src/workers/send-executor.ts");

  it("has exactly one SMTP submission site (submission.sendMessage)", () => {
    const matches = ts.match(/\bsubmission\.sendMessage\s*\(/g) ?? [];
    expect(matches.length).toBe(1);
    // And exactly one submission-channel CONSTRUCTION site (C1): the send
    // executor is the only caller of createSubmission; reconciliation and the
    // Sent append use createImapSession only.
    const constructed = ts.match(/\.createSubmission\s*\(/g) ?? [];
    expect(constructed.length).toBe(1);
  });

  it("runs checkSenderAuthority BEFORE creating the submission and before deliver()", () => {
    const guard = ts.indexOf("this.checkSenderAuthority(");
    const create = ts.indexOf(
      "this.deps.providerFactory.createSubmission(mailbox)",
    );
    const deliver = ts.indexOf("return await this.deliver(");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(-1);
    // Guard call site precedes submission construction, which precedes delivery.
    expect(guard).toBeLessThan(create);
    expect(create).toBeLessThan(deliver);
  });

  it("normalizes sender + mailbox with trim + lowercase and is content-free", () => {
    const fn = /private checkSenderAuthority\([\s\S]*?\n {2}\}/.exec(ts);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/trim\(\)\.toLowerCase\(\)/);
    // Returns only a short reason code, never the sender/mailbox value.
    expect(fn![0]).toMatch(/sender_authority_mismatch/);
    expect(fn![0]).toMatch(/sender_authority_workspace_mismatch/);
  });

  it("the send executor module resolves (guards against a broken refactor)", () => {
    expect(typeof SendExecutor).toBe("function");
  });
});

describe("Phase 6 — exact MIME artifact safety invariants (static)", () => {
  const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

  function walkSrc(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walkSrc(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("the worker NEVER issues a direct INSERT into transport.send_mime_artifacts", () => {
    const files = walkSrc(srcDir);
    const rx = /insert\s+into\s+transport\.send_mime_artifacts/i;
    const offenders = files.filter((f) => rx.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("artifact creation goes ONLY through create_or_verify_send_mime_artifact", () => {
    const repos = readSrc("../../src/db/repositories.ts");
    // The repository's sole write path is the SECURITY DEFINER function.
    expect(repos).toMatch(/transport\.create_or_verify_send_mime_artifact/);
    // And it never INSERTs the table directly.
    expect(repos).not.toMatch(
      /insert\s+into\s+transport\.send_mime_artifacts/i,
    );
  });

  it("reconcileSentCopy uses stored bytes and NEVER rebuilds MIME on restart", () => {
    const ts = readSrc("../../src/workers/send-executor.ts");
    const fn =
      /private async reconcileSentCopy\([\s\S]*?\n {2}\}\n\n {2}\/\//.exec(ts);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // No MIME rebuild after acceptance — it loads the exact stored artifact.
    expect(body).not.toMatch(/buildOutboundMime/);
    expect(body).toMatch(/getBySendAttempt/);
    // And it never constructs a submission (reconciliation is IMAP-only).
    expect(body).not.toMatch(/createSubmission/);
  });

  it("the artifact is persisted BEFORE the smtp_in_progress transition site", () => {
    const ts = readSrc("../../src/workers/send-executor.ts");
    const create = ts.indexOf("this.deps.mimeArtifacts.createOrVerify(");
    const submit = ts.indexOf("submission.sendMessage(");
    expect(create).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    // Persistence precedes the single SMTP submission site.
    expect(create).toBeLessThan(submit);
  });
});
