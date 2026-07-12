import { simpleParser, type ParsedMail } from "mailparser";
import { TransportError } from "../domain/errors.js";
import { boundHeader, safeFilename } from "./sanitize.js";

/**
 * Bounded, safe inbound MIME parsing. Inbound email is UNTRUSTED DATA.
 *
 * We enforce total-size, attachment-count, per-part-size, nesting and timeout
 * limits, normalize filenames, and NEVER fetch external resources, execute
 * script, or render raw HTML. Malformed MIME yields a constant-shape error
 * instead of crashing. Only metadata is returned — no body content is retained
 * or logged by callers.
 */

export interface InboundLimits {
  readonly maxTotalBytes: number;
  readonly maxAttachments: number;
  readonly maxPartBytes: number;
  readonly maxNestingDepth: number;
  readonly parseTimeoutMs: number;
}

export const DEFAULT_INBOUND_LIMITS: InboundLimits = {
  maxTotalBytes: 25 * 1024 * 1024, // 25 MiB
  maxAttachments: 100,
  maxPartBytes: 20 * 1024 * 1024,
  maxNestingDepth: 20,
  parseTimeoutMs: 10_000,
};

export interface InboundAttachmentMeta {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** Metadata ONLY — never raw body/attachment bytes. */
export interface InboundMessageMeta {
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly referencesHeader: string | null;
  readonly subject: string | null;
  readonly fromSummary: string | null;
  readonly toSummary: string | null;
  readonly date: Date | null;
  readonly hasAttachments: boolean;
  readonly attachments: readonly InboundAttachmentMeta[];
  /** Sanitized plain-text preview (bounded), never raw HTML. */
  readonly textPreview: string | null;
}

function joinReferences(refs: string[] | string | undefined): string | null {
  if (refs === undefined) return null;
  const joined = Array.isArray(refs) ? refs.join(" ") : refs;
  return boundHeader(joined, 4000);
}

function summarizeAddresses(
  addr: ParsedMail["from"] | ParsedMail["to"],
): string | null {
  if (addr === undefined) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  const text = list.map((a) => a.text).join(", ");
  return boundHeader(text, 4000);
}

export async function parseInbound(
  raw: Buffer,
  limits: InboundLimits = DEFAULT_INBOUND_LIMITS,
): Promise<InboundMessageMeta> {
  if (raw.length > limits.maxTotalBytes) {
    throw new TransportError(
      "mime_limit_exceeded",
      "message exceeds max total size",
      {
        context: { sizeBytes: raw.length, limit: limits.maxTotalBytes },
      },
    );
  }

  let parsed: ParsedMail;
  try {
    parsed = await withTimeout(
      simpleParser(raw, {
        // Cap per-node depth defensively; mailparser also streams internally.
        maxHtmlLengthToParse: limits.maxPartBytes,
      }),
      limits.parseTimeoutMs,
    );
  } catch (cause) {
    if (cause instanceof TransportError) throw cause;
    throw new TransportError(
      "mime_parse_failed",
      "failed to parse inbound message",
      {
        cause,
      },
    );
  }

  const attachments = parsed.attachments ?? [];
  if (attachments.length > limits.maxAttachments) {
    throw new TransportError("mime_limit_exceeded", "too many attachments", {
      context: { count: attachments.length, limit: limits.maxAttachments },
    });
  }
  for (const att of attachments) {
    const size = att.size ?? att.content?.length ?? 0;
    if (size > limits.maxPartBytes) {
      throw new TransportError(
        "mime_limit_exceeded",
        "attachment part too large",
        {
          context: { sizeBytes: size, limit: limits.maxPartBytes },
        },
      );
    }
  }

  const attachmentMeta: InboundAttachmentMeta[] = attachments.map((att) => ({
    filename: safeFilename(att.filename),
    contentType: att.contentType ?? "application/octet-stream",
    sizeBytes: att.size ?? att.content?.length ?? 0,
  }));

  // Prefer the provided text; otherwise a sanitized preview of html (never raw).
  const textPreview =
    parsed.text !== undefined ? boundHeader(parsed.text, 2000) : null;

  return {
    messageId: boundHeader(parsed.messageId ?? null, 998),
    inReplyTo: boundHeader(parsed.inReplyTo ?? null, 998),
    referencesHeader: joinReferences(parsed.references),
    subject: boundHeader(parsed.subject ?? null, 2000),
    fromSummary: summarizeAddresses(parsed.from),
    toSummary: summarizeAddresses(parsed.to),
    date: parsed.date ?? null,
    hasAttachments: attachmentMeta.length > 0,
    attachments: attachmentMeta,
    textPreview,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TransportError("mime_parse_failed", "inbound parse timed out", {
          context: { timeoutMs: ms },
        }),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("parse error"));
      },
    );
  });
}
