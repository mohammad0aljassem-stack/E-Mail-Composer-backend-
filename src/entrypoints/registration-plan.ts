import type { TransportConfig } from "../config/env.js";

/**
 * Pure registration plan for the worker entrypoint: which job handlers (and
 * whether the sync-request dispatcher interval) WOULD be registered for a
 * given config. Extracted so the fail-closed capability gating is directly
 * unit-testable without starting queues or opening a database.
 *
 * Fail-closed rules:
 *  - the master transport flag off → nothing registers, regardless of any
 *    sub-flag (defense in depth: loadConfig already masks sub-flags with the
 *    master, and this helper re-masks for hand-built configs);
 *  - a sub-capability registers ONLY its own handler(s) — Gate F: master +
 *    sync alone yields exactly the sync handler + dispatcher and no code path
 *    that could construct an SMTP client;
 *  - draft_mirror is NEVER registered in this phase (slice 3 registers it
 *    behind draftMirrorEnabled; the flag already exists and defaults false).
 */

export type CapabilityConfig = Pick<
  TransportConfig,
  | "transportEnabled"
  | "syncEnabled"
  | "idleEnabled"
  | "draftMirrorEnabled"
  | "mutationsEnabled"
  | "sendEnabled"
>;

export interface RegistrationPlan {
  readonly syncMailbox: boolean;
  readonly syncDispatcher: boolean;
  readonly applyMutation: boolean;
  readonly sendMessage: boolean;
  readonly draftMirror: boolean;
}

export function plannedRegistrations(
  config: CapabilityConfig,
): RegistrationPlan {
  const master = config.transportEnabled;
  const sync = master && config.syncEnabled;
  return {
    syncMailbox: sync,
    syncDispatcher: sync,
    applyMutation: master && config.mutationsEnabled,
    sendMessage: master && config.sendEnabled,
    // Slice 3 (draft-mirror registration) flips this to
    // `master && config.draftMirrorEnabled`; until then: never registered.
    draftMirror: false,
  };
}
