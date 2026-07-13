import { TransportError } from "../domain/errors.js";

/**
 * Deterministic worker-side rendering of a canonical TipTap-style draft
 * document (public.draft_versions.body_json) into e-mail HTML + plain text.
 *
 * WHY A SECOND RENDERER EXISTS. The canonical renderer lives in the UI repo
 * (src/server/render/ — React Email + sanitize-html); the worker cannot run it
 * and must not depend on it. This module is a minimal, dependency-free walker
 * over the SAME schema the UI validates (doc / paragraph / bulletList /
 * orderedList / listItem / blockquote blocks; text / hardBreak inline;
 * bold / italic / link marks — see the UI's lib/composer/canonical.ts), and it
 * follows the UI renderer's HTML conventions (dir="auto" paragraphs, inline
 * margin styles, styled links, mark nesting order) and reproduces the UI
 * plain-text renderer's exact output rules.
 *
 * CORRECTNESS GATE: byte parity with the UI renderer is NOT assumed. The send
 * executor re-verifies sha256(html)/sha256(text) of whatever this module
 * produces against the immutable intent's html_hash/text_hash BEFORE any SMTP
 * byte. Renderer divergence therefore can never send wrong content — it can
 * only FAIL the send (html_hash_mismatch / text_hash_mismatch, fail-closed).
 *
 * Safety invariants:
 *  - ALL text content is entity-escaped; nothing user-controlled is ever
 *    interpolated raw into markup.
 *  - Link hrefs pass the same policy as the UI (absolute http:/https:/mailto:
 *    only, ASCII control chars stripped first); anything else REJECTS the
 *    render (fail closed — never silently dropped or rewritten).
 *  - Unsupported node/mark types, keys or shapes REJECT the render.
 *  - Bounded: the serialized input document and each rendered output are
 *    capped at 1 MiB (the canonical drafts/draft_versions body_json CHECK).
 *  - No I/O, no remote fetches, no randomness, no clock: same input, same
 *    output, always.
 */

export interface RenderedDraftBody {
  readonly html: string;
  readonly text: string;
}

/** The canonical 1 MiB body bound (draft_versions_body_json_is_doc CHECK). */
const MAX_BODY_BYTES = 1_048_576;
const MAX_DEPTH = 20;

// ---------------------------------------------------------------------------
// Escaping + link policy
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
// Browsers strip ASCII control chars before scheme parsing ("java\tscript:").
// Strip the same range before any decision — mirrors the UI links policy.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Absolute http:/https:/mailto: only; returns the normalized href or null. */
function normalizeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0 || cleaned.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol.toLowerCase())) return null;
  return url.href;
}

// ---------------------------------------------------------------------------
// Strict structural model (rejects anything outside the canonical subset)
// ---------------------------------------------------------------------------

interface LinkMark {
  type: "link";
  href: string;
}
type Mark = { type: "bold" } | { type: "italic" } | LinkMark;

interface TextNode {
  type: "text";
  text: string;
  marks: Mark[];
}
interface HardBreakNode {
  type: "hardBreak";
  marks: Mark[];
}
type InlineNode = TextNode | HardBreakNode;

interface ParagraphNode {
  type: "paragraph";
  content: InlineNode[];
}
interface ListItemNode {
  type: "listItem";
  content: (ParagraphNode | BulletListNode | OrderedListNode)[];
}
interface BulletListNode {
  type: "bulletList";
  content: ListItemNode[];
}
interface OrderedListNode {
  type: "orderedList";
  start: number;
  content: ListItemNode[];
}
interface BlockquoteNode {
  type: "blockquote";
  content: BlockNode[];
}
type BlockNode =
  ParagraphNode | BulletListNode | OrderedListNode | BlockquoteNode;

/** Content-free structural rejection (never echoes user text). */
function invalid(detail: string): TransportError {
  return new TransportError("mime_parse_failed", `draft document: ${detail}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMarks(raw: unknown): Mark[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid("marks must be an array");
  return raw.map((m): Mark => {
    if (!isPlainObject(m)) throw invalid("mark must be an object");
    if (m.type === "bold" || m.type === "italic") return { type: m.type };
    if (m.type === "link") {
      if (!isPlainObject(m.attrs)) throw invalid("link mark requires attrs");
      const href = normalizeHref(m.attrs.href);
      if (href === null) throw invalid("unsafe or non-absolute link href");
      return { type: "link", href };
    }
    throw invalid("unsupported mark type");
  });
}

function parseInline(raw: unknown): InlineNode {
  if (!isPlainObject(raw)) throw invalid("inline node must be an object");
  if (raw.type === "text") {
    if (typeof raw.text !== "string" || raw.text.length === 0) {
      throw invalid("text node requires a non-empty string");
    }
    return { type: "text", text: raw.text, marks: parseMarks(raw.marks) };
  }
  if (raw.type === "hardBreak") {
    return { type: "hardBreak", marks: parseMarks(raw.marks) };
  }
  throw invalid("unsupported inline node type");
}

function parseBlock(raw: unknown, depth: number): BlockNode {
  if (depth > MAX_DEPTH) throw invalid("nesting too deep");
  if (!isPlainObject(raw)) throw invalid("block node must be an object");
  switch (raw.type) {
    case "paragraph": {
      const content =
        raw.content === undefined
          ? []
          : Array.isArray(raw.content)
            ? raw.content.map(parseInline)
            : null;
      if (content === null) throw invalid("paragraph content must be an array");
      return { type: "paragraph", content };
    }
    case "bulletList":
      return {
        type: "bulletList",
        content: parseListItems(raw.content, depth),
      };
    case "orderedList": {
      const attrs = raw.attrs;
      let start = 1;
      if (attrs !== undefined) {
        if (!isPlainObject(attrs)) throw invalid("orderedList attrs invalid");
        if (attrs.start !== undefined) {
          if (!Number.isInteger(attrs.start)) {
            throw invalid("orderedList start must be an integer");
          }
          start = attrs.start as number;
        }
      }
      return {
        type: "orderedList",
        start,
        content: parseListItems(raw.content, depth),
      };
    }
    case "blockquote": {
      if (!Array.isArray(raw.content) || raw.content.length === 0) {
        throw invalid("blockquote requires non-empty content");
      }
      return {
        type: "blockquote",
        content: raw.content.map((c) => parseBlock(c, depth + 1)),
      };
    }
    default:
      throw invalid("unsupported block node type");
  }
}

function parseListItems(raw: unknown, depth: number): ListItemNode[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid("list requires non-empty content");
  }
  return raw.map((item) => {
    if (!isPlainObject(item) || item.type !== "listItem") {
      throw invalid("list child must be a listItem");
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      throw invalid("listItem requires non-empty content");
    }
    const content = item.content.map((c) => {
      const block = parseBlock(c, depth + 1);
      if (block.type === "blockquote") {
        throw invalid("unsupported node type inside listItem");
      }
      return block;
    });
    return { type: "listItem", content };
  });
}

function parseDocument(input: unknown): BlockNode[] {
  if (!isPlainObject(input) || input.type !== "doc") {
    throw invalid("root must be a doc node");
  }
  if (!Array.isArray(input.content)) {
    throw invalid("doc content must be an array");
  }
  return input.content.map((b) => parseBlock(b, 1));
}

// ---------------------------------------------------------------------------
// HTML rendering (follows the UI DraftEmail conventions; escaped throughout)
// ---------------------------------------------------------------------------

const STYLE = {
  paragraph: "margin:0 0 16px 0",
  tightParagraph: "margin:0",
  list: "margin:0 0 16px 0;padding-left:24px",
  listItem: "margin:0 0 4px 0",
  blockquote:
    "border-left:3px solid #d1d5db;color:#4b5563;margin:0 0 16px 0;padding-left:12px",
  link: "color:#1d4ed8;text-decoration:underline",
} as const;

function htmlInline(node: InlineNode): string {
  if (node.type === "hardBreak") return "<br/>";
  // Marks wrap in array order, first mark innermost — same as the UI renderer.
  let out = escapeHtml(node.text);
  for (const mark of node.marks) {
    if (mark.type === "bold") out = `<strong>${out}</strong>`;
    else if (mark.type === "italic") out = `<em>${out}</em>`;
    else {
      out = `<a href="${escapeHtml(mark.href)}" style="${STYLE.link}">${out}</a>`;
    }
  }
  return out;
}

function htmlInlineContent(nodes: InlineNode[]): string {
  // A visible empty line for empty paragraphs (UI convention).
  if (nodes.length === 0) return " ";
  return nodes.map(htmlInline).join("");
}

function htmlBlock(block: BlockNode, tight: boolean): string {
  switch (block.type) {
    case "paragraph":
      return `<p dir="auto" style="${tight ? STYLE.tightParagraph : STYLE.paragraph}">${htmlInlineContent(block.content)}</p>`;
    case "bulletList":
      return `<ul style="${STYLE.list}">${block.content.map(htmlListItem).join("")}</ul>`;
    case "orderedList":
      return `<ol start="${block.start}" style="${STYLE.list}">${block.content.map(htmlListItem).join("")}</ol>`;
    case "blockquote":
      return `<blockquote style="${STYLE.blockquote}">${block.content.map((c) => htmlBlock(c, false)).join("")}</blockquote>`;
  }
}

function htmlListItem(item: ListItemNode): string {
  const inner = item.content.map((c) => htmlBlock(c, true)).join("");
  return `<li dir="auto" style="${STYLE.listItem}">${inner}</li>`;
}

// ---------------------------------------------------------------------------
// Plain-text rendering (exact port of the UI lib/composer/plain-text rules)
// ---------------------------------------------------------------------------

function linkHrefOf(marks: Mark[]): string | null {
  const link = marks.find((m) => m.type === "link");
  return link !== undefined && link.type === "link" ? link.href : null;
}

/**
 * Consecutive text nodes of the same link group so the URL is appended once:
 * "label (https://…)"; a label equal to its URL is not repeated.
 */
function textInline(nodes: InlineNode[]): string {
  let out = "";
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) break;
    if (node.type === "hardBreak") {
      out += "\n";
      index += 1;
      continue;
    }
    const href = linkHrefOf(node.marks);
    if (href === null) {
      out += node.text;
      index += 1;
      continue;
    }
    let label = "";
    while (index < nodes.length) {
      const current = nodes[index];
      if (
        current === undefined ||
        current.type !== "text" ||
        linkHrefOf(current.marks) !== href
      ) {
        break;
      }
      label += current.text;
      index += 1;
    }
    out += label === href ? label : `${label} (${href})`;
  }
  return out;
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => {
      const prefix = index === 0 ? first : rest;
      return line.length > 0 ? prefix + line : prefix.trimEnd();
    })
    .join("\n");
}

function textListItems(
  items: ListItemNode[],
  marker: (index: number) => string,
): string {
  return items
    .map((item, index) => {
      const body = item.content.map(textBlock).join("\n");
      const itemMarker = marker(index);
      return prefixLines(body, itemMarker, " ".repeat(itemMarker.length));
    })
    .join("\n");
}

function textBlock(block: BlockNode): string {
  switch (block.type) {
    case "paragraph":
      return textInline(block.content);
    case "bulletList":
      return textListItems(block.content, () => "- ");
    case "orderedList":
      return textListItems(block.content, (i) => `${block.start + i}. `);
    case "blockquote":
      return prefixLines(block.content.map(textBlock).join("\n\n"), "> ", "> ");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render a canonical draft document to { html, text }. Deterministic; throws a
 * content-free TransportError on any unsupported/unsafe structure
 * (mime_parse_failed) or bound violation (mime_limit_exceeded). Never mutates
 * its input; never performs I/O.
 */
export function renderDraftBody(bodyJson: unknown): RenderedDraftBody {
  // Input bound first (mirrors the canonical body_json CHECK), so a huge
  // document is rejected before any walking.
  if (Buffer.byteLength(JSON.stringify(bodyJson) ?? "null") > MAX_BODY_BYTES) {
    throw new TransportError(
      "mime_limit_exceeded",
      "draft document exceeds the 1 MiB body bound",
    );
  }
  const blocks = parseDocument(bodyJson);
  const html = blocks.map((b) => htmlBlock(b, false)).join("");
  const text = blocks.map(textBlock).join("\n\n");
  // Output bound (defense in depth: entity escaping can expand the input).
  if (
    Buffer.byteLength(html) > MAX_BODY_BYTES ||
    Buffer.byteLength(text) > MAX_BODY_BYTES
  ) {
    throw new TransportError(
      "mime_limit_exceeded",
      "rendered draft body exceeds the 1 MiB bound",
    );
  }
  return { html, text };
}
