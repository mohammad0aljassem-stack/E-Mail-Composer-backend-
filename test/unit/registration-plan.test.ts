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
      idle: false,
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
      idle: false,
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
      idle: false,
      applyMutation: true,
      sendMessage: false,
      draftMirror: false,
    });
    const mirror = plannedRegistrations(
      cfg({ transportEnabled: true, draftMirrorEnabled: true }),
    );
    expect(mirror).toEqual({
      syncMailbox: false,
      syncDispatcher: false,
      idle: false,
      applyMutation: false,
      sendMessage: false,
      draftMirror: true,
    });
  });

  it("C7: idle requires master AND sync AND idle (idle alone fails closed)", () => {
    // Full stack on → the coordinator is planned.
    expect(
      plannedRegistrations(
        cfg({ transportEnabled: true, syncEnabled: true, idleEnabled: true }),
      ).idle,
    ).toBe(true);
    // idle without sync: a wake-up would have no sync handler to feed → off.
    expect(
      plannedRegistrations(cfg({ transportEnabled: true, idleEnabled: true }))
        .idle,
    ).toBe(false);
    // idle + sync without master: defense in depth → off.
    expect(
      plannedRegistrations(cfg({ syncEnabled: true, idleEnabled: true })).idle,
    ).toBe(false);
    // Gate F matrix (master + sync, idle off) plans no coordinator.
    expect(
      plannedRegistrations(cfg({ transportEnabled: true, syncEnabled: true }))
        .idle,
    ).toBe(false);
  });

  it("C6: a Gate-F config (master + sync only) never registers draft_mirror", () => {
    const plan = plannedRegistrations(
      cfg({ transportEnabled: true, syncEnabled: true }),
    );
    expect(plan.draftMirror).toBe(false);
  });

  it("C6: draft_mirror registers ONLY with master + MAIL_DRAFT_MIRROR_ENABLED", () => {
    expect(
      plannedRegistrations(
        cfg({ transportEnabled: true, draftMirrorEnabled: true }),
      ).draftMirror,
    ).toBe(true);
    // Flag alone (master off) stays fail-closed.
    expect(
      plannedRegistrations(cfg({ draftMirrorEnabled: true })).draftMirror,
    ).toBe(false);
    // Master alone (flag off) stays fail-closed.
    expect(
      plannedRegistrations(cfg({ transportEnabled: true })).draftMirror,
    ).toBe(false);
  });
});
