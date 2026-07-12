/**
 * Injectable clock. Real code uses SystemClock; tests use a deterministic
 * fake so timeouts/leases/backoff are reproducible without wall-clock waits.
 */
export interface Clock {
  now(): Date;
  /** Monotonic-ish milliseconds for measuring durations. */
  nowMs(): number;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
  public nowMs(): number {
    return Date.now();
  }
}
