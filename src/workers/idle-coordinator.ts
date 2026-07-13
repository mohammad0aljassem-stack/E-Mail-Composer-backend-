import type { MailboxRow } from "../domain/models.js";
import type { Logger } from "../observability/logger.js";
import type { MailboxReader } from "../db/repository-interfaces.js";
import type { SyncMailboxJob } from "../queues/queue-config.js";
import type {
  IdleChange,
  ImapSessionProvider,
} from "../providers/mail-provider.js";
import type { ProviderFactory } from "./ports.js";

/**
 * IMAP IDLE + periodic-fallback sync coordinator (Phase 3B C7).
 *
 * Maintains AT MOST ONE long-lived IMAP session per enabled, non-killed
 * mailbox (the `loops` map is keyed by mailbox id, and each loop holds at most
 * one session at a time), watching a SINGLE folder per mailbox: `INBOX` — the
 * same default the durable sync-request dispatcher uses for whole-mailbox
 * requests (`row.folder ?? "INBOX"`). Deliberately simple: one mailbox, one
 * session, one watched folder.
 *
 * WHAT A WAKE-UP DOES (and does not do): an IDLE signal is a wake-up ONLY.
 * The coordinator never fetches, parses, or persists anything itself — it
 * enqueues ONE incremental `sync_mailbox` pg-boss job through the injected
 * `enqueueSync`, which uses the PLAIN mailbox+folder singleton key
 * (`sync:{mailboxId}:{folder}`). That key is deterministic, so a burst of
 * wake-ups coalesces: `boss.send` returns null when an equivalent job is
 * already queued, which is logged content-free (`idle_wakeup_dedup`) and
 * treated as success — the queued job will observe the new state anyway.
 *
 * PERIODIC FALLBACK (internal to the worker — NOT an external scheduler, NOT
 * cron, NOT GitHub Actions): when IDLE stays silent for a full
 * `idleTimeoutMs` window, the coordinator enqueues the SAME deterministic
 * incremental sync (`idle_fallback_sync`) so a mailbox whose server drops
 * IDLE notifications still converges, bounded to one enqueue attempt per
 * timeout window per mailbox.
 *
 * CAPABILITY SCOPE (C1): sessions open IMAP ONLY, via
 * `providerFactory.createImapSession` — the dependency is typed as
 * `Pick<ProviderFactory, "createImapSession">`, so this module cannot even
 * name `createSubmission`. SMTP is impossible by construction (the
 * construction counters in tests and the static scan prove it).
 *
 * KILL SWITCHES + LIVENESS: the global kill switch and the mailbox row
 * (`enabled` / `kill_switch`, reloaded from the DB) are re-checked at every
 * checkpoint — before connecting, before each IDLE wait, and again after each
 * wake-up BEFORE anything is enqueued. A mailbox found disabled/killed at any
 * checkpoint closes its session promptly and stops its loop (it may be
 * re-adopted by a later rescan once re-enabled). A periodic rescan
 * (`rescanMs`, unref'd timer) adopts new mailboxes and proactively drops
 * disabled ones.
 *
 * BACKOFF: reconnects use bounded exponential backoff with ±50% jitter from
 * an injectable random source (deterministic in tests). The pre-jitter base
 * is monotone non-decreasing up to `backoffMaxMs`
 * (`base = min(max, min * 2^(n-1))`, jitter factor in [0.5, 1.5)); the
 * consecutive-failure counter is per mailbox and resets only after a
 * successfully completed IDLE wait — never a tight loop.
 *
 * WORKSPACE FAIRNESS: the number of concurrent IDLE sessions overall is
 * capped (`maxSessions`); adoption is round-robin BY WORKSPACE (one mailbox
 * per workspace per round, workspaces in sorted order), so one workspace with
 * many mailboxes cannot monopolize the session budget.
 *
 * SHUTDOWN: `stop()` closes EVERY active IMAP session (disconnect guarded so
 * each session closes exactly once), clears the rescan timer, wakes any loop
 * paused in backoff, and awaits every loop's exit.
 *
 * OBSERVABILITY (content-free — ids/counts/durations only, never folder
 * contents, subjects, senders, or bodies): idle_disabled, idle_connected,
 * idle_wakeup, idle_wakeup_dedup, idle_fallback_sync, idle_reconnect
 * (attempt + delay_ms), idle_killed, idle_stopped, idle_loop_error.
 *
 * NO audit polling. NO SMTP. NO work creation from SQL.
 */

/** The single folder each mailbox loop watches (matches the dispatcher's
 *  whole-mailbox default). */
const WATCH_FOLDER = "INBOX";

export interface IdleCoordinatorDeps {
  mailboxes: MailboxReader;
  /** IMAP-only capability slice: this coordinator can never construct SMTP. */
  providerFactory: Pick<ProviderFactory, "createImapSession">;
  /**
   * Enqueue an incremental sync under the PLAIN mailbox+folder singleton key
   * (deterministic dedup: null = an equivalent job is already queued).
   */
  enqueueSync: (job: SyncMailboxJob) => Promise<string | null>;
  logger: Logger;
  /** Injectable jitter source, [0,1). Defaults to Math.random. */
  random?: () => number;
  /** Injectable backoff sleep (deterministic in tests). */
  sleep?: (ms: number) => Promise<void>;
  config: {
    /** Effective flag: master && sync && idle (see registration-plan). */
    idleEnabled: boolean;
    globalKillSwitch: boolean;
    /** IDLE wait bound per cycle; a silent window triggers the fallback sync. */
    idleTimeoutMs: number;
    /** Reconnect backoff bounds (pre-jitter base). */
    backoffMinMs: number;
    backoffMaxMs: number;
    /** Mailbox-list rescan interval (adopt new / drop disabled). */
    rescanMs: number;
    /** Global cap on concurrent IDLE sessions (workspace fairness). */
    maxSessions: number;
  };
}

type GateReason =
  | "stop_requested"
  | "global_kill_switch"
  | "mailbox_missing"
  | "mailbox_disabled"
  | "mailbox_kill_switch";

type Gate = { blocked: GateReason } | { blocked: null; row: MailboxRow };

interface LoopState {
  readonly mailboxId: string;
  readonly workspaceId: string;
  stopRequested: boolean;
  /** The at-most-one open session for this mailbox (nulled before close). */
  session: ImapSessionProvider | null;
  /** Consecutive failures since the last successfully completed IDLE wait. */
  consecutiveFailures: number;
  /** Wakes a backoff pause early (stop/drop must never wait out a backoff). */
  wake: (() => void) | null;
  promise: Promise<void>;
}

export class IdleCoordinator {
  private readonly loops = new Map<string, LoopState>();
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private started = false;
  private readonly randomFn: () => number;
  private readonly sleepFn: ((ms: number) => Promise<void>) | null;

  public constructor(private readonly deps: IdleCoordinatorDeps) {
    this.randomFn = deps.random ?? Math.random;
    this.sleepFn = deps.sleep ?? null;
  }

  /** Number of mailbox loops currently held (each caps at one session). */
  public get activeLoopCount(): number {
    return this.loops.size;
  }

  /**
   * Adopt the current mailbox list and begin the periodic rescan. Fail-closed:
   * with the effective idle flag off this logs `idle_disabled` and does
   * nothing (the worker entrypoint additionally never constructs the
   * coordinator in that case — defense in depth).
   */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.deps.config.idleEnabled) {
      this.deps.logger.warn("idle_disabled");
      return;
    }
    await this.rescanOnce();
    this.rescanTimer = setInterval(() => {
      void this.rescanOnce().catch((err: unknown) => {
        this.deps.logger.error("idle_loop_error", {
          error: err instanceof Error ? err.name : "unknown",
        });
      });
    }, this.deps.config.rescanMs);
    if (typeof this.rescanTimer.unref === "function") this.rescanTimer.unref();
  }

  /**
   * One adoption pass: drop loops whose mailbox left the enabled list, then
   * adopt new mailboxes round-robin by workspace up to the session cap.
   * Idempotent; called at start, on the rescan interval, and by tests.
   */
  public async rescanOnce(): Promise<void> {
    if (this.stopping || !this.deps.config.idleEnabled) return;
    // Global kill switch: adopt nothing. Running loops stop themselves at
    // their next checkpoint (mid-loop stop), so no session outlives it long.
    if (this.deps.config.globalKillSwitch) return;

    const enabled = await this.deps.mailboxes.listEnabled();
    const eligible = enabled.filter((m) => m.enabled && !m.killSwitch);
    const eligibleIds = new Set(eligible.map((m) => m.id));

    // Proactive drop (the loop's own checkpoints would also catch it).
    for (const [id, state] of this.loops) {
      if (eligibleIds.has(id)) continue;
      state.stopRequested = true;
      state.wake?.();
      void this.closeSession(state);
    }

    let capacity = this.deps.config.maxSessions - this.loops.size;
    if (capacity <= 0) return;

    // Round-robin by workspace: one mailbox per workspace per round, in
    // sorted workspace order — simple, deterministic fairness.
    const byWorkspace = new Map<string, MailboxRow[]>();
    for (const row of eligible) {
      if (this.loops.has(row.id)) continue;
      const bucket = byWorkspace.get(row.workspaceId);
      if (bucket === undefined) byWorkspace.set(row.workspaceId, [row]);
      else bucket.push(row);
    }
    const workspaces = [...byWorkspace.keys()].sort();
    for (let round = 0; capacity > 0; round += 1) {
      let adopted = false;
      for (const ws of workspaces) {
        if (capacity <= 0) break;
        const row = byWorkspace.get(ws)?.[round];
        if (row === undefined) continue;
        this.adopt(row);
        capacity -= 1;
        adopted = true;
      }
      if (!adopted) break;
    }
  }

  /**
   * Graceful shutdown: stop adopting, wake every paused loop, close EVERY
   * active IMAP session, and wait for all loops to exit.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    const states = [...this.loops.values()];
    for (const state of states) {
      state.stopRequested = true;
      state.wake?.();
    }
    await Promise.all(states.map((state) => this.closeSession(state)));
    await Promise.all(states.map((state) => state.promise));
  }

  private adopt(row: MailboxRow): void {
    const state: LoopState = {
      mailboxId: row.id,
      workspaceId: row.workspaceId,
      stopRequested: false,
      session: null,
      consecutiveFailures: 0,
      wake: null,
      promise: Promise.resolve(),
    };
    state.promise = this.runLoop(state);
    this.loops.set(row.id, state);
  }

  private async runLoop(state: LoopState): Promise<void> {
    try {
      for (;;) {
        // Checkpoint BEFORE connect: kill switches + a fresh mailbox reload.
        const gate = await this.checkpoint(state);
        if (gate.blocked !== null) {
          this.logGate(state, gate.blocked);
          return;
        }

        let session: ImapSessionProvider;
        try {
          // IMAP ONLY (capability-scoped factory slice — no SMTP possible).
          session = await this.deps.providerFactory.createImapSession(gate.row);
        } catch {
          await this.backoff(state);
          continue;
        }
        state.session = session;
        this.deps.logger.info("idle_connected", {
          mailbox_id: state.mailboxId,
        });

        let blocked: GateReason | null = null;
        try {
          blocked = await this.watch(state, session);
        } catch {
          blocked = null; // session/enqueue error → backoff + reconnect
        } finally {
          await this.closeSession(state);
        }
        if (blocked !== null) {
          this.logGate(state, blocked);
          return;
        }
        await this.backoff(state);
      }
    } catch (err: unknown) {
      // Unexpected failure outside the guarded sections (e.g. the mailbox
      // reload threw): stop this loop; the periodic rescan re-adopts it.
      this.deps.logger.error("idle_loop_error", {
        mailbox_id: state.mailboxId,
        error: err instanceof Error ? err.name : "unknown",
      });
    } finally {
      await this.closeSession(state);
      this.loops.delete(state.mailboxId);
    }
  }

  /** IDLE-wait loop: runs until a checkpoint blocks (returned) or an error
   *  is thrown (the caller reconnects with backoff). */
  private async watch(
    state: LoopState,
    session: ImapSessionProvider,
  ): Promise<GateReason> {
    for (;;) {
      const before = await this.checkpoint(state);
      if (before.blocked !== null) return before.blocked;

      const change: IdleChange | null = await session.waitForChanges(
        WATCH_FOLDER,
        this.deps.config.idleTimeoutMs,
      );
      // A completed IDLE wait proves the session is healthy.
      state.consecutiveFailures = 0;

      // Re-check kill switches after the wake-up, BEFORE enqueuing anything.
      const after = await this.checkpoint(state);
      if (after.blocked !== null) return after.blocked;

      const job: SyncMailboxJob = {
        workspaceId: state.workspaceId,
        mailboxId: state.mailboxId,
        folder: WATCH_FOLDER,
        mode: "incremental",
      };
      if (change !== null) {
        this.deps.logger.info("idle_wakeup", {
          mailbox_id: state.mailboxId,
          kind: change.kind,
        });
        const jobId = await this.deps.enqueueSync(job);
        if (jobId === null) {
          // Deterministic mailbox+folder singleton key: null PROVES an
          // equivalent sync job is already queued — coalesced, not lost.
          this.deps.logger.info("idle_wakeup_dedup", {
            mailbox_id: state.mailboxId,
          });
        }
      } else {
        // IDLE was silent for the whole window: bounded periodic fallback.
        this.deps.logger.info("idle_fallback_sync", {
          mailbox_id: state.mailboxId,
        });
        await this.deps.enqueueSync(job);
      }
    }
  }

  /** Kill-switch + mailbox-row gate, re-evaluated at every checkpoint. */
  private async checkpoint(state: LoopState): Promise<Gate> {
    if (this.stopping || state.stopRequested) {
      return { blocked: "stop_requested" };
    }
    if (this.deps.config.globalKillSwitch) {
      return { blocked: "global_kill_switch" };
    }
    const row = await this.deps.mailboxes.getById(state.mailboxId);
    if (row === null) return { blocked: "mailbox_missing" };
    if (row.killSwitch) return { blocked: "mailbox_kill_switch" };
    if (!row.enabled) return { blocked: "mailbox_disabled" };
    return { blocked: null, row };
  }

  private logGate(state: LoopState, reason: GateReason): void {
    if (reason === "global_kill_switch" || reason === "mailbox_kill_switch") {
      this.deps.logger.warn("idle_killed", {
        mailbox_id: state.mailboxId,
        reason,
      });
    } else {
      this.deps.logger.info("idle_stopped", {
        mailbox_id: state.mailboxId,
        reason,
      });
    }
  }

  /**
   * Bounded exponential backoff with ±50% jitter. The pre-jitter base is
   * monotone non-decreasing up to the cap; jittered delay ∈ [0.5·base,
   * 1.5·base). Interruptible: stop()/drop wakes the pause immediately.
   */
  private async backoff(state: LoopState): Promise<void> {
    state.consecutiveFailures += 1;
    const exponent = Math.min(state.consecutiveFailures - 1, 30);
    const base = Math.min(
      this.deps.config.backoffMaxMs,
      this.deps.config.backoffMinMs * 2 ** exponent,
    );
    const delayMs = Math.round(base * (0.5 + this.randomFn()));
    this.deps.logger.warn("idle_reconnect", {
      mailbox_id: state.mailboxId,
      attempt: state.consecutiveFailures,
      delay_ms: delayMs,
    });
    await this.pause(state, delayMs);
  }

  private async pause(state: LoopState, ms: number): Promise<void> {
    // Never sleep into a stop: the loop's next checkpoint exits immediately.
    if (this.stopping || state.stopRequested) return;
    if (this.sleepFn !== null) {
      await this.sleepFn(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.wake = null;
        resolve();
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
      state.wake = (): void => {
        clearTimeout(timer);
        state.wake = null;
        resolve();
      };
    });
  }

  /** Close a loop's session exactly once (idempotent under races: the state
   *  is nulled synchronously before the async disconnect). */
  private async closeSession(state: LoopState): Promise<void> {
    const session = state.session;
    state.session = null;
    if (session === null) return;
    try {
      await session.disconnect();
    } catch {
      // Already closed / connection torn down — closing is best-effort.
    }
  }
}
