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
