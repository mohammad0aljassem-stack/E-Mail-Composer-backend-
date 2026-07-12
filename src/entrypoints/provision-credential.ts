/**
 * TEST-ONLY synthetic credential provisioning CLI.
 *
 * Encrypts a SYNTHETIC IMAP/SMTP credential and writes ONLY ciphertext columns
 * to transport.mailbox_credentials. Guarantees:
 *   - Secrets are read from stdin or a temp env var, NEVER argv, NEVER echoed.
 *   - No plaintext is written to disk or logged.
 *   - REFUSES to run against anything that looks like the production project
 *     (ref fpanvpxjjddhasjmpflz or any *.supabase.co URL / hosted target).
 *
 * This is not a production provisioning tool. Production worker-role + real
 * credential provisioning is a separate, manual, audited operation.
 */
import { readFileSync } from "node:fs";
import { AesGcmCredentialCipher } from "../crypto/aes-gcm-cipher.js";
import { loadConfig } from "../config/env.js";
import { PgDatabase } from "../db/pool.js";
import { serializeAad } from "../crypto/credential-cipher.js";

const PROD_PROJECT_REF = "fpanvpxjjddhasjmpflz";

export interface ProvisionRefusalCheck {
  refused: boolean;
  reason?: string;
}

/** Pure guard (unit-tested): refuse prod project refs / hosted supabase URLs. */
export function checkProductionRefusal(target: string): ProvisionRefusalCheck {
  const t = target.toLowerCase();
  if (t.includes(PROD_PROJECT_REF)) {
    return {
      refused: true,
      reason: "target references the production project ref",
    };
  }
  if (/\.supabase\.co(?::|\/|$)/.test(t) || t.includes(".supabase.co")) {
    return { refused: true, reason: "target is a hosted *.supabase.co URL" };
  }
  if (t.includes("supabase.in") || t.includes("pooler.supabase.com")) {
    return { refused: true, reason: "target is a hosted Supabase pooler" };
  }
  return { refused: false };
}

function readSecretFromStdin(): string {
  // Read the synthetic secret JSON from stdin (fd 0). Never from argv.
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const mailboxId = process.env.PROVISION_MAILBOX_ID ?? "";
  const workspaceId = process.env.PROVISION_WORKSPACE_ID ?? "";
  if (mailboxId === "" || workspaceId === "") {
    throw new Error(
      "PROVISION_MAILBOX_ID and PROVISION_WORKSPACE_ID are required",
    );
  }

  const config = loadConfig();

  // Refuse production targets before touching anything.
  const refusal = checkProductionRefusal(config.databaseUrl);
  if (refusal.refused) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "provisioning_refused",
        reason: refusal.reason,
      }),
    );
    process.exit(2);
  }

  const secret = readSecretFromStdin();
  if (secret === "") {
    throw new Error("no synthetic credential provided on stdin");
  }

  const cipher = new AesGcmCredentialCipher({
    keyring: config.credentialKeyring,
    activeKeyVersion: config.activeKeyVersion,
  });
  const aad = { workspaceId, mailboxId, purpose: "combined" };
  const enc = cipher.encrypt(Buffer.from(secret, "utf8"), aad);

  const db = new PgDatabase({ connectionString: config.databaseUrl });
  try {
    await db.query(
      `insert into transport.mailbox_credentials
         (mailbox_id, ciphertext, nonce, auth_tag, algorithm, key_version, aad)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        mailboxId,
        enc.ciphertext,
        enc.nonce,
        enc.authTag,
        enc.algorithm,
        enc.keyVersion,
        serializeAad(aad),
      ],
    );
    // NEVER log the secret; only a content-free confirmation.
    console.error(
      JSON.stringify({
        level: "info",
        msg: "credential_provisioned",
        mailbox_id: mailboxId,
      }),
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "provisioning_failed",
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
    process.exit(1);
  });
}
