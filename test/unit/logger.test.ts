import { describe, expect, it } from "vitest";
import { JsonLogger, redactFields } from "../../src/observability/logger.js";

function capturing(): {
  lines: string[];
  sink: { write: (l: string) => void };
} {
  const lines: string[] = [];
  return { lines, sink: { write: (l) => lines.push(l) } };
}

describe("content-free logger", () => {
  it("redacts known-sensitive field keys", () => {
    const out = redactFields({
      imapPassword: "hunter2",
      smtp_pass: "abc",
      authorization: "Bearer x",
      ciphertext: "deadbeef",
      body_html: "<p>secret</p>",
      connection_string: "postgres://u:p@h/db",
      mailboxId: "mb-1",
      count: 3,
    });
    expect(out.imapPassword).toBe("[redacted]");
    expect(out.smtp_pass).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.ciphertext).toBe("[redacted]");
    expect(out.body_html).toBe("[redacted]");
    expect(out.connection_string).toBe("[redacted]");
    // Non-sensitive fields pass through.
    expect(out.mailboxId).toBe("mb-1");
    expect(out.count).toBe(3);
  });

  // Test 37 (unit portion): emitted log lines never contain body/credential data.
  it("never emits secret values through the logger", () => {
    const { lines, sink } = capturing();
    const log = new JsonLogger({ level: "info", sink });
    log.info("smtp_send_started", {
      imapPassword: "hunter2",
      body: "the secret body text",
      messageId: "<id@h>",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("hunter2");
    expect(joined).not.toContain("the secret body text");
    expect(joined).toContain("[redacted]");
    expect(joined).toContain("<id@h>");
  });

  it("truncates over-long values", () => {
    const { lines, sink } = capturing();
    const log = new JsonLogger({ level: "info", sink });
    log.info("x", { note: "a".repeat(1000) });
    expect(lines[0]).toContain("[truncated]");
  });

  it("child bindings are also redacted", () => {
    const { lines, sink } = capturing();
    const log = new JsonLogger({ level: "info", sink }).child({
      token: "abc",
      component: "send",
    });
    log.info("hello");
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.token).toBe("[redacted]");
    expect(rec.component).toBe("send");
  });
});
