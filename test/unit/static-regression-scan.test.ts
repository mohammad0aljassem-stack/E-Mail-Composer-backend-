import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B7 — narrow static regression scans. These fail the build if a known-dangerous
 * pattern is reintroduced. Patterns are deliberately narrow: documented fixture
 * exceptions (the canonical-pin negative guard, the integration negative tests)
 * are allowed, and docs/negative-tests are not flagged without context.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(rel: string): string {
  return readFileSync(ROOT + rel, "utf8");
}

/** Recursively list repo-relative files under `dir` matching `exts`. */
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const IGNORE = new Set([
    "node_modules",
    "dist",
    "coverage",
    "ui-schema",
    ".git",
  ]);
  const rec = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(ROOT + rel, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) rec(childRel);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(childRel);
    }
  };
  rec(dir);
  return out;
}

/** Lines that are not comments (JS/TS/shell/SQL) and not blank. */
function codeLines(text: string): string[] {
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

// The sanctioned fixtures that legitimately name the obsolete SHAs: the
// canonical-pin negative guard and THIS scan file (which defines the deny-list).
const SHA_FIXTURES = new Set<string>([
  "test/unit/canonical-pin.test.ts",
  "test/unit/static-regression-scan.test.ts",
]);
// The integration negative tests legitimately attempt (and assert rejection of)
// worker INSERT/DELETE and version rollback; they are not object grants.
const GRANT_NEGATIVE_FIXTURES = new Set<string>([
  "test/integration/sync-requests.test.ts",
  "test/integration/idempotency-and-transitions.test.ts",
]);

describe("B7 — obsolete UI SHAs never appear as a live reference", () => {
  const OBSOLETE = ["67daad9", "e4653d7", "422485a"];
  it("no superseded SHA outside the explicit negative-guard fixture", () => {
    const files = [
      ...walk("src", [".ts"]),
      ...walk("scripts", [".mjs", ".sh"]),
      ...walk("docs", [".md"]),
      ...walk(".github", [".yml", ".yaml"]),
      ...walk("test", [".ts"]),
      ...walk("config", [".json"]),
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ];
    for (const rel of files) {
      if (SHA_FIXTURES.has(rel)) continue;
      const body = read(rel);
      for (const old of OBSOLETE) {
        expect(body.includes(old), `superseded SHA "${old}" in ${rel}`).toBe(
          false,
        );
      }
    }
  });
});

describe("B7 — migration checksums are not duplicated outside the manifest", () => {
  // The three immutable Phase 3 migration checksums live ONLY in the UI manifest.
  const CHECKSUMS = [
    "a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a",
    "ee064f0b50d01897b8247a10edefc95bd0088862e3731693b19da7c851253977",
    "ca15b9de01894ef784fad57f991a052e2da1fcdca435cc1a78463af34b3c0dba",
  ];
  it("no backend file hand-copies a Phase 3 migration checksum", () => {
    const files = [
      ...walk("src", [".ts"]),
      ...walk("scripts", [".mjs", ".sh"]),
      ...walk("docs", [".md"]),
      ...walk(".github", [".yml", ".yaml"]),
      ...walk("config", [".json"]),
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ];
    for (const rel of files) {
      const body = read(rel);
      for (const sum of CHECKSUMS) {
        expect(body.includes(sum), `checksum literal in ${rel}`).toBe(false);
      }
    }
  });
});

describe("B7 — no object GRANT to transport_worker outside canonical migrations", () => {
  // LOGIN/CONNECT (local authentication setup) are the documented exception.
  const grantTo =
    /\bgrant\b[\s\S]{0,160}?\bto\s+(?:role\s+)?transport_worker\b/i;
  it("backend sql/ts/scripts never inject an object grant to the worker", () => {
    const files = [
      ...walk("src", [".ts", ".sql"]),
      ...walk("scripts", [".sh", ".mjs"]),
    ];
    for (const rel of files) {
      // The verifier defines the scan; it must not be flagged by its own regex.
      if (rel === "scripts/verify-contract.mjs") continue;
      for (const line of codeLines(read(rel))) {
        if (grantTo.test(line) && !/\b(connect|login)\b/i.test(line)) {
          throw new Error(
            `object grant to transport_worker in ${rel}: ${line.trim()}`,
          );
        }
      }
    }
  });

  it("the integration negative fixtures only ASSERT rejection (no real grant)", () => {
    for (const rel of GRANT_NEGATIVE_FIXTURES) {
      const body = read(rel);
      // They contain rejects assertions, never a `grant ... to transport_worker`.
      expect(grantTo.test(body)).toBe(false);
    }
  });
});

describe("B7 — no audit-table polling of transport_audit as a work queue", () => {
  const poll = /select[\s\S]{0,200}?\bfrom\s+(?:public\.)?transport_audit\b/i;
  it("the worker runtime never reads transport_audit as a queue", () => {
    for (const rel of walk("src", [".ts"])) {
      expect(poll.test(read(rel)), `transport_audit polled in ${rel}`).toBe(
        false,
      );
    }
  });
});

describe("B7 — no direct SMTP submission outside the provider adapter", () => {
  it("createTransport/sendMail live only in src/providers/imap-smtp", () => {
    for (const rel of walk("src", [".ts"])) {
      if (rel.startsWith("src/providers/imap-smtp/")) continue;
      const body = read(rel);
      expect(
        /\.createTransport\s*\(|\.sendMail\s*\(/.test(body),
        `direct SMTP submission in ${rel} (must go through the send executor)`,
      ).toBe(false);
    }
  });
});

describe("C1 — SMTP capability is confined to the submission factory path", () => {
  // The ONLY sanctioned SMTP client construction sites: the adapter itself and
  // the capability-scoped provider factory (createSubmission).
  const SMTP_CONSTRUCTION_ALLOWED = new Set<string>([
    "src/providers/imap-smtp/smtp-client.ts",
    "src/workers/provider-factory.ts",
  ]);
  // Files that must stay free of ANY SMTP-client coupling: the read-only /
  // mailbox-mutating executors and the durable sync-request dispatcher.
  const READ_ONLY_MODULES = [
    "src/workers/sync-executor.ts",
    "src/workers/mutation-executor.ts",
    "src/workers/draft-mirror-executor.ts",
    "src/workers/draft-mirror-payload-resolver.ts",
    "src/workers/send-payload-resolver.ts",
    "src/workers/sync-request-dispatcher.ts",
    "src/workers/idle-coordinator.ts",
  ];

  it("SMTP client construction happens only in the allowlisted files", () => {
    const construction =
      /new\s+NodemailerSmtpClient\b|nodemailer\.createTransport\s*\(/;
    for (const rel of walk("src", [".ts"])) {
      if (SMTP_CONSTRUCTION_ALLOWED.has(rel)) continue;
      const code = codeLines(read(rel)).join("\n");
      expect(
        construction.test(code),
        `SMTP client construction outside the factory in ${rel}`,
      ).toBe(false);
    }
  });

  it("no combined verifyConnection() call site remains anywhere", () => {
    // The combined IMAP+SMTP verify was removed with the capability split; a
    // reappearance would mean read paths verify SMTP again. The pattern is
    // assembled at runtime so this scan file never matches itself.
    const combined = new RegExp("verifyConnection" + "\\s*\\(");
    for (const rel of [...walk("src", [".ts"]), ...walk("test", [".ts"])]) {
      if (rel === "test/unit/static-regression-scan.test.ts") continue;
      expect(
        combined.test(read(rel)),
        `combined verifyConnection call/definition in ${rel}`,
      ).toBe(false);
    }
  });

  it("read-only executor modules never touch the SMTP client module", () => {
    const banned = /NodemailerSmtpClient|smtp-client|createSubmission/;
    for (const rel of READ_ONLY_MODULES) {
      for (const line of codeLines(read(rel))) {
        expect(
          banned.test(line),
          `SMTP-capability reference in read-only module ${rel}: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

describe("Correction 3 — durable multi-batch sync lifecycle invariants", () => {
  // The false-completion defect: the worker entrypoint used to markCompleted
  // after the FIRST executor batch. Completion now lives ONLY in the extracted
  // lifecycle function, which must check needsFollowUp before completing.
  it("the worker entrypoint never calls markCompleted (lifecycle owns completion)", () => {
    const code = codeLines(read("src/entrypoints/worker.ts")).join("\n");
    expect(code.includes("markCompleted")).toBe(false);
  });

  it("the lifecycle module references needsFollowUp before calling markCompleted", () => {
    const code = codeLines(read("src/workers/sync-lifecycle.ts")).join("\n");
    const followUpAt = code.indexOf("needsFollowUp");
    // The CALL site (`.markCompleted(`) — not the store-interface Pick type.
    const completedAt = code.indexOf("markCompleted(");
    expect(followUpAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThanOrEqual(0);
    expect(followUpAt).toBeLessThan(completedAt);
  });

  // A continuation must NEVER drop the durable request id (the original defect
  // enqueued follow-ups via the plain mailbox+folder key, losing the request).
  it("every continuation enqueue call site passes syncRequestId", () => {
    const callish = /enqueueSyncContinuation\s*\(|\benqueueContinuation\s*\(/;
    for (const rel of walk("src", [".ts"])) {
      // The QueueManager method definition itself derives the key; call sites
      // elsewhere must pass the id inside the argument object.
      if (rel === "src/queues/queue-manager.ts") continue;
      const lines = codeLines(read(rel));
      for (let i = 0; i < lines.length; i++) {
        if (!callish.test(lines[i]!)) continue;
        const window = lines.slice(i, i + 10).join("\n");
        expect(
          window.includes("syncRequestId"),
          `continuation enqueue without syncRequestId in ${rel} near: ${lines[i]!.trim()}`,
        ).toBe(true);
      }
    }
  });
});

describe("C4 — the production send-payload resolver is real (no stub)", () => {
  it('src never reintroduces the throwing "not configured" resolver stub', () => {
    // Assembled at runtime so this scan file never matches itself.
    const stub = "send payload resolver" + " not configured";
    for (const rel of walk("src", [".ts"])) {
      expect(read(rel).includes(stub), `resolver stub in ${rel}`).toBe(false);
    }
  });

  it("the send-executor wiring constructs DraftVersionSendPayloadResolver inside the sendMessage-gated branch", () => {
    const code = codeLines(read("src/entrypoints/worker.ts")).join("\n");
    const gate = code.indexOf("if (plan.sendMessage)");
    const resolver = code.indexOf("new DraftVersionSendPayloadResolver");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(resolver).toBeGreaterThan(gate);
  });
});

describe("C6 — draft mirroring registers only behind its capability flag", () => {
  it("the registration plan gates draftMirror on master && draftMirrorEnabled", () => {
    const code = read("src/entrypoints/registration-plan.ts");
    expect(
      /draftMirror:\s*master\s*&&\s*config\.draftMirrorEnabled/.test(code),
    ).toBe(true);
  });

  it("worker.ts registers the draft_mirror handler inside the plan.draftMirror branch", () => {
    const code = codeLines(read("src/entrypoints/worker.ts")).join("\n");
    const gate = code.indexOf("if (plan.draftMirror)");
    const registration = code.indexOf("QUEUE_NAMES.draftMirror");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(gate);
  });
});

describe("C5 — outbound MIME is built once with a pinned date", () => {
  it("every buildOutboundMime call in the send executor pins a date", () => {
    const lines = read("src/workers/send-executor.ts").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes("buildOutboundMime(")) continue;
      const window = lines.slice(i, i + 4).join("\n");
      expect(
        window.includes("date"),
        `un-pinned buildOutboundMime near send-executor.ts line ${i + 1}`,
      ).toBe(true);
    }
  });

  it("the send MIME path never stamps an ad-hoc bare `new Date()`", () => {
    for (const rel of [
      "src/workers/send-executor.ts",
      "src/mime/outbound-builder.ts",
    ]) {
      expect(/new Date\(\)/.test(read(rel)), `bare new Date() in ${rel}`).toBe(
        false,
      );
    }
  });
});

describe("B7 — send_message acquires no retry behavior", () => {
  it("the send_message queue block keeps retryLimit 0 / retryBackoff false", () => {
    const src = read("src/queues/queue-config.ts");
    const block = /\[QUEUE_NAMES\.sendMessage\]\s*:\s*\{([\s\S]*?)\}\s*,/.exec(
      src,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/retryLimit\s*:\s*0\b/);
    expect(block![1]).not.toMatch(/retryLimit\s*:\s*[1-9]/);
    expect(block![1]).toMatch(/retryBackoff\s*:\s*false/);
  });

  it("enqueueSend passes no retryLimit override", () => {
    const mgr = read("src/queues/queue-manager.ts");
    const enq = /public async enqueueSend\([\s\S]*?\n {2}\}/.exec(mgr);
    expect(enq).not.toBeNull();
    // Strip comments; a `retryLimit` may legitimately be *named* in a comment
    // ("deliberately no retryLimit override"). What must never appear is an
    // actual `retryLimit:` option passed to boss.send.
    const code = enq![0]
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/retryLimit\s*:/);
  });
});

describe("C7 — the IDLE coordinator is gated and IMAP-only", () => {
  it("the registration plan gates idle on master && sync && idle", () => {
    const code = read("src/entrypoints/registration-plan.ts");
    expect(
      /idle:\s*master\s*&&\s*config\.syncEnabled\s*&&\s*config\.idleEnabled/.test(
        code,
      ),
    ).toBe(true);
  });

  it("worker.ts constructs the IdleCoordinator only inside the plan.idle branch", () => {
    const code = codeLines(read("src/entrypoints/worker.ts")).join("\n");
    const gate = code.indexOf("if (plan.idle)");
    const construction = code.indexOf("new IdleCoordinator");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(construction).toBeGreaterThan(gate);
  });

  it("the coordinator depends only on the createImapSession capability slice", () => {
    const code = read("src/workers/idle-coordinator.ts");
    expect(code).toContain('Pick<ProviderFactory, "createImapSession">');
  });
});

describe("Phase 3B — no real IONOS hostname in tests", () => {
  // Assembled at runtime so this scan file never matches itself. The docs
  // may show provider-shaped host EXAMPLES (docs/env-reference.md); test
  // code must never name a real IONOS endpoint — tests run against the
  // in-repo fakes only.
  const banned = ".io" + "nos.";
  it("test/ contains no dotted IONOS hostname literal", () => {
    for (const rel of walk("test", [".ts"])) {
      expect(
        read(rel).toLowerCase().includes(banned),
        `IONOS hostname literal in ${rel}`,
      ).toBe(false);
    }
  });
});

describe("Phase 3B — the production project ref appears only in its denylist fixtures", () => {
  // The ONLY sanctioned occurrences: the provisioning CLI (which DEFINES the
  // refusal denylist), the unit test that asserts the refusal, and this scan.
  const PROD_REF_FIXTURES = new Set<string>([
    "src/entrypoints/provision-credential.ts",
    "test/unit/crypto.test.ts",
    "test/unit/static-regression-scan.test.ts",
  ]);
  const prodRef = "fpanvpxjjddhasjmpflz";
  it("src/ and test/ never reference the production project ref elsewhere", () => {
    for (const rel of [...walk("src", [".ts"]), ...walk("test", [".ts"])]) {
      if (PROD_REF_FIXTURES.has(rel)) continue;
      expect(
        read(rel).includes(prodRef),
        `production project ref in ${rel}`,
      ).toBe(false);
    }
  });

  it("the sanctioned fixtures keep the ref denylisted, not connectable", () => {
    // The CLI must still define the refusal constant, and the test must
    // assert refusal — deleting either would silently disarm the tripwire.
    expect(read("src/entrypoints/provision-credential.ts")).toContain(
      `PROD_PROJECT_REF = "${prodRef}"`,
    );
    expect(read("test/unit/crypto.test.ts")).toContain(prodRef);
  });
});

describe("B7 — TLS verification is never disabled in src", () => {
  it("src contains no rejectUnauthorized (verification stays on, always)", () => {
    // Any occurrence is banned: the only reason to name this option is to turn
    // certificate verification off, which would silently permit MITM of the
    // credential + message bytes. There is no sanctioned exception in src/.
    for (const rel of walk("src", [".ts"])) {
      expect(
        read(rel).includes("rejectUnauthorized"),
        `rejectUnauthorized in ${rel}`,
      ).toBe(false);
    }
  });
});

describe("B7 — no unchecked TS escape hatches or secret/MIME logging in src", () => {
  const srcFiles = walk("src", [".ts"]);

  it("src contains no `as any`", () => {
    for (const rel of srcFiles) {
      expect(/\bas any\b/.test(read(rel)), `\`as any\` in ${rel}`).toBe(false);
    }
  });

  it("src contains no @ts-ignore / @ts-nocheck / @ts-expect-error", () => {
    for (const rel of srcFiles) {
      const body = read(rel);
      for (const tok of ["@ts-ignore", "@ts-nocheck", "@ts-expect-error"]) {
        expect(body.includes(tok), `${tok} in ${rel}`).toBe(false);
      }
    }
  });

  it("no logger/console call carries a raw-body / secret property", () => {
    // Narrow: a logging call whose argument object names a clearly-sensitive key.
    const banned =
      /\b(?:raw|rawMime|mime|body|html|text|password|passphrase|secret|ciphertext|plaintext|credential|smtp_response|authTag)\s*:/;
    const logOpen =
      /(?:\bconsole\.\w+|\.(?:info|warn|error|debug|trace|log))\s*\(/;
    for (const rel of srcFiles) {
      const lines = read(rel).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!logOpen.test(lines[i]!)) continue;
        const window = lines.slice(i, i + 8).join("\n");
        expect(
          banned.test(window),
          `possible secret/MIME logging in ${rel} near line ${i + 1}`,
        ).toBe(false);
      }
    }
  });
});

describe("Contract v2 — the worker reads confirmed content only via the snapshot functions", () => {
  it("no src code line reads the mutable public.draft_versions table", () => {
    // The worker resolves confirmed subject/body/revision ONLY through
    // transport.get_send_snapshot / get_mirror_snapshot (the private DEFINER
    // accessors); it has no draft_versions table grant. Every remaining
    // `draft_versions` mention is an explanatory COMMENT (filtered by
    // codeLines) — an actual table read would be a fail-closed-bypass
    // regression. The Slice-1 DraftVersionRepository/findDraftVersion was
    // deleted; this tripwire keeps it deleted.
    for (const rel of walk("src", [".ts"])) {
      for (const line of codeLines(read(rel))) {
        expect(
          line.includes("draft_versions"),
          `direct draft_versions reference in code of ${rel}: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });

  it("the resolver goes through get_send_snapshot (not a raw draft read)", () => {
    // Positive assertion: the snapshot accessor is actually wired, so the
    // negative scan above cannot pass merely because the read path was removed.
    const repos = read("src/db/repositories.ts");
    expect(repos).toContain("transport.get_send_snapshot");
  });
});

describe("Contract v2 — MIME artifacts are created only via the DEFINER function", () => {
  // The worker has SELECT + UPDATE on transport.send_mime_artifacts and NO
  // INSERT/DELETE; rows are created ONLY by
  // transport.create_or_verify_send_mime_artifact (which re-hashes the caller's
  // bytes). A direct INSERT/DELETE would bypass the byte-identity + bound
  // verification. sync_requests is likewise browser-RPC-inserted only.
  const forbidden = [
    /insert\s+into\s+transport\.send_mime_artifacts\b/i,
    /delete\s+from\s+transport\.send_mime_artifacts\b/i,
    /insert\s+into\s+transport\.sync_requests\b/i,
    /delete\s+from\s+transport\.sync_requests\b/i,
  ];
  it("src never directly INSERTs/DELETEs the artifact or sync-request tables", () => {
    for (const rel of walk("src", [".ts"])) {
      const code = codeLines(read(rel)).join("\n");
      for (const re of forbidden) {
        expect(
          re.test(code),
          `direct ${re} on a DEFINER-only private table in ${rel}`,
        ).toBe(false);
      }
    }
  });

  it("the artifact store goes through create_or_verify_send_mime_artifact", () => {
    const repos = read("src/db/repositories.ts");
    expect(repos).toContain("transport.create_or_verify_send_mime_artifact");
  });

  it("the send restart/reconcile path reuses stored bytes and never rebuilds MIME", () => {
    // reconcileSentCopy must append the EXACT persisted rawMime (getBySendAttempt)
    // — never re-render/re-encode a message on the restart path, which could
    // change bytes and double-send divergent content.
    const exec = read("src/workers/send-executor.ts");
    const body =
      /private async reconcileSentCopy\([\s\S]*?\n {2}(?:private|public) async /.exec(
        exec,
      );
    expect(
      body,
      "reconcileSentCopy not found in send-executor.ts",
    ).not.toBeNull();
    expect(
      body![0].includes("buildOutboundMime"),
      "reconcileSentCopy rebuilds MIME instead of reusing the stored artifact",
    ).toBe(false);
  });
});

describe("Phase 4 — durable sync fencing is generation-scoped and payload-sourced", () => {
  it("every durable sync-request singleton key carries the :gen: generation", () => {
    // A key without the generation would let a superseded claimant's job dedup
    // against (or be deduped by) a live one across a reclaim. Both the dispatch
    // key and the continuation key must be generation-scoped.
    for (const rel of walk("src", [".ts"])) {
      for (const line of codeLines(read(rel))) {
        if (!line.includes("sync-req:")) continue;
        expect(
          line.includes(":gen:"),
          `generation-less durable sync key in ${rel}: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it("the sync lifecycle sources its fencing tuple from the job payload, not a re-read", () => {
    // Adopting a freshly re-read claimed_at (getById) as the token would defeat
    // fencing: a stale worker would 'renew' against whatever the CURRENT holder
    // wrote. The tuple must come from the immutable job payload.
    const life = read("src/workers/sync-lifecycle.ts");
    expect(
      /\.getById\s*\(/.test(life),
      "sync-lifecycle re-reads the row (getById) instead of using the payload tuple",
    ).toBe(false);
    expect(life).toContain("claimGeneration");
    expect(life).toContain("claimToken");
  });

  it("markCompleted and markFailed call sites pass a generation + token (fenced)", () => {
    // The fenced store signatures are (id, expectedGeneration, expectedToken, ...).
    // A call site that passed only an id would be an unfenced completion/failure.
    const CALL = /\.(markCompleted|markFailed)\s*\(/;
    for (const rel of walk("src", [".ts"])) {
      // The repository DEFINES these (their SQL shape is asserted by
      // contract:verify 15c/15d); we scan the CALL sites in the workers.
      if (rel === "src/db/repositories.ts") continue;
      const lines = codeLines(read(rel));
      for (let i = 0; i < lines.length; i++) {
        if (!CALL.test(lines[i]!)) continue;
        const window = lines.slice(i, i + 8).join("\n");
        expect(
          /generation/i.test(window),
          `unfenced markCompleted/markFailed (no generation) in ${rel} near: ${lines[i]!.trim()}`,
        ).toBe(true);
      }
    }
  });
});
