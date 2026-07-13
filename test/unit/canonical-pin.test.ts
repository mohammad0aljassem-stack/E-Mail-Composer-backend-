import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Canonical-pin guards (B1/B2). These assert — deterministically, with no DB —
 * that the backend is pinned to the FINAL merged UI schema SHA and verifies ALL
 * THREE Phase 3 migration checksums fail-closed, and that the test-only
 * privilege workaround (an injected GRANT EXECUTE to transport_worker) is gone.
 */

const UI_SHA = "422485af44fa4606a7c0dbee798a9866b3fd0d8e";
const OLD_SHA = "67daad9";
const FOUNDATION_SHA =
  "a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a";
const HARDENING_SHA =
  "ee064f0b50d01897b8247a10edefc95bd0088862e3731693b19da7c851253977";
const GRANT_SHA =
  "ca15b9de01894ef784fad57f991a052e2da1fcdca435cc1a78463af34b3c0dba";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("canonical pin — CI workflow", () => {
  const ci = read("../../.github/workflows/ci.yml");

  it("pins the FULL 40-char final UI SHA (checkout cannot fetch an abbrev ref)", () => {
    expect(ci).toContain(`UI_REPO_REF: "${UI_SHA}"`);
  });

  it("declares all three Phase 3 checksums", () => {
    expect(ci).toContain(FOUNDATION_SHA);
    expect(ci).toContain(HARDENING_SHA);
    expect(ci).toContain(GRANT_SHA);
  });

  it("verifies the checked-out UI SHA and every checksum fail-closed", () => {
    expect(ci).toMatch(/git -C ui-schema rev-parse HEAD/);
    expect(ci).toContain("20260713100000_transport_foundation.sql");
    expect(ci).toContain("20260714100000_transport_contract_hardening.sql");
    expect(ci).toContain("20260715100000_worker_transition_grant.sql");
    // exit 1 on any mismatch (fail closed).
    expect(ci).toMatch(/mismatch[\s\S]*exit 1/);
  });

  it("carries no reference to the superseded UI SHA", () => {
    expect(ci).not.toContain(OLD_SHA);
  });
});

describe("canonical pin — test-db.sh", () => {
  const sh = read("../../scripts/test-db.sh");

  it("pins the final UI SHA and all three Phase 3 checksums", () => {
    expect(sh).toContain(UI_SHA);
    expect(sh).toContain(FOUNDATION_SHA);
    expect(sh).toContain(HARDENING_SHA);
    expect(sh).toContain(GRANT_SHA);
  });

  it("loads the FULL five-migration chain (baseline + 5)", () => {
    for (const f of [
      "production_schema_2026_07_11.sql",
      "20260711130000_draft_lifecycle.sql",
      "20260712100000_enforce_phase2_rpc_invariants.sql",
      "20260713100000_transport_foundation.sql",
      "20260714100000_transport_contract_hardening.sql",
      "20260715100000_worker_transition_grant.sql",
    ]) {
      expect(sh).toContain(f);
    }
  });

  it("fails closed on a SHA / checksum / missing-migration mismatch", () => {
    expect(sh).toMatch(/rev-parse HEAD/);
    expect(sh).toMatch(/checksum mismatch/);
    expect(sh).toMatch(/required schema file missing/);
    // The grant migration is part of the required set, so PR#4-only loads fail.
    expect(sh).toContain("MIG_GRANT");
    expect(sh).toContain("MIG_HARDENING");
  });

  it("does NOT inject the test-only EXECUTE grant (B2 removed)", () => {
    // No GRANT EXECUTE on the transition validator to transport_worker anywhere.
    const injected =
      /grant\s+execute\s+on\s+function\s+public\.phase3_send_attempt_transition_ok[\s\S]*?transport_worker/i;
    expect(sh).not.toMatch(injected);
  });

  it("carries no reference to the superseded UI SHA", () => {
    expect(sh).not.toContain(OLD_SHA);
  });
});

describe("canonical pin — docs", () => {
  it("README, notices, and non-deployment doc are re-pinned (no old SHA)", () => {
    for (const rel of [
      "../../README.md",
      "../../THIRD_PARTY_NOTICES.md",
      "../../docs/production-non-deployment.md",
    ]) {
      const body = read(rel);
      expect(body).toContain(UI_SHA);
      expect(body).not.toContain(OLD_SHA);
    }
  });
});
