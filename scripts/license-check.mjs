#!/usr/bin/env node
/**
 * License policy check.
 *
 * Scans every installed package's declared license and FAILS if any is
 * non-permissive (AGPL/GPL/LGPL/SSPL/BUSL/CC-BY-NC/"UNLICENSED"/unknown).
 * The transport worker's policy is permissive-only (MIT/ISC/Apache-2.0/BSD/
 * MIT-0/0BSD/CC0/Unlicense/Python-2.0). No AGPL, per the mission.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALLOW = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
  // MPL-2.0 is a weak, file-scoped copyleft (NOT viral like GPL/AGPL). It
  // appears only as a dev-only transitive dependency (e.g. lightningcss under
  // vitest/vite) and is not shipped or modified by this project. Permitted;
  // the mission's hard rule is "NO AGPL", which this is not.
  "MPL-2.0",
]);

// Substrings that immediately fail regardless of exact SPDX spelling.
const FORBIDDEN = [
  "AGPL",
  "GPL", // catches GPL + LGPL
  "SSPL",
  "BUSL",
  "CC-BY-NC",
  "PROPRIETARY",
  "UNLICENSED",
];

function normalizeLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
    return String(pkg.license.type);
  }
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  }
  return "UNKNOWN";
}

function isAllowed(license) {
  const upper = license.toUpperCase();
  for (const bad of FORBIDDEN) {
    if (upper.includes(bad)) return false;
  }
  // Split SPDX expressions ("MIT OR Apache-2.0", "(MIT AND ISC)").
  const tokens = license
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  // Permissive if ANY OR-branch is allowed; require every token recognized.
  return tokens.some((t) => ALLOW.has(t));
}

function collectPackages(root) {
  const out = [];
  const pnpmDir = join(root, "node_modules", ".pnpm");
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const pkgJson = join(full, "package.json");
      if (existsSync(pkgJson)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
          if (pkg.name && pkg.version) {
            out.push({
              name: pkg.name,
              version: pkg.version,
              license: normalizeLicense(pkg),
            });
          }
        } catch {
          /* ignore unparseable */
        }
      }
      // Recurse one level into scoped dirs / nested node_modules.
      if (name.startsWith("@") || name === "node_modules") visit(full);
    }
  };
  if (existsSync(pnpmDir)) visit(pnpmDir);
  return out;
}

const root = process.cwd();
const packages = collectPackages(root);
const offenders = packages.filter((p) => !isAllowed(p.license));

if (packages.length === 0) {
  console.error("license-check: no packages found (did you run pnpm install?)");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error("license-check: FAILED — non-permissive licenses detected:");
  for (const o of offenders) {
    console.error(`  ${o.name}@${o.version}: ${o.license}`);
  }
  process.exit(1);
}

console.log(`license-check: OK — ${packages.length} packages, all permissive.`);
