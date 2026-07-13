import { describe, expect, it, vi } from "vitest";
import { RandomIdGenerator } from "../../src/domain/ids.js";
import { SystemClock } from "../../src/domain/clock.js";
import {
  SmtpAmbiguousError,
  SmtpPreDataError,
  TransportError,
} from "../../src/domain/errors.js";
import { Heartbeat } from "../../src/observability/heartbeat.js";
import { MutationExecutor } from "../../src/workers/mutation-executor.js";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  FakeAuditRepo,
  FakeHeartbeatRepo,
  FakeMailboxRepo,
} from "../fakes/in-memory-repos.js";
import { FakeImapServer } from "../fakes/fake-imap.js";
import { FakeSmtpClient } from "../fakes/fake-smtp.js";
import { FakeProviderFactory } from "../fakes/fake-provider-factory.js";
import {
  MAILBOX_ID,
  sendableMailbox,
  WORKSPACE_ID,
} from "../helpers/send-fixtures.js";

describe("RandomIdGenerator", () => {
  it("produces unique uuids and RFC5322 message ids", () => {
    const g = new RandomIdGenerator();
    expect(g.uuid()).not.toBe(g.uuid());
    expect(g.messageId("mail.example.com")).toMatch(
      /^<[0-9a-f-]+@mail\.example\.com>$/,
    );
    // A hostile domain is replaced with a safe default.
    expect(g.messageId("bad domain>")).toMatch(/@mail\.local>$/);
    expect(g.workerId()).toMatch(/^worker-/);
  });
});

describe("errors + clock", () => {
  it("SystemClock returns a Date and ms", () => {
    const c = new SystemClock();
    expect(c.now()).toBeInstanceOf(Date);
    expect(typeof c.nowMs()).toBe("number");
  });

  it("SMTP error subclasses carry constant-shape context and never retry", () => {
    const pre = new SmtpPreDataError("x", { command: "RCPT" });
    expect(pre.code).toBe("send_pre_data_failed");
    expect(pre.retryable).toBe(false);
    expect(pre.context.command).toBe("RCPT");
    const preNoCtx = new SmtpPreDataError("x");
    expect(preNoCtx.context).toEqual({});
    const amb = new SmtpAmbiguousError(
      "y",
      { code: "ETIMEDOUT" },
      new Error("cause"),
    );
    expect(amb.code).toBe("send_ambiguous");
    expect(amb.retryable).toBe(false);
    const base = new TransportError("not_found", "m", { retryable: true });
    expect(base.retryable).toBe(true);
    expect(Object.isFrozen(base.context)).toBe(true);
  });
});

describe("Heartbeat", () => {
  it("writes an immediate content-free beat on start and on stop", async () => {
    const repo = new FakeHeartbeatRepo();
    const hb = new Heartbeat({
      heartbeats: repo,
      clock: { now: () => new Date(), nowMs: () => 0 },
      logger: new JsonLogger({ level: "error", sink: { write: () => {} } }),
      workerId: "w1",
      intervalMs: 10_000,
    });
    hb.start();
    await vi.waitFor(() => expect(repo.beats.length).toBeGreaterThan(0));
    await hb.stop();
    expect(repo.beats.some((b) => b.state === "stopped")).toBe(true);
  });
});

describe("MutationExecutor", () => {
  function makeMutationHarness(options?: { globalKillSwitch?: boolean }) {
    const mailboxes = new FakeMailboxRepo();
    mailboxes.rows.set(MAILBOX_ID, sendableMailbox());
    const server = new FakeImapServer();
    server.addFolder({ name: "INBOX", role: "inbox" });
    const uid = server.seedMessage("INBOX", { messageId: "<m@x>" });
    const factory = new FakeProviderFactory(server, new FakeSmtpClient());
    const audit = new FakeAuditRepo();
    const exec = new MutationExecutor({
      mailboxes,
      audit,
      providerFactory: factory,
      logger: new JsonLogger({ level: "error", sink: { write: () => {} } }),
      config: { globalKillSwitch: options?.globalKillSwitch ?? false },
    });
    return { exec, server, factory, audit, uid };
  }

  it("applies a folder mutation via the provider", async () => {
    const h = makeMutationHarness();
    await h.exec.execute({
      workspaceId: WORKSPACE_ID,
      mailboxId: MAILBOX_ID,
      mutation: {
        kind: "add_flags",
        folder: "INBOX",
        uid: h.uid,
        flags: ["\\Seen"],
      },
    });
    expect(
      h.server
        .folder("INBOX")
        .messages.get(h.uid.toString())
        ?.flags.has("\\Seen"),
    ).toBe(true);
    expect(h.audit.events.some((e) => e.eventType === "mutation_applied")).toBe(
      true,
    );
  });

  // C6: the global kill switch skips content-free with ZERO IMAP connects.
  it("skips under the global kill switch without any IMAP connect", async () => {
    const h = makeMutationHarness({ globalKillSwitch: true });
    await h.exec.execute({
      workspaceId: WORKSPACE_ID,
      mailboxId: MAILBOX_ID,
      mutation: {
        kind: "add_flags",
        folder: "INBOX",
        uid: h.uid,
        flags: ["\\Seen"],
      },
    });
    expect(h.factory.createdCount).toBe(0); // no provider, no IMAP connect
    expect(
      h.server
        .folder("INBOX")
        .messages.get(h.uid.toString())
        ?.flags.has("\\Seen"),
    ).toBe(false);
    expect(h.audit.events).toHaveLength(0);
  });
});
