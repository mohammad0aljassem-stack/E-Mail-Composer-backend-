import { createHash } from "node:crypto";
import type { SendIntentRow } from "./models.js";

/**
 * Independent re-derivation of `send_intents.confirmation_proof`.
 *
 * The proof is computed server-side by the SQL RPC `create_send_intent` as:
 *   sha256( jsonb_build_object( ...canonical snapshot... )::text )  (hex)
 *
 * Postgres `jsonb` normalizes object key order (by key length, then bytewise)
 * and strips insignificant whitespace. To re-verify the proof in the worker we
 * reproduce that exact canonical text. This lets the safe-send path prove
 * "the confirmation proof matches the exact bytes I am about to send" without
 * trusting the mutable draft row. Parity with Postgres is asserted by an
 * integration test that compares this output to a real create_send_intent.
 */

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** jsonb object key ordering: shorter keys first, then bytewise (UTF-8). */
function compareKeys(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

/** Serialize a value the way Postgres renders jsonb::text. */
export function pgJsonbCanonical(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in jsonb");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => pgJsonbCanonical(v)).join(", ")}]`;
  }
  const keys = Object.keys(value).sort(compareKeys);
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}: ${pgJsonbCanonical(value[k] as JsonValue)}`,
  );
  return `{${parts.join(", ")}}`;
}

/**
 * Build the canonical snapshot object exactly as the SQL RPC does, then hash.
 * `draftRevision` is a jsonb number (bigint values here are within safe range
 * for the revision counter; represented as a number to match jsonb).
 *
 * Proof versions (server-owned; the intent carries `proofVersion`):
 *   1 (legacy) — inputs only (the 15 fields below).
 *   2 (Phase 3B) — the canonical ADDITIONALLY covers `proof_version` and the
 *     exact `draft_version_id` snapshot reference, matching create_send_intent's
 *     v2 canonical. jsonb re-sorts keys, so insertion order is irrelevant.
 */
export function recomputeConfirmationProof(intent: SendIntentRow): string {
  const snapshot: { [k: string]: JsonValue } = {
    workspace_id: intent.workspaceId,
    mailbox_id: intent.mailboxId,
    draft_id: intent.draftId,
    draft_revision: Number(intent.draftRevision),
    sender: intent.sender,
    recipients: intent.recipients as unknown as JsonValue,
    subject: intent.subject,
    html_hash: intent.htmlHash,
    text_hash: intent.textHash,
    attachment_manifest: intent.attachmentManifest as unknown as JsonValue,
    template_version_id: intent.templateVersionId,
    signature_id: intent.signatureId,
    message_id: intent.messageId,
    contract_version: intent.contractVersion,
    confirmed_by: intent.confirmedBy,
  };
  if (intent.proofVersion === 2) {
    snapshot.proof_version = 2;
    snapshot.draft_version_id = intent.draftVersionId;
  }
  const canonical = pgJsonbCanonical(snapshot);
  return createHash("sha256")
    .update(Buffer.from(canonical, "utf8"))
    .digest("hex");
}
