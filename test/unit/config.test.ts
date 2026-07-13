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
