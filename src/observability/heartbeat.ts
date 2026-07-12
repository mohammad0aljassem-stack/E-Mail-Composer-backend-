import type { Clock } from "../domain/clock.js";
import type { HeartbeatWriter } from "../db/repository-interfaces.js";
import type { Logger } from "./logger.js";

/**
 * Content-free liveness heartbeat. Records worker_id + last_seen + a coarse
 * state label ONLY — never any message content. Used for operator liveness and
 * (eventually) claim reaping.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  public constructor(
    private readonly deps: {
      heartbeats: HeartbeatWriter;
      clock: Clock;
      logger: Logger;
      workerId: string;
      intervalMs: number;
    },
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      if (this.stopped) return;
      void this.deps.heartbeats
        .beat(this.deps.workerId, "running")
        .catch(() => {
          this.deps.logger.warn("heartbeat_write_failed");
        });
    };
    tick();
    this.timer = setInterval(tick, this.deps.intervalMs);
    // Do not keep the event loop alive solely for heartbeats.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.deps.heartbeats
      .beat(this.deps.workerId, "stopped")
      .catch(() => undefined);
  }
}
