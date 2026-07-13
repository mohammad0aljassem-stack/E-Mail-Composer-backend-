import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  SyncExecutor,
  enqueueSyncFollowUp,
  type SyncResult,
} from "../../src/workers/sync-executor.js";
import { TransportError } from "../../src/domain/errors.js";
import {
  FakeAuditRepo,
  FakeFolderRepo,
  FakeMailboxRepo,
  FakeMessageRepo,
} from "../fakes/in-memory-repos.js";
import { FakeImapServer } from "../fakes/fake-imap.js";
import { FakeSmtpClient } from "../fakes/fake-smtp.js";
import { FakeProviderFactory } from "../fakes/fake-provider-factory.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  sendableMailbox,
  MAILBOX_ID,
  WORKSPACE_ID,
} from "../helpers/send-fixtures.js";

function makeHarness(options?: {
  batchSize?: number;
  enabled?: boolean;
  globalKillSwitch?: boolean;
}) {
  const mailboxes = new FakeMailboxRepo();
  mailboxes.rows.set(
    MAILBOX_ID,
    sendableMailbox({ enabled: options?.enabled ?? true }),
  );
  const folders = new FakeFolderRepo();
  const messages = new FakeMessageRepo();
  const audit = new FakeAuditRepo();
  const server = new FakeImapServer();
  server.addFolder({ name: "INBOX", role: "inbox", uidvalidity: 10n });
  server.addFolder({ name: "Sent", role: "sent" });
  const factory = new FakeProviderFactory(server, new FakeSmtpClient());
  const logger = new JsonLogger({ level: "error", sink: { write: () => {} } });
  const exec = new SyncExecutor({
    mailboxes,
    folders,
    messages,
    audit,
    providerFactory: factory,
    clock: new TestClock(),
    logger,
    config: {
      batchSize: options?.batchSize ?? 200,
      globalKillSwitch: options?.globalKillSwitch ?? false,
    },
  });
  return { exec, folders, messages, audit, server, mailboxes, factory };
}

const initialJob = {
  workspaceId: WORKSPACE_ID,
  mailboxId: MAILBOX_ID,
  folder: "INBOX",
  mode: "initial" as const,
};
const incrementalJob = { ...initialJob, mode: "incremental" as const };

describe("SyncExecutor", () => {
  // Test 1: initial sync discovers folders + roles.
  it("discovers folders and roles on initial sync", async () => {
    const h = makeHarness();
    await h.exec.execute(initialJob);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(inbox?.role).toBe("inbox");
    expect(
      await h.folders.getByMailboxAndName(MAILBOX_ID, "Sent"),
    ).not.toBeNull();
  });

  // Test 2: initial sync persists message metadata.
  it("persists message metadata on initial sync", async () => {
    const h = makeHarness();
    h.server.seedMessage("INBOX", { messageId: "<m1@x>", subject: "A" });
    h.server.seedMessage("INBOX", { messageId: "<m2@x>", subject: "B" });
    const res = await h.exec.execute(initialJob);
    expect(res.persisted).toBe(2);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(await h.messages.countByFolder(inbox!.id)).toBe(2);
  });

  // Test 3: the cursor is advanced only AFTER messages are persisted.
  it("advances the folder cursor to the max persisted UID", async () => {
    const h = makeHarness();
    await h.exec.execute(initialJob); // discover
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    h.server.seedMessage("INBOX", { messageId: "<m2@x>" });
    await h.exec.execute(incrementalJob);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(inbox?.lastSeenUid).toBe(2n);
    expect(inbox?.uidvalidity).toBe(10n);
  });

  // Test 4 + 5: incremental fetches only new UIDs; repeated jobs don't dupe.
  it("fetches only new messages and is idempotent on repeat", async () => {
    const h = makeHarness();
    await h.exec.execute(initialJob);
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    await h.exec.execute(incrementalJob);
    // Repeat the same job: nothing new; no duplicate rows.
    const res2 = await h.exec.execute(incrementalJob);
    expect(res2.persisted).toBe(0);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(await h.messages.countByFolder(inbox!.id)).toBe(1);

    // A new message arrives → only it is fetched.
    h.server.seedMessage("INBOX", { messageId: "<m2@x>" });
    const res3 = await h.exec.execute(incrementalJob);
    expect(res3.persisted).toBe(1);
    expect(await h.messages.countByFolder(inbox!.id)).toBe(2);
  });

  // Test 6: re-running an identical job never creates duplicate message rows.
  it("deterministic upsert keys prevent duplicates across restarts", async () => {
    const h = makeHarness();
    await h.exec.execute(initialJob);
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    await h.exec.execute(incrementalJob);
    await h.exec.execute(incrementalJob);
    await h.exec.execute(incrementalJob);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(await h.messages.countByFolder(inbox!.id)).toBe(1);
  });

  // Test 7 + 8: UIDVALIDITY change resets the cursor + audits, no old-namespace mixing.
  it("detects a UIDVALIDITY change and invalidates the old cursor", async () => {
    const h = makeHarness();
    await h.exec.execute(initialJob);
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    await h.exec.execute(incrementalJob);

    // Server resets UIDVALIDITY.
    h.server.changeUidValidity("INBOX", 20n);
    const res = await h.exec.execute(incrementalJob);
    expect(res.uidValidityChanged).toBe(true);
    expect(res.needsFollowUp).toBe(true);
    expect(res.persisted).toBe(0); // nothing mixed into the old namespace

    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(inbox?.uidvalidity).toBe(20n);
    expect(inbox?.lastSeenUid).toBe(0n); // cursor invalidated
    expect(
      h.audit.events.some((e) => e.eventType === "uidvalidity_changed"),
    ).toBe(true);
  });

  // Test 9: a disabled mailbox is refused (fail-closed).
  it("refuses to sync a disabled mailbox", async () => {
    const h = makeHarness({ enabled: false });
    await expect(h.exec.execute(initialJob)).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  // C6: the global kill switch skips content-free with ZERO IMAP connects,
  // even for an already-enqueued job.
  it("skips under the global kill switch without any IMAP connect", async () => {
    const h = makeHarness({ globalKillSwitch: true });
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    const res = await h.exec.execute(initialJob);
    expect(res).toEqual({
      persisted: 0,
      uidValidityChanged: false,
      needsFollowUp: false,
    });
    expect(h.factory.createdCount).toBe(0); // no provider, no IMAP connect
    expect(h.messages.rows.size).toBe(0);
  });

  // C9: a References header carried by the provider is persisted (threading).
  it("persists the References header from a fetched message", async () => {
    const h = makeHarness();
    h.server.seedMessage("INBOX", {
      messageId: "<reply-1@x>",
      references: "<root@x> <mid@x>",
    });
    await h.exec.execute(initialJob);
    const stored = [...h.messages.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.referencesHeader).toBe("<root@x> <mid@x>");
  });

  // Test 10 + 11: a full batch signals a follow-up; cursor tracks max uid.
  it("signals a follow-up when a full batch is returned", async () => {
    const h = makeHarness({ batchSize: 2 });
    await h.exec.execute(initialJob);
    h.server.seedMessage("INBOX", { messageId: "<m1@x>" });
    h.server.seedMessage("INBOX", { messageId: "<m2@x>" });
    h.server.seedMessage("INBOX", { messageId: "<m3@x>" });
    const res = await h.exec.execute(incrementalJob);
    expect(res.persisted).toBe(2);
    expect(res.needsFollowUp).toBe(true);
    const inbox = await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX");
    expect(inbox?.lastSeenUid).toBe(2n);
    // The follow-up picks up the remainder.
    const res2 = await h.exec.execute(incrementalJob);
    expect(res2.persisted).toBe(1);
    expect(
      (await h.folders.getByMailboxAndName(MAILBOX_ID, "INBOX"))?.lastSeenUid,
    ).toBe(3n);
  });
});

// C4: the sync_mailbox handler acts on needsFollowUp so a multi-batch backlog
// drains instead of stalling. Tested via the handler helper the worker calls.
describe("enqueueSyncFollowUp (sync_mailbox handler)", () => {
  const logger = new JsonLogger({ level: "error", sink: { write: () => {} } });
  const job = {
    workspaceId: WORKSPACE_ID,
    mailboxId: MAILBOX_ID,
    folder: "INBOX",
    mode: "initial" as const,
  };
  const result = (needsFollowUp: boolean): SyncResult => ({
    persisted: 0,
    uidValidityChanged: false,
    needsFollowUp,
  });

  it("enqueues exactly one incremental follow-up when needsFollowUp is true", async () => {
    const enqueued: unknown[] = [];
    const followedUp = await enqueueSyncFollowUp({
      result: result(true),
      job,
      enqueueSync: (j) => {
        enqueued.push(j);
        return Promise.resolve("job-1");
      },
      logger,
    });
    expect(followedUp).toBe(true);
    expect(enqueued).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        mailboxId: MAILBOX_ID,
        folder: "INBOX",
        mode: "incremental",
      },
    ]);
  });

  it("enqueues nothing when needsFollowUp is false", async () => {
    const enqueued: unknown[] = [];
    const followedUp = await enqueueSyncFollowUp({
      result: result(false),
      job,
      enqueueSync: (j) => {
        enqueued.push(j);
        return Promise.resolve("job-1");
      },
      logger,
    });
    expect(followedUp).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});

// Test 12: IDLE wake-up returns a signal (caller enqueues an incremental sync).
describe("IMAP IDLE wake-up", () => {
  it("surfaces a queued IDLE signal as a wake-up", async () => {
    const server = new FakeImapServer();
    server.addFolder({ name: "INBOX", role: "inbox" });
    server.queueIdleSignal("INBOX", { kind: "exists" });
    const factory = new FakeProviderFactory(server, new FakeSmtpClient());
    const provider = await factory.create(sendableMailbox());
    const change = await provider.waitForChanges("INBOX", 1000);
    expect(change?.kind).toBe("exists");
    // A timeout with no signal returns null (bounded periodic fallback).
    const none = await provider.waitForChanges("INBOX", 1);
    expect(none).toBeNull();
  });
});
