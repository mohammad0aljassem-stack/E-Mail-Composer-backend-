import type { Clock } from "../domain/clock.js";
import type { Queryable } from "../db/pool.js";

/**
 * Minimal, content-free health + readiness. When the transport flag is off the
 * status is explicitly `transport-disabled` (NOT healthy-active), so ops cannot
 * mistake a fail-closed worker for an actively-delivering one.
 */

export type TransportStatus =
  "transport-disabled" | "healthy-active" | "degraded" | "unhealthy";

export interface HealthReport {
  readonly status: TransportStatus;
  readonly transportEnabled: boolean;
  readonly dbReachable: boolean;
  readonly checkedAt: string;
}

export interface HealthDeps {
  db: Queryable;
  clock: Clock;
  transportEnabled: boolean;
  globalKillSwitch: boolean;
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  let dbReachable = false;
  try {
    await deps.db.query("select 1 as ok");
    dbReachable = true;
  } catch {
    dbReachable = false;
  }

  let status: TransportStatus;
  if (!deps.transportEnabled) {
    status = "transport-disabled";
  } else if (!dbReachable) {
    status = "unhealthy";
  } else if (deps.globalKillSwitch) {
    status = "degraded";
  } else {
    status = "healthy-active";
  }

  return {
    status,
    transportEnabled: deps.transportEnabled,
    dbReachable,
    checkedAt: deps.clock.now().toISOString(),
  };
}
