import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type {
  AttachmentManifestEntry,
  SendRecipients,
} from "../domain/models.js";
import type { OutboundMessage } from "../providers/mail-provider.js";

/**
 * Deterministic outbound MIME construction + content hashing.
 *
 * The Message-ID is generated ONCE upstream (in the immutable send snapshot)
 * and threaded through here so the exact same id lands in SMTP DATA and the
 * later Sent copy. Body + attachment hashes are computed the same way the send
 * snapshot's html_hash/text_hash/attachment_manifest are, so the worker can
 * re-verify "the bytes I am about to send match what the user confirmed".
 */

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

/** Compute the attachment manifest (order-stable) for a set of attachments. */
export function computeAttachmentManifest(
  attachments: readonly {
    filename: string;
    contentType: string;
    content: Buffer;
    contentId?: string;
  }[],
): AttachmentManifestEntry[] {
  return attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.content.length,
    sha256: sha256Hex(a.content),
    ...(a.contentId !== undefined ? { contentId: a.contentId } : {}),
  }));
}

export interface BuiltMime {
  readonly raw: Buffer;
  readonly messageId: string;
  readonly htmlHash: string | null;
  readonly textHash: string | null;
  readonly attachmentManifest: AttachmentManifestEntry[];
}

function flattenRecipients(r: SendRecipients): {
  to: string[];
  cc: string[];
  bcc: string[];
  envelopeTo: string[];
} {
  const to = [...r.to];
  const cc = r.cc ? [...r.cc] : [];
  const bcc = r.bcc ? [...r.bcc] : [];
  return { to, cc, bcc, envelopeTo: [...to, ...cc, ...bcc] };
}

/**
 * Build the RFC 5322 message bytes for an outbound message, embedding the
 * pre-generated Message-ID. Returns hashes for confirmation re-verification.
 */
export async function buildOutboundMime(
  message: OutboundMessage,
): Promise<BuiltMime> {
  const { to, cc, bcc } = flattenRecipients(message.recipients);

  const composer = new MailComposer({
    from: message.sender,
    to,
    cc,
    bcc,
    subject: message.subject,
    ...(message.text !== null ? { text: message.text } : {}),
    ...(message.html !== null ? { html: message.html } : {}),
    messageId: message.messageId,
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      ...(a.contentId !== undefined ? { cid: a.contentId } : {}),
    })),
    ...(message.headers !== undefined ? { headers: message.headers } : {}),
  });

  const raw: Buffer = await new Promise((resolve, reject) => {
    composer.compile().build((err, msg) => {
      if (err) {
        reject(err instanceof Error ? err : new Error("mime build failed"));
        return;
      }
      resolve(msg);
    });
  });

  return {
    raw,
    messageId: message.messageId,
    htmlHash: message.html !== null ? sha256Hex(message.html) : null,
    textHash: message.text !== null ? sha256Hex(message.text) : null,
    attachmentManifest: computeAttachmentManifest(message.attachments),
  };
}
