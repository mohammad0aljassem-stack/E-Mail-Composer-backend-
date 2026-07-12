import { describe, expect, it } from "vitest";
import { checkHealth } from "../../src/health/health.js";
import { TestClock } from "../helpers/test-clock.js";
import type { Queryable } from "../../src/db/pool.js";

const okDb: Queryable = {
  query: () => Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 } as never),
};
const brokenDb: Queryable = {
  query: () => Promise.reject(new Error("down")),
};

describe("health + readiness", () => {
  it("reports transport-disabled when the flag is off (not healthy-active)", async () => {
    const r = await checkHealth({
      db: okDb,
      clock: new TestClock(),
      transportEnabled: false,
      globalKillSwitch: false,
    });
    expect(r.status).toBe("transport-disabled");
  });

  it("reports healthy-active when enabled + db reachable + no kill switch", async () => {
    const r = await checkHealth({
      db: okDb,
      clock: new TestClock(),
      transportEnabled: true,
      globalKillSwitch: false,
    });
    expect(r.status).toBe("healthy-active");
  });

  it("reports degraded when the global kill switch is engaged", async () => {
    const r = await checkHealth({
      db: okDb,
      clock: new TestClock(),
      transportEnabled: true,
      globalKillSwitch: true,
    });
    expect(r.status).toBe("degraded");
  });

  it("reports unhealthy when enabled but the db is unreachable", async () => {
    const r = await checkHealth({
      db: brokenDb,
      clock: new TestClock(),
      transportEnabled: true,
      globalKillSwitch: false,
    });
    expect(r.status).toBe("unhealthy");
    expect(r.dbReachable).toBe(false);
  });
});
