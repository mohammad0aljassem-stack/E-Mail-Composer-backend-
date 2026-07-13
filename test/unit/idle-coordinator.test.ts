import { describe, expect, it, vi } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  IdleCoordinator,
  type IdleCoordinatorDeps,
} from "../../src/workers/idle-coordinator.js";
import { plannedRegistrations } from "../../src/entrypoints/registration-plan.js";
import type { SyncMailboxJob } from "../../src/queues/queue-config.js";
import type { MailboxRow } from "../../src/domain/models.js";
import type { ImapSessionProvider } from "../../src/providers/mail-provider.js";
import { FakeMailboxRepo } from "../fakes/in-memory-repos.js";
import { FakeImapServer } from "../fakes/fake-imap.js";
import { FakeSmtpClient } from "../fakes/fake-smtp.js";
import { FakeProviderFactory } from "../fakes/fake-provider-factory.js";
import { sendableMailbox } from "../helpers/send-fixtures.js";

/**
 * Phase 3B C7 — IdleCoordinator. Deterministic: fake IMAP (in-repo, no
 * network), injectable random + sleep, construction counters proving the
 * SMTP capability is never touched, and a disconnect counter proving stop()
 * closes exactly what was opened.
 */

const WS = "11111111-1111-1111-1111-111111111111";
const MB = "22222222-2222-2222-2222-222222222222";

/**
 * FakeProviderFactory (real ImapSmtpProvider over the fake IMAP client, with
 * the C1 construction counters) plus a per-session disconnect counter so
 * tests can assert disconnects === connects.
 */
class CountingIdleFactory extends FakeProviderFactory {
  public disconnects = 0;
  /** Mailbox ids in session-construction order (fairness assertions). */
  public readonly sessionMailboxIds: string[] = [];

  public override async createImapSession(
    mailbox: MailboxRow,
  ): Promise<ImapSessionProvider> {
    const session = await super.createImapSession(mailbox);
    this.sessionMailboxIds.push(mailbox.id);
    const count = (): void => {
      this.disconnects += 1;
    };
    return new Proxy(session, {
      get(target, prop, receiver): unknown {
        if (prop === "disconnect") {
          return async (): Promise<void> => {
            count();
            await target.disconnect();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}

interface Harness {
  coordinator: IdleCoordinator;
  mailboxes: FakeMailboxRepo;
  server: FakeImapServer;
  factory: CountingIdleFactory;
  enqueued: SyncMailboxJob[];
  /** Resolves the oldest pending (manual-mode) enqueue call, FIFO. */
  release: (result: string | null) => void;
  /**
   * Race-free shutdown for manual-enqueue tests: switches the enqueue fake to
   * auto-null (so an enqueue racing with stop() can never dangle), begins
   * stop() (which sets the stopping flag synchronously), flushes any pending
   * enqueue with null, and returns the stop promise.
   */
  stopAndDrain: () => Promise<void>;
  logLines: string[];
  sleeps: number[];
  config: IdleCoordinatorDeps["config"];
}

function makeHarness(options?: {
  idleEnabled?: boolean;
  globalKillSwitch?: boolean;
  maxSessions?: number;
  random?: () => number;
  /** When true, each enqueueSync blocks until the test calls release(). */
  manualEnqueue?: boolean;
  /** Auto-mode enqueue results, consumed in order (default: fresh job ids). */
  enqueueResults?: (string | null)[];
}): Harness {
  const server = new FakeImapServer();
  server.addFolder({ name: "INBOX", role: "inbox" });
  const factory = new CountingIdleFactory(server, new FakeSmtpClient());
  const mailboxes = new FakeMailboxRepo();
  const enqueued: SyncMailboxJob[] = [];
  const pending: ((result: string | null) => void)[] = [];
  let draining = false;
  const results = [...(options?.enqueueResults ?? [])];
  const logLines: string[] = [];
  const sleeps: number[] = [];
  const config: IdleCoordinatorDeps["config"] = {
    idleEnabled: options?.idleEnabled ?? true,
    globalKillSwitch: options?.globalKillSwitch ?? false,
    idleTimeoutMs: 300_000,
    backoffMinMs: 5_000,
    backoffMaxMs: 300_000,
    rescanMs: 60_000,
    maxSessions: options?.maxSessions ?? 10,
  };
  const coordinator = new IdleCoordinator({
    mailboxes,
    providerFactory: factory,
    enqueueSync: (job) => {
      enqueued.push(job);
      if (draining) return Promise.resolve(null);
      if (options?.manualEnqueue === true) {
        return new Promise((resolve) => pending.push(resolve));
      }
      return Promise.resolve(
        results.length > 0 ? results.shift()! : `job-${enqueued.length}`,
      );
    },
    logger: new JsonLogger({
      level: "debug",
      sink: { write: (l) => logLines.push(l) },
    }),
    random: options?.random ?? ((): number => 0.5),
    sleep: (ms): Promise<void> => {
      sleeps.push(ms);
      // Record the requested delay but yield ONE macrotask instead of
      // sleeping, so reconnect loops progress without starving the event
      // loop (a purely-microtask loop would block vi.waitFor's timers).
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
    config,
  });
  return {
    coordinator,
    mailboxes,
    server,
    factory,
    enqueued,
    release: (result): void => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending enqueue to release");
      next(result);
    },
    stopAndDrain: (): Promise<void> => {
      draining = true;
      const stopped = coordinator.stop(); // sets the stop flag synchronously
      while (pending.length > 0) pending.shift()!(null);
      return stopped;
    },
    logLines,
    sleeps,
    config,
  };
}

function seedMailbox(
  h: Harness,
  overrides: Partial<MailboxRow> = {},
): MailboxRow {
  const row = sendableMailbox({ id: MB, workspaceId: WS, ...overrides });
  h.mailboxes.rows.set(row.id, row);
  return row;
}

function logsNamed(h: Harness, msg: string): string[] {
  return h.logLines.filter((l) => l.includes(`"msg":"${msg}"`));
}

// Test 1 — gating: the registration plan + the coordinator itself fail closed.
describe("IdleCoordinator — capability gating (flag off => absent)", () => {
  it("the registration plan requires master AND sync AND idle", () => {
    const base = {
      transportEnabled: false,
      syncEnabled: false,
      idleEnabled: false,
      draftMirrorEnabled: false,
      mutationsEnabled: false,
      sendEnabled: false,
    };
    expect(
      plannedRegistrations({
        ...base,
        transportEnabled: true,
        syncEnabled: true,
        idleEnabled: true,
      }).idle,
    ).toBe(true);
    // Gate F matrix (master + sync, idle off) plans NO coordinator.
    expect(
      plannedRegistrations({
        ...base,
        transportEnabled: true,
        syncEnabled: true,
      }).idle,
    ).toBe(false);
    // idle without sync fails closed (nothing to enqueue into).
    expect(
      plannedRegistrations({
        ...base,
        transportEnabled: true,
        idleEnabled: true,
      }).idle,
    ).toBe(false);
    // idle + sync without master fails closed (defense in depth).
    expect(
      plannedRegistrations({ ...base, syncEnabled: true, idleEnabled: true })
        .idle,
    ).toBe(false);
  });

  it("with the effective flag off, start() adopts nothing and opens nothing", async () => {
    const h = makeHarness({ idleEnabled: false });
    seedMailbox(h);
    await h.coordinator.start();
    expect(h.coordinator.activeLoopCount).toBe(0);
    expect(h.factory.imapSessionsCreated).toBe(0);
    expect(h.factory.submissionsCreated).toBe(0);
    expect(logsNamed(h, "idle_disabled")).toHaveLength(1);
    await h.coordinator.stop();
  });
});

describe("IdleCoordinator — wake-ups, dedup and fallback", () => {
  // Test 3 — one wake-up => exactly ONE enqueueSync (incremental, INBOX).
  it("one IDLE wake-up enqueues exactly one incremental sync", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h);
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    // Release the enqueue and stop in the same synchronous window: the loop's
    // next checkpoint observes the stop flag before it can enqueue again.
    h.release("job-1");
    await h.stopAndDrain();
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toEqual({
      workspaceId: WS,
      mailboxId: MB,
      folder: "INBOX",
      mode: "incremental",
    });
    expect(logsNamed(h, "idle_wakeup")).toHaveLength(1);
    expect(logsNamed(h, "idle_wakeup_dedup")).toHaveLength(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  // Test 3b — the null-dedup path is logged content-free and never throws.
  it("a null enqueue result (already queued) logs idle_wakeup_dedup and continues", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h);
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    h.release(null); // pg-boss singleton dedup: identical job already queued
    await vi.waitFor(() =>
      expect(logsNamed(h, "idle_wakeup_dedup")).toHaveLength(1),
    );
    await h.stopAndDrain();
    expect(logsNamed(h, "idle_loop_error")).toHaveLength(0);
  });

  // Test 4 — multiple queued wake-ups coalesce via the singleton key.
  it("burst wake-ups coalesce: the second enqueue dedups to null, one effective job", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h);
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    h.release("job-1"); // first wake-up: effective job queued
    await vi.waitFor(() => expect(h.enqueued.length).toBe(2));
    h.release(null); // second wake-up: same singleton key => dedup
    await vi.waitFor(() =>
      expect(logsNamed(h, "idle_wakeup_dedup")).toHaveLength(1),
    );
    await h.stopAndDrain();
    expect(logsNamed(h, "idle_wakeup")).toHaveLength(2);
    // Exactly one EFFECTIVE job: one non-null result, one dedup.
    expect(logsNamed(h, "idle_wakeup_dedup")).toHaveLength(1);
  });

  // Test 5 — IDLE silence => the bounded periodic fallback sync.
  it("an IDLE timeout enqueues the fallback incremental sync", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h); // no queued signal: the fake IDLE times out
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    await h.stopAndDrain();
    expect(logsNamed(h, "idle_fallback_sync")).toHaveLength(1);
    expect(logsNamed(h, "idle_wakeup")).toHaveLength(0);
    expect(h.enqueued[0]).toEqual({
      workspaceId: WS,
      mailboxId: MB,
      folder: "INBOX",
      mode: "incremental",
    });
  });
});

describe("IdleCoordinator — reconnect backoff", () => {
  // Test 6 — bounded exponential backoff, monotone non-decreasing to the cap.
  it("backoff base doubles from min and clamps at max (jitter factor pinned to 1)", async () => {
    // random() = 0.5 => jitter factor exactly 1.0 => delay === base.
    const h = makeHarness({ random: () => 0.5 });
    seedMailbox(h);
    h.server.connectOk = false; // every connect attempt fails
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.sleeps.length).toBeGreaterThanOrEqual(8));
    await h.coordinator.stop();
    expect(h.sleeps.slice(0, 8)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    for (let i = 1; i < h.sleeps.length; i++) {
      expect(h.sleeps[i]!).toBeGreaterThanOrEqual(h.sleeps[i - 1]!);
      expect(h.sleeps[i]!).toBeLessThanOrEqual(300_000);
    }
    // idle_reconnect logs carry the attempt counter and the delay.
    const first = logsNamed(h, "idle_reconnect")[0]!;
    expect(first).toContain('"attempt":1');
    expect(first).toContain('"delay_ms":5000');
    expect(h.factory.submissionsCreated).toBe(0);
  });

  // Test 7 — jitter stays within ±50% of the base, deterministically.
  it("jitter spans [0.5*base, 1.5*base) via the injected random source", async () => {
    const randoms = [0, 0.9999];
    let call = 0;
    const h = makeHarness({
      random: (): number => randoms[call++] ?? 0.5,
    });
    seedMailbox(h);
    h.server.connectOk = false;
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.sleeps.length).toBeGreaterThanOrEqual(2));
    await h.coordinator.stop();
    // attempt 1: base 5000, factor 0.5 => exactly 2500 (lower bound).
    expect(h.sleeps[0]).toBe(2_500);
    // attempt 2: base 10000, factor 1.4999 => 14999 (just under upper bound).
    expect(h.sleeps[1]).toBe(14_999);
    expect(h.sleeps[0]!).toBeGreaterThanOrEqual(0.5 * 5_000);
    expect(h.sleeps[0]!).toBeLessThan(1.5 * 5_000);
    expect(h.sleeps[1]!).toBeGreaterThanOrEqual(0.5 * 10_000);
    expect(h.sleeps[1]!).toBeLessThan(1.5 * 10_000);
  });
});

describe("IdleCoordinator — kill switches and disablement", () => {
  // Test 8a — global kill switch engaged up front: NO connect, ever.
  it("global kill switch at startup: adopts nothing, opens no session", async () => {
    const h = makeHarness({ globalKillSwitch: true });
    seedMailbox(h);
    await h.coordinator.start();
    expect(h.coordinator.activeLoopCount).toBe(0);
    expect(h.factory.imapSessionsCreated).toBe(0);
    expect(h.enqueued).toHaveLength(0);
    await h.coordinator.stop();
  });

  // Test 8b — global kill switch engaged mid-loop stops the session promptly.
  it("global kill switch mid-loop closes the session at the next checkpoint", async () => {
    const h = makeHarness();
    seedMailbox(h);
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(1));
    h.config.globalKillSwitch = true;
    await vi.waitFor(() => expect(h.coordinator.activeLoopCount).toBe(0));
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
    const killed = logsNamed(h, "idle_killed");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toContain('"reason":"global_kill_switch"');
    await h.coordinator.stop();
  });

  // Test 9 — per-mailbox kill switch stops that mailbox's session.
  it("mailbox kill switch stops its loop and closes its session", async () => {
    const h = makeHarness();
    const row = seedMailbox(h);
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(1));
    h.mailboxes.rows.set(MB, { ...row, killSwitch: true });
    await vi.waitFor(() => expect(h.coordinator.activeLoopCount).toBe(0));
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
    const killed = logsNamed(h, "idle_killed");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toContain('"reason":"mailbox_kill_switch"');
    await h.coordinator.stop();
  });

  // Test 10 — mailbox disablement stops its session the same way.
  it("mailbox disablement stops its loop and closes its session", async () => {
    const h = makeHarness();
    const row = seedMailbox(h);
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(1));
    h.mailboxes.rows.set(MB, { ...row, enabled: false });
    await vi.waitFor(() => expect(h.coordinator.activeLoopCount).toBe(0));
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
    const stopped = logsNamed(h, "idle_stopped");
    expect(stopped.some((l) => l.includes('"reason":"mailbox_disabled"'))).toBe(
      true,
    );
    await h.coordinator.stop();
  });
});

describe("IdleCoordinator — lifecycle, cap and fairness", () => {
  // Test 11 — stop() closes EVERY session: disconnects === connects.
  it("stop() closes every active session exactly once", async () => {
    const h = makeHarness();
    const otherId = "33333333-3333-3333-3333-333333333333";
    seedMailbox(h);
    seedMailbox(h, { id: otherId });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(2));
    expect(h.coordinator.activeLoopCount).toBe(2);
    await h.coordinator.stop();
    expect(h.coordinator.activeLoopCount).toBe(0);
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  // Test 12 — global session cap + round-robin-by-workspace adoption.
  it("respects the session cap and adopts round-robin across workspaces", async () => {
    const h = makeHarness({ maxSessions: 2 });
    const wsA = "aaaaaaaa-0000-0000-0000-000000000000";
    const wsB = "bbbbbbbb-0000-0000-0000-000000000000";
    const wsC = "cccccccc-0000-0000-0000-000000000000";
    // Workspace A gets THREE mailboxes; B and C one each. A fair adopter must
    // not let A monopolize the two available slots.
    const a1 = "a1111111-1111-1111-1111-111111111111";
    seedMailbox(h, { id: a1, workspaceId: wsA });
    seedMailbox(h, {
      id: "a2222222-2222-2222-2222-222222222222",
      workspaceId: wsA,
    });
    seedMailbox(h, {
      id: "a3333333-3333-3333-3333-333333333333",
      workspaceId: wsA,
    });
    const b1 = "b1111111-1111-1111-1111-111111111111";
    seedMailbox(h, { id: b1, workspaceId: wsB });
    seedMailbox(h, {
      id: "c1111111-1111-1111-1111-111111111111",
      workspaceId: wsC,
    });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.sessionMailboxIds).toHaveLength(2));
    expect(h.coordinator.activeLoopCount).toBe(2);
    expect(h.factory.imapSessionsCreated).toBe(2); // the cap held
    // Round 1 in sorted workspace order: one from A, one from B — never two
    // from the same workspace while others wait.
    expect(new Set(h.factory.sessionMailboxIds)).toEqual(new Set([a1, b1]));
    await h.coordinator.stop();
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
  });

  // Behavior 6 — the rescan adopts new mailboxes and drops disabled ones.
  it("rescan adopts newly-enabled mailboxes and drops disabled ones", async () => {
    const h = makeHarness();
    const first = seedMailbox(h);
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(1));
    // A new mailbox appears: the next rescan adopts it.
    const otherId = "44444444-4444-4444-4444-444444444444";
    seedMailbox(h, { id: otherId });
    await h.coordinator.rescanOnce();
    await vi.waitFor(() => expect(h.factory.imapSessionsCreated).toBe(2));
    expect(h.coordinator.activeLoopCount).toBe(2);
    // The first mailbox is disabled: the next rescan drops it promptly.
    h.mailboxes.rows.set(MB, { ...first, enabled: false });
    await h.coordinator.rescanOnce();
    await vi.waitFor(() => expect(h.coordinator.activeLoopCount).toBe(1));
    await h.coordinator.stop();
    expect(h.factory.disconnects).toBe(h.factory.imapSessionsCreated);
  });
});

// Test 2 + Test 13 — capability + content hygiene across a full wake-up cycle.
describe("IdleCoordinator — capability and log hygiene", () => {
  it("a full wake-up cycle constructs zero SMTP submissions", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h);
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    h.release("job-1");
    await h.stopAndDrain();
    expect(h.factory.imapSessionsCreated).toBeGreaterThan(0);
    expect(h.factory.submissionsCreated).toBe(0);
  });

  it("never logs folder contents, subjects, senders or recipients", async () => {
    const h = makeHarness({ manualEnqueue: true });
    seedMailbox(h);
    h.server.seedMessage("INBOX", {
      subject: "TOP-SECRET-SUBJECT",
      from: "leaky-sender@example.com",
      to: "leaky-recipient@example.com",
      messageId: "<leak-1@example.com>",
    });
    h.server.queueIdleSignal("INBOX", { kind: "exists" });
    await h.coordinator.start();
    await vi.waitFor(() => expect(h.enqueued.length).toBe(1));
    h.release("job-1");
    await h.stopAndDrain();
    const joined = h.logLines.join("\n");
    expect(joined).not.toContain("TOP-SECRET-SUBJECT");
    expect(joined).not.toContain("leaky-sender@example.com");
    expect(joined).not.toContain("leaky-recipient@example.com");
    expect(joined).not.toContain("leak-1@example.com");
    for (const field of ['"subject"', '"from"', '"to"', '"folder"']) {
      expect(joined).not.toContain(field);
    }
    // It DOES carry the content-free lifecycle events.
    expect(logsNamed(h, "idle_connected")).toHaveLength(1);
    expect(logsNamed(h, "idle_wakeup")).toHaveLength(1);
  });
});
