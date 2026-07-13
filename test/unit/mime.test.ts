import { describe, expect, it } from "vitest";
import {
  DEFAULT_INBOUND_LIMITS,
  parseInbound,
} from "../../src/mime/inbound-parser.js";
import { htmlToSafeText, safeFilename } from "../../src/mime/sanitize.js";
import { TransportError } from "../../src/domain/errors.js";
import {
  buildOutboundMime,
  computeAttachmentManifest,
  sha256Hex,
} from "../../src/mime/outbound-builder.js";

describe("inbound MIME safety", () => {
  it("parses a well-formed message into metadata only", async () => {
    const raw = Buffer.from(
      [
        "Message-ID: <abc@ex.com>",
        "In-Reply-To: <parent@ex.com>",
        "References: <r1@ex.com> <r2@ex.com>",
        "Subject: Hello",
        "From: Alice <alice@ex.com>",
        "To: bob@ex.com",
        "",
        "body text",
      ].join("\r\n"),
      "utf8",
    );
    const meta = await parseInbound(raw);
    expect(meta.messageId).toBe("<abc@ex.com>");
    expect(meta.inReplyTo).toBe("<parent@ex.com>");
    expect(meta.referencesHeader).toContain("<r1@ex.com>");
    expect(meta.subject).toBe("Hello");
    expect(meta.fromSummary).toContain("alice@ex.com");
  });

  it("enforces the total-size limit", async () => {
    const raw = Buffer.alloc(1024, 0x41);
    await expect(
      parseInbound(raw, { ...DEFAULT_INBOUND_LIMITS, maxTotalBytes: 100 }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("enforces the attachment-count limit", async () => {
    const parts = [
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "body",
    ];
    // Two attachments but a limit of 1 → rejected.
    for (let i = 0; i < 2; i++) {
      parts.push(
        "--b",
        `Content-Type: application/octet-stream`,
        `Content-Disposition: attachment; filename="f${i}.bin"`,
        "",
        "AAAA",
      );
    }
    parts.push("--b--", "");
    const raw = Buffer.from(parts.join("\r\n"), "utf8");
    await expect(
      parseInbound(raw, { ...DEFAULT_INBOUND_LIMITS, maxAttachments: 1 }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("does not crash on malformed MIME", async () => {
    const raw = Buffer.from("this is not a valid @@@ mime message", "utf8");
    const meta = await parseInbound(raw);
    // Returns metadata (mostly null) rather than throwing.
    expect(meta.hasAttachments).toBe(false);
  });

  it("preserves threading headers", async () => {
    const raw = Buffer.from(
      "Message-ID: <m@x>\r\nIn-Reply-To: <p@x>\r\nReferences: <a@x>\r\n\r\nx",
      "utf8",
    );
    const meta = await parseInbound(raw);
    expect(meta.messageId).toBe("<m@x>");
    expect(meta.inReplyTo).toBe("<p@x>");
    expect(meta.referencesHeader).toContain("<a@x>");
  });
});

describe("filename + html sanitization", () => {
  it("strips path traversal and control chars from filenames", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..\\..\\win.ini")).toBe("win.ini");
    expect(safeFilename(null)).toBe("attachment");
    expect(safeFilename("....")).toBe("attachment");
  });

  it("extracts safe text from html without rendering or fetching", () => {
    const text = htmlToSafeText(
      "<script>alert(1)</script><p>Hello <b>world</b></p>",
    );
    expect(text).toBe("Hello world");
    expect(text).not.toContain("alert");
  });
});

describe("outbound MIME + hashing", () => {
  it("embeds the pre-generated Message-ID and hashes bodies", async () => {
    const built = await buildOutboundMime({
      messageId: "<fixed@ex.com>",
      sender: "a@ex.com",
      recipients: { to: ["b@ex.com"] },
      subject: "s",
      html: "<p>hi</p>",
      text: "hi",
      attachments: [],
    });
    expect(built.raw.toString("utf8")).toContain("Message-ID: <fixed@ex.com>");
    expect(built.htmlHash).toBe(sha256Hex("<p>hi</p>"));
    expect(built.textHash).toBe(sha256Hex("hi"));
  });

  it("builds a message with cc/bcc, attachments, custom headers", async () => {
    const built = await buildOutboundMime({
      messageId: "<m@ex.com>",
      sender: "a@ex.com",
      recipients: { to: ["b@ex.com"], cc: ["c@ex.com"], bcc: ["d@ex.com"] },
      subject: "s",
      html: null,
      text: "hi",
      attachments: [
        {
          filename: "a.txt",
          contentType: "text/plain",
          content: Buffer.from("aaa"),
          contentId: "cid-1",
        },
      ],
      headers: { "X-Custom": "1" },
    });
    expect(built.htmlHash).toBeNull();
    expect(built.textHash).not.toBeNull();
    expect(built.attachmentManifest[0]?.contentId).toBe("cid-1");
    expect(built.raw.toString("utf8")).toContain("Cc: c@ex.com");
  });

  it("pins the Date header when an explicit date is provided (C5)", async () => {
    const date = new Date("2026-07-01T10:00:00Z");
    const built = await buildOutboundMime(
      {
        messageId: "<pin@ex.com>",
        sender: "a@ex.com",
        recipients: { to: ["b@ex.com"] },
        subject: "s",
        html: "<p>hi</p>",
        text: "hi",
        attachments: [],
      },
      { date },
    );
    expect(built.raw.toString("utf8")).toContain(
      "Date: Wed, 01 Jul 2026 10:00:00 +0000",
    );
  });

  // C5 PROVEN EQUIVALENCE: with the same inputs AND the same pinned date, two
  // independent builds are identical except for MailComposer's random
  // multipart boundary strings. This is the documented guarantee the restart
  // Sent-copy rebuild relies on (the in-run submit/append path shares ONE
  // Buffer and is byte-exact — pinned in the send-executor suite).
  it("rebuild with pinned date differs ONLY in the multipart boundary", async () => {
    const message = {
      messageId: "<same@ex.com>",
      sender: "a@ex.com",
      recipients: { to: ["b@ex.com"], cc: ["c@ex.com"] },
      subject: "Rebuild equivalence",
      html: "<p>bodyÄ</p>",
      text: "bodyÄ",
      attachments: [],
    };
    const date = new Date("2026-07-01T10:00:00Z");
    const a = await buildOutboundMime(message, { date });
    const b = await buildOutboundMime(message, { date });

    const boundaryOf = (raw: Buffer): string => {
      const m = /boundary="([^"]+)"/.exec(raw.toString("utf8"));
      expect(m).not.toBeNull();
      return m![1]!;
    };
    const ba = boundaryOf(a.raw);
    const bb = boundaryOf(b.raw);

    // Normalize each build by erasing its own boundary token; the remainder
    // must be byte-identical.
    const normalize = (raw: Buffer, boundary: string): string =>
      raw.toString("utf8").split(boundary).join("BOUNDARY");
    expect(normalize(a.raw, ba)).toBe(normalize(b.raw, bb));

    // And the identity-bearing headers are byte-identical as-is.
    const headerLines = (raw: Buffer): string[] =>
      raw
        .toString("utf8")
        .split("\r\n")
        .filter((l) => /^(Message-ID|Date|From|To|Cc|Subject):/i.test(l));
    expect(headerLines(a.raw)).toEqual(headerLines(b.raw));
    expect(headerLines(a.raw)).toHaveLength(6);
  });

  it("computes an order-stable attachment manifest", () => {
    const manifest = computeAttachmentManifest([
      {
        filename: "a.txt",
        contentType: "text/plain",
        content: Buffer.from("aaa"),
      },
      {
        filename: "b.txt",
        contentType: "text/plain",
        content: Buffer.from("bbbb"),
      },
    ]);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toMatchObject({
      filename: "a.txt",
      sizeBytes: 3,
      sha256: sha256Hex("aaa"),
    });
    expect(manifest[1]?.sizeBytes).toBe(4);
  });
});
