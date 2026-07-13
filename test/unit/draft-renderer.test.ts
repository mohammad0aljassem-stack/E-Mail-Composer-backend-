import { describe, expect, it } from "vitest";
import { TransportError } from "../../src/domain/errors.js";
import { renderDraftBody } from "../../src/mime/draft-renderer.js";

/**
 * Phase 3B C4 — deterministic worker draft renderer. The intent hash
 * verification in the send executor is the correctness gate; these tests pin
 * the renderer's determinism, escaping, link policy, structural fail-closed
 * behavior and bounds.
 */

function doc(...content: unknown[]): unknown {
  return { type: "doc", content };
}
function p(...content: unknown[]): unknown {
  return { type: "paragraph", content };
}
function t(text: string, marks?: unknown[]): unknown {
  return { type: "text", text, ...(marks !== undefined ? { marks } : {}) };
}

describe("renderDraftBody — happy-path structure", () => {
  it("renders paragraph / hardBreak / bold / italic / link", () => {
    const { html, text } = renderDraftBody(
      doc(
        p(
          t("plain "),
          t("bold", [{ type: "bold" }]),
          { type: "hardBreak" },
          t("italic", [{ type: "italic" }]),
          t(" "),
          t("Anthropic", [
            { type: "link", attrs: { href: "https://example.com/a" } },
          ]),
        ),
      ),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<br/>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://example.com/a"');
    expect(html).toContain('dir="auto"');
    expect(text).toBe("plain bold\nitalic Anthropic (https://example.com/a)");
  });

  it("marks nest in array order (first mark innermost), like the UI renderer", () => {
    const { html } = renderDraftBody(
      doc(p(t("x", [{ type: "italic" }, { type: "bold" }]))),
    );
    expect(html).toContain("<strong><em>x</em></strong>");
  });

  it("a link label equal to its URL is not repeated in the text output", () => {
    const { text } = renderDraftBody(
      doc(
        p(
          t("https://example.com/", [
            { type: "link", attrs: { href: "https://example.com/" } },
          ]),
        ),
      ),
    );
    expect(text).toBe("https://example.com/");
  });

  it("renders bullet/ordered lists and blockquotes with UI text markers", () => {
    const li = (s: string): unknown => ({
      type: "listItem",
      content: [p(t(s))],
    });
    const { html, text } = renderDraftBody(
      doc(
        { type: "bulletList", content: [li("one"), li("two")] },
        { type: "orderedList", attrs: { start: 3 }, content: [li("three")] },
        { type: "blockquote", content: [p(t("quoted"))] },
      ),
    );
    expect(html).toContain("<ul");
    expect(html).toContain('<ol start="3"');
    expect(html).toContain("<blockquote");
    expect(html).toContain('<li dir="auto"');
    expect(text).toBe("- one\n- two\n\n3. three\n\n> quoted");
  });

  it("renders an empty paragraph as a visible empty line (UI convention)", () => {
    const { html } = renderDraftBody(doc({ type: "paragraph" }));
    expect(html).toContain("> </p>");
  });
});

describe("renderDraftBody — escaping (nothing raw ever reaches markup)", () => {
  it("escapes script tags, quotes and entities in text content", () => {
    const hostile = `<script>alert("x")</script> & 'quotes'`;
    const { html, text } = renderDraftBody(doc(p(t(hostile))));
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;quotes&#39;");
    // Plain text is not markup: content passes through unescaped.
    expect(text).toBe(hostile);
  });

  it("quote characters never survive raw inside a link href attribute", () => {
    const { html } = renderDraftBody(
      doc(
        p(
          t("x", [
            { type: "link", attrs: { href: 'https://example.com/?q="a"' } },
          ]),
        ),
      ),
    );
    // URL normalization percent-encodes the quotes; the attribute is then
    // additionally entity-escaped — either way no raw quote can break out.
    expect(html).toContain("%22a%22");
    expect(html).not.toContain('?q="a"');
  });
});

describe("renderDraftBody — link policy fails closed", () => {
  const bad = [
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,x",
    "//example.com/x",
    "relative/path",
    "",
  ];
  for (const href of bad) {
    it(`rejects unsafe href (${JSON.stringify(href).slice(0, 24)})`, () => {
      expect(() =>
        renderDraftBody(doc(p(t("x", [{ type: "link", attrs: { href } }])))),
      ).toThrowError(TransportError);
    });
  }

  it("accepts mailto: links", () => {
    const { html } = renderDraftBody(
      doc(p(t("mail", [{ type: "link", attrs: { href: "mailto:a@b.c" } }]))),
    );
    expect(html).toContain('href="mailto:a@b.c"');
  });
});

describe("renderDraftBody — structural fail-closed", () => {
  it("rejects a non-doc root", () => {
    expect(() => renderDraftBody({ type: "paragraph" })).toThrowError(
      TransportError,
    );
    expect(() => renderDraftBody(null)).toThrowError(TransportError);
  });

  it("rejects unsupported block, inline and mark types (never drops them)", () => {
    expect(() => renderDraftBody(doc({ type: "table" }))).toThrowError(
      TransportError,
    );
    expect(() => renderDraftBody(doc(p({ type: "image" })))).toThrowError(
      TransportError,
    );
    expect(() =>
      renderDraftBody(doc(p(t("x", [{ type: "underline" }])))),
    ).toThrowError(TransportError);
  });

  it("rejects nesting deeper than the depth bound", () => {
    let node: unknown = p(t("x"));
    for (let i = 0; i < 25; i++) {
      node = { type: "blockquote", content: [node] };
    }
    expect(() => renderDraftBody(doc(node))).toThrowError(TransportError);
  });

  it("rejects an empty text node", () => {
    expect(() => renderDraftBody(doc(p(t(""))))).toThrowError(TransportError);
  });
});

describe("renderDraftBody — bounds + determinism", () => {
  it("rejects a document over the 1 MiB body bound (mime_limit_exceeded)", () => {
    const big = doc(p(t("y".repeat(1_100_000))));
    try {
      renderDraftBody(big);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("mime_limit_exceeded");
    }
  });

  it("double render of the same document is byte-identical", () => {
    const document = doc(
      p(
        t("Grüße — مرحبا "),
        t("bold", [{ type: "bold" }]),
        t("link", [{ type: "link", attrs: { href: "https://example.com/" } }]),
      ),
      { type: "blockquote", content: [p(t("q1")), p(t("q2"))] },
    );
    const a = renderDraftBody(document);
    const b = renderDraftBody(document);
    expect(a.html).toBe(b.html);
    expect(a.text).toBe(b.text);
  });
});
