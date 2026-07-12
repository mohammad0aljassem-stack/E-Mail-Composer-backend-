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
