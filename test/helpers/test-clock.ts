import type { Clock } from "../../src/domain/clock.js";

export class TestClock implements Clock {
  private ms: number;
  public constructor(startMs = 1_700_000_000_000) {
    this.ms = startMs;
  }
  public now(): Date {
    return new Date(this.ms);
  }
  public nowMs(): number {
    return this.ms;
  }
  public advance(ms: number): void {
    this.ms += ms;
  }
}
