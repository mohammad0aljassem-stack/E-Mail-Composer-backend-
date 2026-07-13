#!/usr/bin/env node
// ============================================================================
// `pnpm contract:verify` — the SINGLE fail-closed compatibility gate between
// this backend worker and the canonical Phase 3 transport contract owned by the
// sibling UI repo. ONE implementation, used IDENTICALLY locally and in CI.
//
// It is a STATIC / STRUCTURAL check only. It never opens a database, a network
// socket, or any production system. It parses JSON with strict JSON.parse
// (never eval, never a dynamic require of untrusted content) and hashes files
// with node:crypto. It exits non-zero, listing every violation, when the
// backend and the checked-out UI contract are not compatible.
//
// Two sources of truth, deliberately separated:
//   * config/canonical-transport-contract.lock.json  — the SINGLE backend pin
//     (UI commit SHA, manifest path, manifest sha256, supported versions).
//   * <UI checkout>/<manifestPath>                    — the canonical manifest
//     (migration checksums + privilege/queue/flag boundaries).
//
// The UI checkout path is env UI_REPO, else ./ui-schema (CI), else the local
// sibling checkout /home/user/E-Mail-Composer-UI.
//
// Checks (map 1:1 to Workstream B, task B1 items 1–15):
//   1  checked-out UI git SHA === lock.uiCommitSha
//   2  sha256(manifest) === lock.manifestSha256
//   3  manifest.manifestSchemaVersion === lock.supportedManifestSchemaVersion
//   4  manifest.transportContractVersion === lock.supportedTransportContractVersion
//   5  every manifest-listed migration present on disk (UI checkout)
//   6  every manifest-listed migration's on-disk sha256 === manifest value
//   7  requiredFunctionPrivileges includes transport_worker EXECUTE on the
//      validator public.phase3_send_attempt_transition_ok(text,text)
//   8  forbiddenFunctionPrivileges / forbiddenTablePrivileges carry the
//      browser-role EXECUTE and worker INSERT+DELETE denials (structural)
//   9  protectedPrivateSchemas includes "transport"
//   10 backend QUEUE names (src/queues/queue-config.ts) === manifest queue names
//   11 QUEUE_DEFINITIONS[send_message].retryLimit === 0
//   12 the transport feature-flag default (src/config/env.ts) is DISABLED
//   13 NO test-only object GRANT to transport_worker in backend sql/ts/scripts
//   14 NO audit-table polling of public.transport_audit as a work queue
//   15 durable sync-request support present: SyncRequestRepository.claimBatch
//      exists and its SQL uses FOR UPDATE SKIP LOCKED
//
// Phase 3B additions (additive; checks 1–15 unchanged):
//   12b EVERY MAIL_*_ENABLED capability flag in src/config/env.ts (master +
//       the sync/idle/draft-mirror/mutations/send sub-flags) is parsed by the
//       strict bool() parser with a default of false. The sub-capability
//       flags are deliberately NOT in the UI manifest: the schema contract
//       has no dependency on worker sub-capabilities, so the backend env
//       parser is the single source of truth for these runtime controls and
//       the fail-closed default is enforced HERE.
//   15b durable multi-batch lifecycle: SyncRequestRepository.renewLease
//       exists and is a fenced CAS (status = 'claimed' AND claimed_at =
//       <held token>) so at most one claimant is ever effective.
//   16  read-only executor modules (sync / mutation / draft-mirror /
//       sync-request dispatcher) neither import nor construct the SMTP
//       client (NodemailerSmtpClient) — a read-only sync can never carry
//       SMTP capability.
// ============================================================================

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = join(
  REPO_ROOT,
  "config",
  "canonical-transport-contract.lock.json",
);

const VALIDATOR = "public.phase3_send_attempt_transition_ok(text,text)";
const WORKER_ROLE = "transport_worker";
const BROWSER_ROLES = ["public", "anon", "authenticated"];

const errors = [];
const fail = (msg) => errors.push(msg);

function sha256OfFile(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function readText(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Resolve the UI checkout: env UI_REPO, else ./ui-schema, else local sibling. */
function resolveUiRepo() {
  if (process.env.UI_REPO && process.env.UI_REPO.trim() !== "") {
    return process.env.UI_REPO;
  }
  const candidates = [
    join(REPO_ROOT, "ui-schema"),
    "/home/user/E-Mail-Composer-UI",
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* not present; try next */
    }
  }
  return candidates[0]; // ./ui-schema — will fail the checks below with a clear message
}

// --- Load the backend lock (strict JSON) -----------------------------------
let lock;
try {
  lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
} catch (err) {
  console.error(
    `contract:verify FAILED: cannot read/parse the backend lock at ${LOCK_PATH}: ${err.message}`,
  );
  process.exit(1);
}

const UI_REPO = resolveUiRepo();
const MANIFEST_ABS = join(UI_REPO, lock.manifestPath);
const MIGRATIONS_DIR = join(UI_REPO, "supabase", "migrations");

// --- 1. checked-out UI git SHA === lock.uiCommitSha ------------------------
try {
  const head = execFileSync("git", ["-C", UI_REPO, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== lock.uiCommitSha) {
    fail(
      `[1] UI checkout SHA mismatch: git HEAD=${head} != lock.uiCommitSha=${lock.uiCommitSha} (UI_REPO=${UI_REPO}).`,
    );
  }
} catch (err) {
  fail(
    `[1] cannot read git HEAD of the UI checkout at ${UI_REPO}: ${err.message}. ` +
      "Point UI_REPO at the sibling UI checkout pinned to lock.uiCommitSha.",
  );
}

// --- Load the canonical manifest (strict JSON) -----------------------------
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
} catch (err) {
  fail(
    `cannot read/parse the canonical manifest at ${MANIFEST_ABS}: ${err.message}.`,
  );
}

if (manifest !== null) {
  // --- 2. sha256(manifest) === lock.manifestSha256 -------------------------
  const manifestSha = sha256OfFile(MANIFEST_ABS);
  if (manifestSha !== lock.manifestSha256) {
    fail(
      `[2] manifest sha256 mismatch: on-disk=${manifestSha} != lock.manifestSha256=${lock.manifestSha256}. ` +
        "The manifest is immutable at the pinned SHA; a change requires an explicit lock update + review.",
    );
  }

  // --- 3. manifestSchemaVersion --------------------------------------------
  if (manifest.manifestSchemaVersion !== lock.supportedManifestSchemaVersion) {
    fail(
      `[3] manifestSchemaVersion=${JSON.stringify(manifest.manifestSchemaVersion)} != ` +
        `lock.supportedManifestSchemaVersion=${lock.supportedManifestSchemaVersion}.`,
    );
  }

  // --- 4. transportContractVersion -----------------------------------------
  if (
    manifest.transportContractVersion !== lock.supportedTransportContractVersion
  ) {
    fail(
      `[4] transportContractVersion=${JSON.stringify(manifest.transportContractVersion)} != ` +
        `lock.supportedTransportContractVersion=${lock.supportedTransportContractVersion}.`,
    );
  }

  // --- 5 & 6. every listed migration present on disk + checksum matches ----
  const migrations = Array.isArray(manifest.migrations)
    ? manifest.migrations
    : [];
  if (migrations.length === 0) {
    fail("[5] manifest.migrations must be a non-empty array.");
  }
  for (const entry of migrations) {
    const file = entry && entry.file;
    if (typeof file !== "string" || file.length === 0) {
      fail(`[5] a manifest migration entry has no valid "file" field.`);
      continue;
    }
    const abs = join(MIGRATIONS_DIR, file);
    let actual;
    try {
      actual = sha256OfFile(abs);
    } catch {
      fail(`[5] manifest-listed migration missing on disk: ${abs}.`);
      continue;
    }
    const expected = entry.sha256;
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      fail(`[6] migration "${file}" has a missing/invalid sha256 in manifest.`);
      continue;
    }
    if (actual !== expected) {
      fail(
        `[6] checksum MISMATCH for ${file}: manifest=${expected} on-disk=${actual}. ` +
          "Merged migrations are immutable — this requires explicit review.",
      );
    }
  }

  // --- 7. requiredFunctionPrivileges: worker EXECUTE on the validator ------
  const reqFn = Array.isArray(manifest.requiredFunctionPrivileges)
    ? manifest.requiredFunctionPrivileges
    : [];
  const hasWorkerExecute = reqFn.some(
    (p) =>
      p &&
      p.function === VALIDATOR &&
      p.privilege === "EXECUTE" &&
      p.grantee === WORKER_ROLE,
  );
  if (!hasWorkerExecute) {
    fail(
      `[7] requiredFunctionPrivileges must grant ${WORKER_ROLE} EXECUTE on ${VALIDATOR}.`,
    );
  }

  // --- 8. forbidden privileges: browser EXECUTE + worker INSERT/DELETE -----
  const forbFn = Array.isArray(manifest.forbiddenFunctionPrivileges)
    ? manifest.forbiddenFunctionPrivileges
    : [];
  for (const role of BROWSER_ROLES) {
    const present = forbFn.some(
      (p) =>
        p &&
        p.function === VALIDATOR &&
        p.privilege === "EXECUTE" &&
        p.grantee === role,
    );
    if (!present) {
      fail(
        `[8] forbiddenFunctionPrivileges must forbid ${role} EXECUTE on ${VALIDATOR}.`,
      );
    }
  }
  const forbTbl = Array.isArray(manifest.forbiddenTablePrivileges)
    ? manifest.forbiddenTablePrivileges
    : [];
  const workerWriteForbidden = forbTbl.find(
    (t) =>
      t &&
      t.table === "transport.sync_requests" &&
      t.grantee === WORKER_ROLE &&
      Array.isArray(t.privileges),
  );
  if (!workerWriteForbidden) {
    fail(
      `[8] forbiddenTablePrivileges must carry a transport.sync_requests entry for ${WORKER_ROLE}.`,
    );
  } else {
    for (const priv of ["INSERT", "DELETE"]) {
      if (!workerWriteForbidden.privileges.includes(priv)) {
        fail(
          `[8] forbiddenTablePrivileges for ${WORKER_ROLE} on transport.sync_requests must include ${priv}.`,
        );
      }
    }
  }

  // --- 9. protectedPrivateSchemas includes "transport" ---------------------
  const protectedSchemas = Array.isArray(manifest.protectedPrivateSchemas)
    ? manifest.protectedPrivateSchemas
    : [];
  if (!protectedSchemas.includes("transport")) {
    fail(`[9] protectedPrivateSchemas must include "transport".`);
  }

  // --- 10. backend queue names === manifest queue names --------------------
  const backendQueueNames = parseBackendQueueNames();
  const manifestQueueNames = new Set(
    Object.values(manifest.queues ?? {})
      .map((q) => q && q.name)
      .filter((n) => typeof n === "string"),
  );
  if (backendQueueNames === null) {
    fail("[10] could not parse QUEUE_NAMES from src/queues/queue-config.ts.");
  } else {
    const missingInManifest = [...backendQueueNames].filter(
      (n) => !manifestQueueNames.has(n),
    );
    const missingInBackend = [...manifestQueueNames].filter(
      (n) => !backendQueueNames.has(n),
    );
    if (missingInManifest.length > 0 || missingInBackend.length > 0) {
      fail(
        `[10] backend queue names differ from the manifest. backend=[${[...backendQueueNames].sort().join(", ")}] ` +
          `manifest=[${[...manifestQueueNames].sort().join(", ")}].`,
      );
    }
  }
}

// --- 11. send_message.retryLimit === 0 (read backend queue-config) ---------
{
  const retry = parseSendMessageRetryLimit();
  if (retry === null) {
    fail(
      "[11] could not read QUEUE_DEFINITIONS[send_message].retryLimit from src/queues/queue-config.ts.",
    );
  } else if (retry !== 0) {
    fail(
      `[11] send_message retryLimit must be 0 (SMTP is not exactly-once; no queue retry). Found ${retry}.`,
    );
  }
}

// --- 12. transport feature-flag default is DISABLED (read src/config/env) --
{
  const def = parseTransportFlagDefault();
  if (def === null) {
    fail(
      "[12] could not read the MAIL_TRANSPORT_V1_ENABLED default from src/config/env.ts.",
    );
  } else if (def !== false) {
    fail(
      `[12] the transport feature flag default must be disabled (false). Found default=${def}.`,
    );
  }
}

// --- 12b. every MAIL_*_ENABLED capability flag defaults to false ------------
// Sub-capability flags are deliberately NOT part of the UI manifest (the
// schema contract has no dependency on worker sub-capabilities); the backend
// env parser is the single source of truth for these runtime controls, so the
// fail-closed default is enforced here.
{
  const src = readText("src/config/env.ts");
  const EXPECTED_FLAGS = [
    "MAIL_TRANSPORT_V1_ENABLED",
    "MAIL_SYNC_ENABLED",
    "MAIL_IDLE_ENABLED",
    "MAIL_DRAFT_MIRROR_ENABLED",
    "MAIL_MUTATIONS_ENABLED",
    "MAIL_SEND_ENABLED",
  ];
  // Every strict-parser call site: bool(env.MAIL_*_ENABLED, <default>, ...).
  const seen = new Map();
  const boolCall = /bool\(\s*env\.(MAIL_[A-Z0-9_]*_ENABLED)\s*,\s*([^,)\s]+)/g;
  let m;
  while ((m = boolCall.exec(src)) !== null) {
    seen.set(m[1], m[2]);
  }
  for (const flag of EXPECTED_FLAGS) {
    if (!seen.has(flag)) {
      fail(
        `[12b] capability flag ${flag} is missing from src/config/env.ts (or not parsed via the strict bool() parser).`,
      );
    }
  }
  for (const [flag, def] of seen) {
    if (def !== "false") {
      fail(
        `[12b] ${flag} default must be the literal false (fail-closed); found "${def}".`,
      );
    }
  }
  // Any MAIL_*_ENABLED env read that bypasses the strict parser is a failure.
  const anyRead = /env\.(MAIL_[A-Z0-9_]*_ENABLED)\b/g;
  while ((m = anyRead.exec(src)) !== null) {
    if (!seen.has(m[1])) {
      fail(
        `[12b] ${m[1]} is read from env without the strict bool() parser (unparseable default).`,
      );
    }
  }
}

// --- 13. no test-only object GRANT to transport_worker (sql/ts/scripts) ----
for (const hit of scanWorkerObjectGrants()) {
  fail(`[13] test-only object GRANT to ${WORKER_ROLE} found: ${hit}.`);
}

// --- 14. no audit-table polling of public.transport_audit as a queue -------
for (const hit of scanAuditPolling()) {
  fail(`[14] audit-table polling of transport_audit as a work queue: ${hit}.`);
}

// --- 15. durable sync-request support present (claimBatch + SKIP LOCKED) ---
{
  const repos = readText("src/db/repositories.ts");
  if (!/\basync\s+claimBatch\s*\(/.test(repos)) {
    fail("[15] SyncRequestRepository.claimBatch is missing from repositories.");
  }
  if (!/for\s+update\s+skip\s+locked/i.test(repos)) {
    fail(
      "[15] the durable sync-request claim SQL must use FOR UPDATE SKIP LOCKED.",
    );
  }

  // 15b (Phase 3B): fenced lease renewal for multi-batch claims — renewLease
  // must exist and its SQL must be a claimed_at CAS guarded on status='claimed'
  // (single-claimant guarantee without any schema change).
  const renew = /async\s+renewLease\s*\([\s\S]{0,900}?returning/i.exec(repos);
  if (renew === null) {
    fail(
      "[15b] SyncRequestRepository.renewLease is missing from repositories.",
    );
  } else {
    if (!/status\s*=\s*'claimed'/i.test(renew[0])) {
      fail(
        "[15b] renewLease SQL must be guarded on status = 'claimed' (CAS shape).",
      );
    }
    if (!/where[\s\S]*?claimed_at\s*=\s*\$\d/i.test(renew[0])) {
      fail(
        "[15b] renewLease SQL must CAS on claimed_at = <held token> in its WHERE clause.",
      );
    }
  }
}

// --- 16. read-only executor modules never import/construct the SMTP client -
{
  const READ_ONLY_MODULES = [
    "src/workers/sync-executor.ts",
    "src/workers/mutation-executor.ts",
    "src/workers/draft-mirror-executor.ts",
    "src/workers/sync-request-dispatcher.ts",
    // No IDLE module exists yet; when one lands it must be added here.
  ];
  const banned = /NodemailerSmtpClient|smtp-client|createSubmission/;
  for (const rel of READ_ONLY_MODULES) {
    let text;
    try {
      text = readText(rel);
    } catch {
      fail(`[16] expected read-only executor module missing: ${rel}.`);
      continue;
    }
    for (const line of nonCommentLines(text)) {
      if (banned.test(line)) {
        fail(
          `[16] SMTP-capability reference in read-only module ${rel}: ${line.trim().slice(0, 120)}.`,
        );
      }
    }
  }
}

report();

// ===========================================================================
// helpers (pure, text/static — no DB, no eval)
// ===========================================================================

/** Extract the string values of QUEUE_NAMES from queue-config.ts. */
function parseBackendQueueNames() {
  const src = readText("src/queues/queue-config.ts");
  const block = /export const QUEUE_NAMES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(
    src,
  );
  if (block === null) return null;
  const names = new Set();
  const re = /\b\w+\s*:\s*"([a-z_]+)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) names.add(m[1]);
  return names.size > 0 ? names : null;
}

/** Read QUEUE_DEFINITIONS[send_message].retryLimit as a number. */
function parseSendMessageRetryLimit() {
  const src = readText("src/queues/queue-config.ts");
  const block = /\[QUEUE_NAMES\.sendMessage\]\s*:\s*\{([\s\S]*?)\}\s*,/.exec(
    src,
  );
  if (block === null) return null;
  const m = /retryLimit\s*:\s*(\d+)/.exec(block[1]);
  return m === null ? null : Number(m[1]);
}

/**
 * Read the MAIL_TRANSPORT_V1_ENABLED default from env.ts (true/false).
 * Matches both call shapes of the strict bool() parser:
 *   bool(env.MAIL_TRANSPORT_V1_ENABLED, false)
 *   bool(env.MAIL_TRANSPORT_V1_ENABLED, false, "MAIL_TRANSPORT_V1_ENABLED")
 * The default is the FIRST true/false after the env-var reference.
 */
function parseTransportFlagDefault() {
  const src = readText("src/config/env.ts");
  const m = /env\.MAIL_TRANSPORT_V1_ENABLED\s*,\s*(true|false)\s*[,)]/.exec(
    src,
  );
  if (m === null) return null;
  return m[1] === "true";
}

/**
 * Return files (repo-relative) to statically scan for the backend regression
 * checks: source, scripts, and any backend .sql. NEVER scans node_modules,
 * dist, coverage, the UI checkout, or the test tree (negative fixtures live
 * there and are covered by the dedicated B7 unit test).
 */
function scanTargets() {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = join(relDir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|sql|sh|mjs)$/.test(e.name)) out.push(rel);
    }
  };
  walk("src");
  walk("scripts");
  return out.filter((f) => f !== "scripts/verify-contract.mjs");
}

function nonCommentLines(text) {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return (
      t !== "" &&
      !t.startsWith("//") &&
      !t.startsWith("*") &&
      !t.startsWith("/*") &&
      !t.startsWith("#") &&
      !t.startsWith("--")
    );
  });
}

/**
 * Detect an actual object GRANT to transport_worker in executable backend code.
 * LOGIN and CONNECT (local authentication setup) are explicitly permitted — they
 * are role/database privileges, not application-object privilege injection.
 */
function scanWorkerObjectGrants() {
  const hits = [];
  const grantTo =
    /\bgrant\b[\s\S]{0,160}?\bto\s+(?:role\s+)?transport_worker\b/i;
  for (const rel of scanTargets()) {
    let text;
    try {
      text = readText(rel);
    } catch {
      continue;
    }
    for (const line of nonCommentLines(text)) {
      if (grantTo.test(line) && !/\b(connect|login)\b/i.test(line)) {
        hits.push(`${rel}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  return hits;
}

/** Detect a SELECT/read of public.transport_audit used as a work queue. */
function scanAuditPolling() {
  const hits = [];
  const poll = /select[\s\S]{0,200}?\bfrom\s+(?:public\.)?transport_audit\b/i;
  for (const rel of scanTargets()) {
    if (!rel.startsWith("src/")) continue; // only the worker runtime can poll
    let text;
    try {
      text = readText(rel);
    } catch {
      continue;
    }
    // Whole-file test (a SELECT ... FROM transport_audit may span lines).
    if (poll.test(text)) hits.push(rel);
  }
  return hits;
}

function report() {
  if (errors.length > 0) {
    console.error(
      "contract:verify FAILED — backend is NOT compatible with the canonical transport contract:",
    );
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\nLock:     ${LOCK_PATH}`);
    console.error(`UI_REPO:  ${UI_REPO}`);
    console.error(`Manifest: ${MANIFEST_ABS}`);
    process.exit(1);
  }
  console.log(
    "contract:verify OK — backend compatible with the canonical transport contract.\n" +
      `  UI pin:   ${lock.uiCommitSha}\n` +
      `  manifest: ${lock.manifestPath} (sha256 ${lock.manifestSha256})\n` +
      `  versions: manifestSchema=${lock.supportedManifestSchemaVersion}, ` +
      `transportContract=${lock.supportedTransportContractVersion}\n` +
      "  checks 1–16 (incl. 12b, 15b) passed (SHA, manifest hash, versions, migration " +
      "checksums, privilege/queue/flag boundaries, capability-flag defaults, " +
      "sync lease CAS, static regression scans).",
  );
  process.exit(0);
}
