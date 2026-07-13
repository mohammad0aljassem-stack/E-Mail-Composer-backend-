import { describe, expect, it } from "vitest";
import {
  plannedRegistrations,
  type CapabilityConfig,
} from "../../src/entrypoints/registration-plan.js";

/**
 * Phase 3B C2 — worker registration matrix. The worker entrypoint registers a
 * job handler ONLY when the master transport flag AND the handler's own
 * sub-capability flag are true. Gate F representability: master + sync alone
 * yields exactly the sync handler + dispatcher and nothing that could
 * construct an SMTP client.
 */

function cfg(overrides: Partial<CapabilityConfig> = {}): CapabilityConfig {
  return {
    transportEnabled: false,
    syncEnabled: false,
    idleEnabled: false,
    draftMirrorEnabled: false,
    mutationsEnabled: false,
    sendEnabled: false,
    ...overrides,
  };
}

describe("plannedRegistrations (fail-closed capability gating)", () => {
  it("Gate F: master + sync only → exactly the sync handler + dispatcher", () => {
    const plan = plannedRegistrations(
      cfg({ transportEnabled: true, syncEnabled: true }),
    );
    expect(plan).toEqual({
      syncMailbox: true,
      syncDispatcher: true,
      applyMutation: false,
      sendMessage: false,
      draftMirror: false,
    });
  });

  it("all flags off → nothing registers", () => {
    const plan = plannedRegistrations(cfg());
    expect(Object.values(plan).every((v) => v === false)).toBe(true);
  });

  it("master off → nothing registers regardless of sub-flags (defense in depth)", () => {
    const plan = plannedRegistrations(
      cfg({
        transportEnabled: false,
        syncEnabled: true,
        idleEnabled: true,
        draftMirrorEnabled: true,
        mutationsEnabled: true,
        sendEnabled: true,
      }),
    );
    expect(Object.values(plan).every((v) => v === false)).toBe(true);
  });

  it("master on with every sub-flag off → nothing registers", () => {
    const plan = plannedRegistrations(cfg({ transportEnabled: true }));
    expect(Object.values(plan).every((v) => v === false)).toBe(true);
  });

  it("each capability registers only its own handler", () => {
    const send = plannedRegistrations(
      cfg({ transportEnabled: true, sendEnabled: true }),
    );
    expect(send).toEqual({
      syncMailbox: false,
      syncDispatcher: false,
      applyMutation: false,
      sendMessage: true,
      draftMirror: false,
    });
    const mutations = plannedRegistrations(
      cfg({ transportEnabled: true, mutationsEnabled: true }),
    );
    expect(mutations).toEqual({
      syncMailbox: false,
      syncDispatcher: false,
      applyMutation: true,
      sendMessage: false,
      draftMirror: false,
    });
  });

  it("draft_mirror is NEVER planned in this phase, even with its flag on", () => {
    const plan = plannedRegistrations(
      cfg({ transportEnabled: true, draftMirrorEnabled: true }),
    );
    // Slice 3 registers the draft_mirror handler behind draftMirrorEnabled;
    // until then the plan must keep it unregistered.
    expect(plan.draftMirror).toBe(false);
  });
});
