import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { TransportError } from "../../src/domain/errors.js";

const key32 = Buffer.alloc(32, 7).toString("base64");

describe("env config (fail-closed)", () => {
  it("defaults the transport flag to false", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://localhost/db" });
    expect(cfg.transportEnabled).toBe(false);
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(TransportError);
  });

  it("requires a keyring when transport is enabled", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/db",
        MAIL_TRANSPORT_V1_ENABLED: "true",
      }),
    ).toThrow(TransportError);
  });

  it("accepts a valid enabled config", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://localhost/db",
      MAIL_TRANSPORT_V1_ENABLED: "true",
      CREDENTIAL_KEYRING: `1:${key32}`,
      CREDENTIAL_ACTIVE_KEY_VERSION: "1",
    });
    expect(cfg.transportEnabled).toBe(true);
    expect(cfg.credentialKeyring.get(1)?.length).toBe(32);
  });

  it("rejects a keyring key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/db",
        MAIL_TRANSPORT_V1_ENABLED: "true",
        CREDENTIAL_KEYRING: `1:${Buffer.alloc(16, 1).toString("base64")}`,
        CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      }),
    ).toThrow(TransportError);
  });

  it("rejects an active key version missing from the keyring", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/db",
        MAIL_TRANSPORT_V1_ENABLED: "true",
        CREDENTIAL_KEYRING: `1:${key32}`,
        CREDENTIAL_ACTIVE_KEY_VERSION: "2",
      }),
    ).toThrow(TransportError);
  });

  it("allows an empty keyring only when transport is disabled", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://localhost/db" });
    expect(cfg.credentialKeyring.size).toBe(0);
  });
});

describe("capability flags (fail-closed, Phase 3B C2)", () => {
  const base = { DATABASE_URL: "postgres://localhost/db" };
  const masterOn = {
    ...base,
    MAIL_TRANSPORT_V1_ENABLED: "true",
    CREDENTIAL_KEYRING: `1:${key32}`,
    CREDENTIAL_ACTIVE_KEY_VERSION: "1",
  };
  const FLAG_NAMES = [
    "MAIL_SYNC_ENABLED",
    "MAIL_IDLE_ENABLED",
    "MAIL_DRAFT_MIRROR_ENABLED",
    "MAIL_MUTATIONS_ENABLED",
    "MAIL_SEND_ENABLED",
  ] as const;

  it("every sub-capability flag defaults to false (master on)", () => {
    const cfg = loadConfig(masterOn);
    expect(cfg.syncEnabled).toBe(false);
    expect(cfg.idleEnabled).toBe(false);
    expect(cfg.draftMirrorEnabled).toBe(false);
    expect(cfg.mutationsEnabled).toBe(false);
    expect(cfg.sendEnabled).toBe(false);
  });

  it("a sub-flag true with the master off yields effective false, no throw", () => {
    const cfg = loadConfig({
      ...base,
      MAIL_SYNC_ENABLED: "true",
      MAIL_IDLE_ENABLED: "1",
      MAIL_DRAFT_MIRROR_ENABLED: "true",
      MAIL_MUTATIONS_ENABLED: "1",
      MAIL_SEND_ENABLED: "true",
    });
    expect(cfg.transportEnabled).toBe(false);
    expect(cfg.syncEnabled).toBe(false);
    expect(cfg.idleEnabled).toBe(false);
    expect(cfg.draftMirrorEnabled).toBe(false);
    expect(cfg.mutationsEnabled).toBe(false);
    expect(cfg.sendEnabled).toBe(false);
  });

  it("a sub-flag is effective only when master AND sub are true (Gate F)", () => {
    const cfg = loadConfig({ ...masterOn, MAIL_SYNC_ENABLED: "true" });
    expect(cfg.syncEnabled).toBe(true);
    // Every other capability stays off.
    expect(cfg.idleEnabled).toBe(false);
    expect(cfg.draftMirrorEnabled).toBe(false);
    expect(cfg.mutationsEnabled).toBe(false);
    expect(cfg.sendEnabled).toBe(false);
  });

  it.each(FLAG_NAMES)(
    "rejects an invalid token for %s even when the master flag is off",
    (name) => {
      expect(() => loadConfig({ ...base, [name]: "yes" })).toThrow(
        TransportError,
      );
      expect(() => loadConfig({ ...base, [name]: "on" })).toThrow(
        TransportError,
      );
    },
  );

  it.each(FLAG_NAMES)("applies the false default for empty %s", (name) => {
    const cfg = loadConfig({ ...masterOn, [name]: "" });
    expect(cfg.syncEnabled).toBe(false);
    expect(cfg.idleEnabled).toBe(false);
    expect(cfg.draftMirrorEnabled).toBe(false);
    expect(cfg.mutationsEnabled).toBe(false);
    expect(cfg.sendEnabled).toBe(false);
  });
});

describe("strict boolean env parsing (C5)", () => {
  const base = { DATABASE_URL: "postgres://localhost/db" };

  it.each(["yes", "on", "TRUE ", "enabled", "tru"])(
    "rejects TRANSPORT_GLOBAL_KILL_SWITCH=%j (never silently DISENGAGED)",
    (value) => {
      expect(() =>
        loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: value }),
      ).toThrow(TransportError);
    },
  );

  it.each(["yes", "on", "TRUE ", "garbage"])(
    "rejects MAIL_TRANSPORT_V1_ENABLED=%j",
    (value) => {
      expect(() =>
        loadConfig({ ...base, MAIL_TRANSPORT_V1_ENABLED: value }),
      ).toThrow(TransportError);
    },
  );

  it("accepts exactly 1/true/0/false", () => {
    expect(
      loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: "1" })
        .globalKillSwitch,
    ).toBe(true);
    expect(
      loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: "true" })
        .globalKillSwitch,
    ).toBe(true);
    expect(
      loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: "0" })
        .globalKillSwitch,
    ).toBe(false);
    expect(
      loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: "false" })
        .globalKillSwitch,
    ).toBe(false);
  });

  it("still applies defaults for undefined and empty string", () => {
    expect(loadConfig(base).globalKillSwitch).toBe(false);
    expect(loadConfig(base).transportEnabled).toBe(false);
    expect(
      loadConfig({ ...base, TRANSPORT_GLOBAL_KILL_SWITCH: "" })
        .globalKillSwitch,
    ).toBe(false);
  });
});

describe("SYNC_MAX_BATCHES_PER_JOB (durable multi-batch loop bound)", () => {
  const base = { DATABASE_URL: "postgres://localhost/db" };

  it("defaults to 10", () => {
    expect(loadConfig(base).syncMaxBatchesPerJob).toBe(10);
    expect(
      loadConfig({ ...base, SYNC_MAX_BATCHES_PER_JOB: "" })
        .syncMaxBatchesPerJob,
    ).toBe(10);
  });

  it("accepts a positive integer", () => {
    expect(
      loadConfig({ ...base, SYNC_MAX_BATCHES_PER_JOB: "1" })
        .syncMaxBatchesPerJob,
    ).toBe(1);
  });

  it.each(["0", "-1", "2.5", "ten", "1e2x"])(
    "rejects %j via the strict int parser (must be >= 1)",
    (value) => {
      expect(() =>
        loadConfig({ ...base, SYNC_MAX_BATCHES_PER_JOB: value }),
      ).toThrow(TransportError);
    },
  );
});

describe("IDLE coordinator settings (C7)", () => {
  const base = { DATABASE_URL: "postgres://localhost/db" };

  it("applies the documented defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.idleTimeoutMs).toBe(300_000);
    expect(cfg.idleBackoffMinMs).toBe(5_000);
    expect(cfg.idleBackoffMaxMs).toBe(300_000);
    expect(cfg.idleRescanMs).toBe(60_000);
    expect(cfg.idleMaxSessions).toBe(10);
  });

  it("accepts explicit positive integers", () => {
    const cfg = loadConfig({
      ...base,
      IDLE_TIMEOUT_MS: "60000",
      IDLE_BACKOFF_MIN_MS: "1000",
      IDLE_BACKOFF_MAX_MS: "30000",
      IDLE_RESCAN_MS: "5000",
      IDLE_MAX_SESSIONS: "2",
    });
    expect(cfg.idleTimeoutMs).toBe(60_000);
    expect(cfg.idleBackoffMinMs).toBe(1_000);
    expect(cfg.idleBackoffMaxMs).toBe(30_000);
    expect(cfg.idleRescanMs).toBe(5_000);
    expect(cfg.idleMaxSessions).toBe(2);
  });

  it("rejects an inverted backoff window (max < min) at startup", () => {
    expect(() =>
      loadConfig({
        ...base,
        IDLE_BACKOFF_MIN_MS: "10000",
        IDLE_BACKOFF_MAX_MS: "5000",
      }),
    ).toThrow(TransportError);
  });

  it.each([
    "IDLE_TIMEOUT_MS",
    "IDLE_BACKOFF_MIN_MS",
    "IDLE_BACKOFF_MAX_MS",
    "IDLE_RESCAN_MS",
    "IDLE_MAX_SESSIONS",
  ])("rejects a non-positive %s via the strict int parser", (name) => {
    expect(() => loadConfig({ ...base, [name]: "0" })).toThrow(TransportError);
  });
});
