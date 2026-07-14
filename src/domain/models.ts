import type { SendState } from "./send-state.js";

/**
 * Domain model types shared across db, providers, queues and workers. These
 * mirror the canonical transport schema columns (see the UI repo migration
 * 20260713100000_transport_foundation.sql, whose checksum is pinned via the UI
 * manifest and the backend lock — not duplicated here) but are expressed as
 * explicit TypeScript contracts — never a broad Record.
 */

export type FolderRole =
  "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "other";

export interface MailboxRow {
  id: string;
  workspaceId: string;
  provider: "imap_smtp";
  emailAddress: string;
  displayName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecurity: "ssl" | "starttls" | "none" | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: "ssl" | "starttls" | "none" | null;
  enabled: boolean;
  killSwitch: boolean;
  lastSyncedAt: Date | null;
}

export interface MailboxFolderRow {
  id: string;
  workspaceId: string;
  mailboxId: string;
  name: string;
  role: FolderRole | null;
  uidvalidity: bigint | null;
  uidnext: bigint | null;
  lastSeenUid: bigint | null;
  highestModseq: bigint | null;
  lastSyncedAt: Date | null;
}

/** Metadata ONLY — never any body/content. */
export interface MailMessageMeta {
  workspaceId: string;
  mailboxId: string;
  folderId: string;
  uidvalidity: bigint;
  uid: bigint;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  subject: string | null;
  fromSummary: string | null;
  toSummary: string | null;
  internalDate: Date | null;
  sizeBytes: bigint | null;
  flags: string[];
  hasAttachments: boolean;
}

export interface DraftMirrorRow {
  id: string;
  workspaceId: string;
  draftId: string;
  mailboxId: string;
  remoteUid: bigint | null;
  remoteUidvalidity: bigint | null;
  mirroredRevision: bigint | null;
  status: "pending" | "mirrored" | "stale" | "failed";
}

/**
 * The EXACT confirmed-content snapshot bound to one immutable send intent,
 * returned by the PRIVATE worker-only function transport.get_send_snapshot(
 * send_intent_id). The worker NEVER reads public.draft_versions (no table grant)
 * nor the mutable drafts row: this function is the single read path and it fails
 * closed (P0002) for a missing/legacy/inconsistent intent, so a returned row is
 * always the exact workspace/draft/revision the user confirmed. body_json is the
 * canonical TipTap-style doc (jsonb, ≤ 1 MiB) rendered by the deterministic
 * draft-renderer; the executor's verifyIntegrity re-checks the rendered hashes.
 */
export interface SendSnapshotRow {
  draftVersionId: string;
  workspaceId: string;
  draftId: string;
  sourceRevision: bigint;
  versionNo: bigint;
  subject: string;
  bodyJson: unknown;
}

/**
 * Newest snapshot of one EXACT (workspace, draft, source_revision) triple,
 * returned by the PRIVATE worker-only function transport.get_mirror_snapshot(
 * workspace_id, draft_id, source_revision) — the draft-mirror read path (never
 * used for sending). Fails closed (P0002) when no such snapshot exists. Carries
 * no created_at: mirror MIME headers are pinned deterministically without it.
 */
export interface MirrorSnapshotRow {
  draftVersionId: string;
  versionNo: bigint;
  subject: string;
  bodyJson: unknown;
}

export interface AttachmentManifestEntry {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  contentId?: string;
}

export interface SendRecipients {
  to: string[];
  cc?: string[];
  bcc?: string[];
}

/** IMMUTABLE confirmed send snapshot (send_intents). */
export interface SendIntentRow {
  id: string;
  workspaceId: string;
  mailboxId: string;
  draftId: string;
  draftRevision: bigint;
  sender: string;
  recipients: SendRecipients;
  subject: string;
  htmlHash: string | null;
  textHash: string | null;
  attachmentManifest: AttachmentManifestEntry[];
  messageId: string;
  idempotencyKey: string;
  templateVersionId: string | null;
  signatureId: string | null;
  confirmedBy: string;
  confirmationProof: string;
  contractVersion: number;
  /**
   * Phase 3B (contract v2): the confirmation-proof canonical version. 1 = legacy
   * (inputs only); 2 = the canonical additionally covers proof_version and the
   * exact draft_version_id snapshot reference. Drives the worker's proof
   * re-derivation shape.
   */
  proofVersion: number;
  /**
   * Phase 3B: the immutable draft_versions snapshot the intent is bound to (v2),
   * or null for a legacy (proof-v1) intent. Part of the v2 proof canonical. NOT
   * a resolution key — the worker reads content only via get_send_snapshot.
   */
  draftVersionId: string | null;
}

export interface SendAttemptRow {
  id: string;
  workspaceId: string;
  sendIntentId: string;
  state: SendState;
  claimedBy: string | null;
  claimedAt: Date | null;
  messageId: string | null;
  smtpResponse: string | null;
  evidence: Readonly<Record<string, string | number | boolean>>;
  version: bigint;
}

export interface StoredCredential {
  id: string;
  mailboxId: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer | null;
  algorithm: string;
  keyVersion: number;
  aad: string;
}

export type SyncRequestStatus = "pending" | "claimed" | "completed" | "failed";

/**
 * A durable, claimable mailbox-sync request (transport.sync_requests). Inserted
 * ONLY by the SECURITY DEFINER RPC `request_mailbox_sync`; the worker holds
 * exactly SELECT + UPDATE (never INSERT/DELETE) and drives the lifecycle
 * pending -> claimed -> completed|failed. `folder === null` means a whole-mailbox
 * sync; a non-null value narrows it to one folder. `lastError` is content-free
 * and bounded (a short code only — never body/MIME/credentials/provider payload).
 */
export interface SyncRequestRow {
  id: string;
  workspaceId: string;
  mailboxId: string;
  folder: string | null;
  status: SyncRequestStatus;
  requestedBy: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
}
