/**
 * Deterministic, content-free sanitization helpers for UNTRUSTED inbound data.
 * Inbound email is treated as DATA, never instructions. We never render raw
 * inbound HTML and never fetch external resources; these helpers only normalize
 * for safe *storage of metadata* and safe future display.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\x00-\\x1f\\x7f]", "g");

/**
 * Normalize an attachment filename to a safe, bounded, path-traversal-free
 * value. Strips directory components, control chars, and unsafe characters.
 * Never throws.
 */
export function safeFilename(raw: string | null | undefined): string {
  if (raw === undefined || raw === null) return "attachment";
  // Drop any path components (both separators) — no traversal.
  const base = raw.split(/[\\/]/).pop() ?? "attachment";
  const cleaned = base
    .replace(CONTROL_CHARS, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "") // no leading dots (hidden / "..")
    .trim();
  const bounded = cleaned.slice(0, 200);
  return bounded.length > 0 ? bounded : "attachment";
}

/**
 * Produce a plain-text fallback from an HTML string WITHOUT rendering it: strip
 * tags, drop script/style contents, decode a few common entities, collapse
 * whitespace. No DOM, no network, no script execution.
 */
export function htmlToSafeText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

/** Truncate a header-ish string to a safe stored length (no content leakage). */
export function boundHeader(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}
