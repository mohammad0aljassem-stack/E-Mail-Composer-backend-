import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { TransportError } from "../../domain/errors.js";
import { boundHeader } from "../../mime/sanitize.js";
import type {
  ImapAppendResult,
  ImapClient,
  ImapFetchedMessage,
  ImapFolderStatus,
  ImapIdleSignal,
} from "./ports.js";

/**
 * Real IMAP adapter over ImapFlow.
 *
 * Only ONE command stream is active at a time (ImapFlow serializes via
 * getMailboxLock). We fetch envelope + flags + size ONLY — never the body — so
 * no message content is retained or logged. Folder roles come from SPECIAL-USE
 * when available, else a conservative name heuristic.
 */

function roleFromFlagsAndName(
  specialUse: string | undefined,
  name: string,
): ImapFolderStatus["role"] {
  const su = (specialUse ?? "").toLowerCase();
  if (su.includes("sent")) return "sent";
  if (su.includes("drafts")) return "drafts";
  if (su.includes("trash")) return "trash";
  if (su.includes("junk")) return "junk";
  if (su.includes("archive")) return "archive";
  const n = name.toLowerCase();
  if (n === "inbox") return "inbox";
  if (n.includes("sent")) return "sent";
  if (n.includes("draft")) return "drafts";
  if (n.includes("trash") || n.includes("deleted")) return "trash";
  if (n.includes("junk") || n.includes("spam")) return "junk";
  if (n.includes("archive")) return "archive";
  return "other";
}

export class ImapFlowClient implements ImapClient {
  private readonly client: ImapFlow;

  public constructor(options: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    timeoutMs: number;
  }) {
    const opts: ImapFlowOptions = {
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: { user: options.auth.user, pass: options.auth.pass },
      logger: false, // never let imapflow log content
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    };
    this.client = new ImapFlow(opts);
  }

  public async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (cause) {
      throw new TransportError(
        "provider_connect_failed",
        "imap connect failed",
        {
          retryable: true,
          cause,
        },
      );
    }
  }

  public async listFolders(): Promise<readonly ImapFolderStatus[]> {
    const list = await this.client.list();
    const out: ImapFolderStatus[] = [];
    for (const box of list) {
      const status = await this.client.status(box.path, {
        uidValidity: true,
        uidNext: true,
        highestModseq: true,
      });
      out.push({
        name: box.path,
        role: roleFromFlagsAndName(box.specialUse, box.path),
        uidvalidity: status.uidValidity ?? 0n,
        uidnext: BigInt(status.uidNext ?? 0),
        highestModseq: status.highestModseq ?? null,
      });
    }
    return out;
  }

  public async statusFolder(folder: string): Promise<ImapFolderStatus> {
    const status = await this.client.status(folder, {
      uidValidity: true,
      uidNext: true,
      highestModseq: true,
    });
    return {
      name: folder,
      role: null,
      uidvalidity: status.uidValidity ?? 0n,
      uidnext: BigInt(status.uidNext ?? 0),
      highestModseq: status.highestModseq ?? null,
    };
  }

  public async fetchSince(
    folder: string,
    sinceUid: bigint,
    limit: number,
  ): Promise<{ uidvalidity: bigint; messages: readonly ImapFetchedMessage[] }> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const mailbox = this.client.mailbox;
      const uidvalidity =
        typeof mailbox === "object" ? (mailbox.uidValidity ?? 0n) : 0n;
      const messages: ImapFetchedMessage[] = [];
      const range = `${(sinceUid + 1n).toString()}:*`;
      for await (const msg of this.client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        if (BigInt(msg.uid) <= sinceUid) continue; // '*' can echo the last uid
        messages.push(this.toFetched(msg, uidvalidity));
        if (messages.length >= limit) break;
      }
      messages.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
      return { uidvalidity, messages };
    } finally {
      lock.release();
    }
  }

  public async fetchOne(
    folder: string,
    uid: bigint,
  ): Promise<{ uidvalidity: bigint; message: ImapFetchedMessage | null }> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const mailbox = this.client.mailbox;
      const uidvalidity =
        typeof mailbox === "object" ? (mailbox.uidValidity ?? 0n) : 0n;
      const msg = await this.client.fetchOne(
        uid.toString(),
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
        },
        { uid: true },
      );
      if (msg === false || msg === undefined) {
        return { uidvalidity, message: null };
      }
      return { uidvalidity, message: this.toFetched(msg, uidvalidity) };
    } finally {
      lock.release();
    }
  }

  public async append(
    folder: string,
    mime: Buffer,
    flags: readonly string[],
  ): Promise<ImapAppendResult> {
    const res = await this.client.append(folder, mime, [...flags]);
    if (res === false || res.uid === undefined) {
      throw new TransportError(
        "provider_protocol_error",
        "append returned no uid",
      );
    }
    return {
      uid: BigInt(res.uid),
      uidvalidity: res.uidValidity ?? 0n,
    };
  }

  public async addFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageFlagsAdd(uid.toString(), [...flags], {
        uid: true,
      });
    } finally {
      lock.release();
    }
  }

  public async removeFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageFlagsRemove(uid.toString(), [...flags], {
        uid: true,
      });
    } finally {
      lock.release();
    }
  }

  public async moveMessage(
    folder: string,
    uid: bigint,
    toFolder: string,
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageMove(uid.toString(), toFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  public async searchByMessageId(
    folder: string,
    messageId: string,
  ): Promise<bigint | null> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const uids = await this.client.search(
        { header: { "message-id": messageId } },
        {
          uid: true,
        },
      );
      if (uids === false || uids.length === 0) return null;
      const first = uids[0];
      return first === undefined ? null : BigInt(first);
    } finally {
      lock.release();
    }
  }

  public async idle(
    folder: string,
    timeoutMs: number,
  ): Promise<ImapIdleSignal | null> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      return await new Promise<ImapIdleSignal | null>((resolve) => {
        const timer = setTimeout(() => {
          this.client.removeListener("exists", onExists);
          resolve(null);
        }, timeoutMs);
        const onExists = (): void => {
          clearTimeout(timer);
          this.client.removeListener("exists", onExists);
          resolve({ kind: "exists" });
        };
        this.client.on("exists", onExists);
        void this.client.idle();
      });
    } finally {
      lock.release();
    }
  }

  public async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // best-effort; connection may already be gone
    }
  }

  private toFetched(
    msg: {
      uid: number;
      envelope?: {
        messageId?: string;
        inReplyTo?: string;
        subject?: string;
        from?: { address?: string; name?: string }[];
        to?: { address?: string; name?: string }[];
        date?: Date;
      };
      flags?: Set<string>;
      size?: number;
      bodyStructure?: { childNodes?: unknown[]; disposition?: string };
    },
    uidvalidity: bigint,
  ): ImapFetchedMessage {
    const env = msg.envelope ?? {};
    const from = (env.from ?? [])
      .map((a) => a.address ?? a.name ?? "")
      .filter((s) => s !== "")
      .join(", ");
    const to = (env.to ?? [])
      .map((a) => a.address ?? a.name ?? "")
      .filter((s) => s !== "")
      .join(", ");
    const hasAttachments =
      msg.bodyStructure?.disposition === "attachment" ||
      (msg.bodyStructure?.childNodes?.length ?? 0) > 1;
    return {
      uid: BigInt(msg.uid),
      uidvalidity,
      messageId: boundHeader(env.messageId ?? null, 998),
      inReplyTo: boundHeader(env.inReplyTo ?? null, 998),
      referencesHeader: null,
      subject: boundHeader(env.subject ?? null, 2000),
      fromSummary: boundHeader(from, 2000),
      toSummary: boundHeader(to, 4000),
      internalDate: env.date ?? null,
      sizeBytes: msg.size !== undefined ? BigInt(msg.size) : null,
      flags: msg.flags ? [...msg.flags] : [],
      hasAttachments,
    };
  }
}
