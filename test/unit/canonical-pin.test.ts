import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Canonical-pin guards. These assert — deterministically, with no DB — that the
 * backend is pinned to the canonical transport contract through a SINGLE source
 * of truth (config/canonical-transport-contract.lock.json), that the previously
 * hand-copied constants have been collapsed to read from the lock + the UI
 * manifest, and that no superseded UI SHA survives as a live reference.
 *
 * The lock holds the UI commit SHA + manifest hash + supported versions; the UI
 * manifest holds the per-migration checksums. Neither the full SHA nor any
 * migration checksum is hand-copied into backend code/config any more — so this
 * file is the ONLY place the superseded SHAs may appear (as the explicit
 * negative-guard fixture below).
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
function abs(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

interface Lock {
  uiCommitSha: string;
  manifestPath: string;
  manifestSha256: string;
  supportedManifestSchemaVersion: number;
  supportedTransportContractVersion: number;
}
const lock = JSON.parse(
  read("../../config/canonical-transport-contract.lock.json"),
) as Lock;

// The FINAL merged UI SHA (Workstream A). Kept here only to assert the lock's
// value; every consumer reads it FROM the lock, not from a literal.
const UI_SHA = "44c62c630b1db6bbdbcf5c95863bd3b896a77c99";

// Superseded / never-live UI SHAs. Abbreviated prefixes match their full forms
// too. This array is the ONLY sanctioned occurrence of these strings in the
// repo; the negative guard proves they appear nowhere in live code/config.
const OBSOLETE_SHAS = ["67daad9", "e4653d7", "422485a"];

describe("canonical pin — the lock is the single source of truth", () => {
  it("pins the FINAL merged UI SHA and the supported versions", () => {
    expect(lock.uiCommitSha).toBe(UI_SHA);
    expect(lock.manifestPath).toBe(
      "supabase/contracts/phase3-transport-contract.json",
    );
    expect(lock.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.supportedManifestSchemaVersion).toBe(1);
    expect(lock.supportedTransportContractVersion).toBe(1);
  });
});

describe("canonical pin — CI workflow reads the lock (no hand-copied constants)", () => {
  const ci = read("../../.github/workflows/ci.yml");

  it("keeps UI_REPO_REF a literal EQUAL to the lock's uiCommitSha", () => {
    // actions/checkout needs the ref before any file is readable, so it stays a
    // literal — but it must equal the lock, and contract:verify asserts HEAD.
    expect(ci).toContain(`UI_REPO_REF: "${lock.uiCommitSha}"`);
  });

  it("delegates verification to the single `pnpm contract:verify` gate", () => {
    expect(ci).toContain("pnpm contract:verify");
  });

  it("removed the hand-copied checksum env vars + inline verify block", () => {
    expect(ci).not.toContain("EXPECTED_FOUNDATION_SHA");
    expect(ci).not.toContain("EXPECTED_HARDENING_SHA");
    expect(ci).not.toContain("EXPECTED_GRANT_SHA");
    // No raw 64-hex checksum literal remains in the workflow.
    expect(ci).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("canonical pin — test-db.sh reads the lock + manifest", () => {
  const sh = read("../../scripts/test-db.sh");

  it("reads the expected UI SHA from the lock and checksums from the manifest", () => {
    expect(sh).toContain("canonical-transport-contract.lock.json");
    expect(sh).toContain("lock_get uiCommitSha");
    expect(sh).toMatch(/manifest_sha/);
    // The FULL five-migration chain is still loaded (baseline + 5).
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

  it("still fails closed on a SHA / checksum / missing-migration mismatch", () => {
    expect(sh).toMatch(/rev-parse HEAD/);
    expect(sh).toMatch(/checksum mismatch/i);
    expect(sh).toMatch(/required schema file missing/);
    expect(sh).toContain("MIG_GRANT");
    expect(sh).toContain("MIG_HARDENING");
  });

  it("does NOT inject the test-only EXECUTE grant, and holds no checksum literal", () => {
    const injected =
      /grant\s+execute\s+on\s+function\s+public\.phase3_send_attempt_transition_ok[\s\S]*?transport_worker/i;
    expect(sh).not.toMatch(injected);
    // No hand-copied 64-hex migration checksum survives in the script.
    expect(sh).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("canonical pin — negative guard (no superseded SHA in live code/config)", () => {
  // Live files that historically carried the pin. This test file is EXCLUDED —
  // it is the sanctioned fixture that names the obsolete SHAs on purpose.
  const liveFiles = [
    "../../.github/workflows/ci.yml",
    "../../scripts/test-db.sh",
    "../../scripts/verify-contract.mjs",
    "../../config/canonical-transport-contract.lock.json",
    "../../README.md",
    "../../THIRD_PARTY_NOTICES.md",
    "../../docs/production-non-deployment.md",
    "../../docs/env-reference.md",
    "../../docs/adr/0006-durable-sync-requests.md",
    "../../docs/adr/0007-canonical-contract-lock.md",
    "../../src/domain/models.ts",
  ];

  it("carries the current UI SHA in the re-pinned docs (README, notices, non-deployment)", () => {
    for (const rel of [
      "../../README.md",
      "../../THIRD_PARTY_NOTICES.md",
      "../../docs/production-non-deployment.md",
    ]) {
      expect(read(rel)).toContain(lock.uiCommitSha);
    }
  });

  it("contains no obsolete/never-live UI SHA (67daad9 / e4653d7 / 422485a)", () => {
    for (const rel of liveFiles) {
      const body = read(rel);
      for (const old of OBSOLETE_SHAS) {
        expect(
          body.includes(old),
          `superseded SHA "${old}" leaked into ${rel}`,
        ).toBe(false);
      }
    }
  });
});

// When a UI checkout is resolvable, prove the lock + manifest are the live
// checksum source: the lock hashes the manifest, and the manifest hashes each
// migration. Skipped (not failed) when no UI checkout is present, so `pnpm test`
// stays green with or without it.
function resolveUiRepo(): string | null {
  const envRepo = process.env.UI_REPO;
  const candidates = [
    ...(envRepo && envRepo.trim() !== "" ? [envRepo] : []),
    abs("../../ui-schema"),
    "/home/user/E-Mail-Composer-UI",
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}
const uiRepo = resolveUiRepo();
const manifestAbs = uiRepo !== null ? `${uiRepo}/${lock.manifestPath}` : null;
const hasManifest = manifestAbs !== null && existsSync(manifestAbs);

describe.skipIf(!hasManifest)(
  "canonical pin — lock + manifest are the live checksum source",
  () => {
    it("the lock's manifestSha256 matches the on-disk manifest hash", () => {
      const buf = readFileSync(manifestAbs!);
      const hash = createHash("sha256").update(buf).digest("hex");
      expect(hash).toBe(lock.manifestSha256);
    });

    it("each manifest migration checksum matches its on-disk file", () => {
      const manifest = JSON.parse(readFileSync(manifestAbs!, "utf8")) as {
        migrations: { file: string; sha256: string }[];
      };
      expect(manifest.migrations.length).toBeGreaterThanOrEqual(3);
      for (const m of manifest.migrations) {
        const file = `${uiRepo}/supabase/migrations/${m.file}`;
        const hash = createHash("sha256")
          .update(readFileSync(file))
          .digest("hex");
        expect(hash, `checksum drift for ${m.file}`).toBe(m.sha256);
      }
    });
  },
);
