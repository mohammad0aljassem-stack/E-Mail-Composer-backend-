/**
 * Fail-closed environment validation.
 *
 * Invalid/missing required config throws BEFORE any connection, worker, or
 * decryption is attempted. The transport feature flag defaults to DISABLED:
 * when off, no IMAP/SMTP connection starts, no send worker runs, and no
 * credential is decrypted.
 *
 * Nothing here is ever logged with its value (secrets stay opaque).
 */
import { TransportError } from "../domain/errors.js";

export interface TransportConfig {
  /** Master feature flag. Defaults false → fully fail-closed. */
  readonly transportEnabled: boolean;
  /**
   * Sub-capability flags (C2). Every one defaults false and each stored value
   * is the EFFECTIVE value: a sub-flag is true only when its env var parsed
   * true AND the master transportEnabled flag is true. A sub-flag set true
   * with the master off simply fails closed to false (no startup error; the
   * worker startup log surfaces the effective matrix). These are backend
   * runtime controls — deliberately NOT part of the UI schema manifest.
   */
  readonly syncEnabled: boolean;
  readonly idleEnabled: boolean;
  readonly draftMirrorEnabled: boolean;
  readonly mutationsEnabled: boolean;
  readonly sendEnabled: boolean;
  /** Least-privilege worker DB connection string. */
  readonly databaseUrl: string;
  /** pg-boss schema (isolates the queue tables). */
  readonly pgBossSchema: string;
  /** AES-256 credential keyring: version -> 32-byte key (base64). */
  readonly credentialKeyring: ReadonlyMap<number, Buffer>;
  /** The key version new ciphertext is written with. */
  readonly activeKeyVersion: number;
  /** Opaque worker instance id (stable per process). */
  readonly workerId: string;
  /** Global kill switch: when true the worker does no delivery at all. */
  readonly globalKillSwitch: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly heartbeatIntervalMs: number;
  readonly claimLeaseMs: number;
  readonly smtpTimeoutMs: number;
  readonly imapCommandTimeoutMs: number;
  /** Durable sync_requests dispatcher: poll interval. */
  readonly syncDispatchIntervalMs: number;
  /** Durable sync_requests: stale-claim lease timeout. */
  readonly syncClaimLeaseMs: number;
  /** Durable sync_requests: max requests claimed per pass. */
  readonly syncClaimBatchSize: number;
  /** Durable sync_requests: hard cap on durable re-claims before failed. */
  readonly syncMaxAttempts: number;
}

/**
 * STRICT boolean parsing. Safety-relevant flags (feature flag, global kill
 * switch) must never silently coerce: "yes"/"on"/"TRUE "/typos previously
 * parsed to `false`, which for TRANSPORT_GLOBAL_KILL_SWITCH meant DISENGAGED.
 * Anything but exactly "1"/"true"/"0"/"false" now fails closed at startup. The
 * rejected token is echoed bounded — these are boolean-ish flags, never secrets.
 */
function bool(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new TransportError(
    "config_invalid",
    `${name} must be exactly one of 1|true|0|false (got "${value.slice(0, 32)}")`,
  );
}

function int(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TransportError(
      "config_invalid",
      `${name} must be a positive integer`,
    );
  }
  return n;
}

/**
 * Parse a credential keyring from env. Format (never logged):
 *   CREDENTIAL_KEYRING="1:<base64-32B>,2:<base64-32B>"
 *   CREDENTIAL_ACTIVE_KEY_VERSION="2"
 * Empty keyring is allowed ONLY when transport is disabled.
 */
function parseKeyring(
  raw: string | undefined,
  transportEnabled: boolean,
): ReadonlyMap<number, Buffer> {
  const map = new Map<number, Buffer>();
  if (raw === undefined || raw.trim() === "") {
    if (transportEnabled) {
      throw new TransportError(
        "config_invalid",
        "CREDENTIAL_KEYRING is required when MAIL_TRANSPORT_V1_ENABLED is true",
      );
    }
    return map;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) {
      throw new TransportError(
        "config_invalid",
        "CREDENTIAL_KEYRING entry must be 'version:base64key'",
      );
    }
    const version = Number(trimmed.slice(0, sep));
    if (!Number.isInteger(version) || version <= 0) {
      throw new TransportError(
        "config_invalid",
        "CREDENTIAL_KEYRING key version must be a positive integer",
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(trimmed.slice(sep + 1), "base64");
    } catch {
      throw new TransportError(
        "config_invalid",
        "CREDENTIAL_KEYRING key is not valid base64",
      );
    }
    // Strict key-length validation up front (AES-256 requires exactly 32 bytes).
    if (key.length !== 32) {
      throw new TransportError(
        "crypto_key_invalid",
        "CREDENTIAL_KEYRING key must decode to exactly 32 bytes (AES-256)",
      );
    }
    if (map.has(version)) {
      throw new TransportError(
        "config_invalid",
        "CREDENTIAL_KEYRING has a duplicate key version",
      );
    }
    map.set(version, key);
  }
  return map;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): TransportConfig {
  const transportEnabled = bool(
    env.MAIL_TRANSPORT_V1_ENABLED,
    false,
    "MAIL_TRANSPORT_V1_ENABLED",
  );

  // Sub-capability flags (C2): every token is parsed STRICTLY even when the
  // master flag is off (an invalid token always fails startup), THEN masked by
  // the master flag — a sub-capability is effective only when the master is
  // true. sub=true + master=false fails closed to false without throwing.
  const effective = (raw: boolean): boolean => transportEnabled && raw;
  const syncEnabled = effective(
    bool(env.MAIL_SYNC_ENABLED, false, "MAIL_SYNC_ENABLED"),
  );
  const idleEnabled = effective(
    bool(env.MAIL_IDLE_ENABLED, false, "MAIL_IDLE_ENABLED"),
  );
  const draftMirrorEnabled = effective(
    bool(env.MAIL_DRAFT_MIRROR_ENABLED, false, "MAIL_DRAFT_MIRROR_ENABLED"),
  );
  const mutationsEnabled = effective(
    bool(env.MAIL_MUTATIONS_ENABLED, false, "MAIL_MUTATIONS_ENABLED"),
  );
  const sendEnabled = effective(
    bool(env.MAIL_SEND_ENABLED, false, "MAIL_SEND_ENABLED"),
  );

  const databaseUrl = env.DATABASE_URL ?? "";
  if (databaseUrl === "") {
    throw new TransportError("config_invalid", "DATABASE_URL is required");
  }

  const credentialKeyring = parseKeyring(
    env.CREDENTIAL_KEYRING,
    transportEnabled,
  );
  const activeKeyVersion = int(
    env.CREDENTIAL_ACTIVE_KEY_VERSION,
    1,
    "CREDENTIAL_ACTIVE_KEY_VERSION",
  );
  if (transportEnabled && !credentialKeyring.has(activeKeyVersion)) {
    throw new TransportError(
      "config_invalid",
      "CREDENTIAL_ACTIVE_KEY_VERSION has no matching key in CREDENTIAL_KEYRING",
    );
  }

  const logLevelRaw = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) {
    throw new TransportError(
      "config_invalid",
      "LOG_LEVEL must be one of debug|info|warn|error",
    );
  }

  return {
    transportEnabled,
    syncEnabled,
    idleEnabled,
    draftMirrorEnabled,
    mutationsEnabled,
    sendEnabled,
    databaseUrl,
    pgBossSchema: env.PGBOSS_SCHEMA ?? "pgboss",
    credentialKeyring,
    activeKeyVersion,
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    globalKillSwitch: bool(
      env.TRANSPORT_GLOBAL_KILL_SWITCH,
      false,
      "TRANSPORT_GLOBAL_KILL_SWITCH",
    ),
    logLevel: logLevelRaw as TransportConfig["logLevel"],
    heartbeatIntervalMs: int(
      env.HEARTBEAT_INTERVAL_MS,
      15_000,
      "HEARTBEAT_INTERVAL_MS",
    ),
    claimLeaseMs: int(env.CLAIM_LEASE_MS, 60_000, "CLAIM_LEASE_MS"),
    smtpTimeoutMs: int(env.SMTP_TIMEOUT_MS, 30_000, "SMTP_TIMEOUT_MS"),
    imapCommandTimeoutMs: int(
      env.IMAP_COMMAND_TIMEOUT_MS,
      30_000,
      "IMAP_COMMAND_TIMEOUT_MS",
    ),
    syncDispatchIntervalMs: int(
      env.SYNC_DISPATCH_INTERVAL_MS,
      5_000,
      "SYNC_DISPATCH_INTERVAL_MS",
    ),
    syncClaimLeaseMs: int(
      env.SYNC_CLAIM_LEASE_MS,
      300_000,
      "SYNC_CLAIM_LEASE_MS",
    ),
    syncClaimBatchSize: int(
      env.SYNC_CLAIM_BATCH_SIZE,
      10,
      "SYNC_CLAIM_BATCH_SIZE",
    ),
    syncMaxAttempts: int(env.SYNC_MAX_ATTEMPTS, 5, "SYNC_MAX_ATTEMPTS"),
  };
}
