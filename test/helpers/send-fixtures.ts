import { recomputeConfirmationProof } from "../../src/domain/confirmation-proof.js";
import type {
  MailboxRow,
  SendAttemptRow,
  SendIntentRow,
  SendRecipients,
} from "../../src/domain/models.js";
import type { SendState } from "../../src/domain/send-state.js";
import { buildOutboundMime } from "../../src/mime/outbound-builder.js";
import type { OutboundMessage } from "../../src/providers/mail-provider.js";
import type { ResolvedSendPayload } from "../../src/workers/ports.js";

export const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
export const MAILBOX_ID = "22222222-2222-2222-2222-222222222222";
export const DRAFT_ID = "33333333-3333-3333-3333-333333333333";
export const USER_ID = "44444444-4444-4444-4444-444444444444";
export const INTENT_ID = "55555555-5555-5555-5555-555555555555";
export const ATTEMPT_ID = "66666666-6666-6666-6666-666666666666";
export const MESSAGE_ID = "<abc-123@mail.example.com>";

export function sendableMailbox(
  overrides: Partial<MailboxRow> = {},
): MailboxRow {
  return {
    id: MAILBOX_ID,
    workspaceId: WORKSPACE_ID,
    provider: "imap_smtp",
    emailAddress: "sender@mail.example.com",
    displayName: null,
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
    enabled: true,
    killSwitch: false,
    lastSyncedAt: null,
    ...overrides,
  };
}

export interface BuiltFixture {
  intent: SendIntentRow;
  attempt: (state: SendState, version?: bigint) => SendAttemptRow;
  payload: ResolvedSendPayload;
  message: OutboundMessage;
}

/**
 * Build a consistent intent + payload where the confirmation proof and body
 * hashes/manifest are all internally correct (the "happy path"). Tamper the
 * returned intent to exercise mismatch cases.
 */
export async function buildFixture(options?: {
  html?: string | null;
  text?: string | null;
  revision?: bigint;
  recipients?: SendRecipients;
}): Promise<BuiltFixture> {
  const html = options?.html ?? "<p>Hello</p>";
  const text = options?.text ?? "Hello";
  const revision = options?.revision ?? 1n;
  const message: OutboundMessage = {
    messageId: MESSAGE_ID,
    sender: "sender@mail.example.com",
    recipients: options?.recipients ?? { to: ["recipient@example.com"] },
    subject: "Test subject",
    html,
    text,
    attachments: [],
  };
  const built = await buildOutboundMime(message);

  const intent: SendIntentRow = {
    id: INTENT_ID,
    workspaceId: WORKSPACE_ID,
    mailboxId: MAILBOX_ID,
    draftId: DRAFT_ID,
    draftRevision: revision,
    sender: message.sender,
    recipients: message.recipients,
    subject: message.subject,
    htmlHash: built.htmlHash,
    textHash: built.textHash,
    attachmentManifest: built.attachmentManifest,
    messageId: MESSAGE_ID,
    idempotencyKey: "idem-key-1",
    templateVersionId: null,
    signatureId: null,
    confirmedBy: USER_ID,
    confirmationProof: "",
    contractVersion: 1,
    proofVersion: 1,
    draftVersionId: null,
  };
  intent.confirmationProof = recomputeConfirmationProof(intent);

  const attempt = (state: SendState, version = 1n): SendAttemptRow => ({
    id: ATTEMPT_ID,
    workspaceId: WORKSPACE_ID,
    sendIntentId: INTENT_ID,
    state,
    claimedBy: null,
    claimedAt: null,
    messageId: state === "confirmed" ? MESSAGE_ID : MESSAGE_ID,
    smtpResponse: null,
    evidence: {},
    version,
  });

  return {
    intent,
    attempt,
    payload: { revision, message },
    message,
  };
}
