import { TransportError } from "../../src/domain/errors.js";
import type {
  ImapAppendResult,
  ImapClient,
  ImapFetchedMessage,
  ImapFolderStatus,
  ImapIdleSignal,
} from "../../src/providers/imap-smtp/ports.js";

/**
 * Deterministic in-repo fake IMAP server + client.
 *
 * Models folder identity, UID/UIDVALIDITY/UIDNEXT, fetch, append (Drafts/Sent),
 * flag mutation, move, search-by-Message-ID and IDLE wake-up signals — with no
 * network. Failure/uidvalidity injection is explicit so tests are reproducible.
 * The container registry is blocked, so this fake is where IMAP coverage lives.
 */

interface FakeMessage {
  uid: bigint;
  flags: Set<string>;
  messageId: string | null;
  references: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  size: bigint;
  internalDate: Date;
  hasAttachments: boolean;
  /** Exact appended MIME bytes (null for seeded messages) — lets tests byte-
   *  compare the Sent copy against the SMTP submission (C5 build-once). */
  raw: Buffer | null;
}

interface FakeFolder {
  name: string;
  role: ImapFolderStatus["role"];
  uidvalidity: bigint;
  uidnext: bigint;
  messages: Map<string, FakeMessage>;
  pendingSignals: ImapIdleSignal[];
}

function parseMessageId(mime: Buffer): string | null {
  const m = /^message-id:\s*(<[^>\r\n]+>)/im.exec(mime.toString("utf8"));
  return m?.[1] ?? null;
}

function parseHeader(mime: Buffer, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = re.exec(mime.toString("utf8"));
  return m?.[1]?.trim() ?? null;
}

export class FakeImapServer {
  private readonly folders = new Map<string, FakeFolder>();
  public authOk = true;
  public connectOk = true;

  public addFolder(input: {
    name: string;
    role?: ImapFolderStatus["role"];
    uidvalidity?: bigint;
  }): void {
    this.folders.set(input.name, {
      name: input.name,
      role: input.role ?? null,
      uidvalidity: input.uidvalidity ?? 1n,
      uidnext: 1n,
      messages: new Map(),
      pendingSignals: [],
    });
  }

  public folder(name: string): FakeFolder {
    const f = this.folders.get(name);
    if (f === undefined) {
      throw new TransportError("provider_protocol_error", "no such folder", {
        context: { folder: name },
      });
    }
    return f;
  }

  public listFolderNames(): string[] {
    return [...this.folders.keys()];
  }

  /** Inject a message (as if it arrived on the server). */
  public seedMessage(
    folderName: string,
    input: Partial<Omit<FakeMessage, "uid">> & { messageId?: string | null },
  ): bigint {
    const f = this.folder(folderName);
    const uid = f.uidnext;
    f.uidnext = f.uidnext + 1n;
    f.messages.set(uid.toString(), {
      uid,
      flags: new Set(input.flags ?? []),
      messageId: input.messageId ?? null,
      references: input.references ?? null,
      subject: input.subject ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      size: input.size ?? 100n,
      internalDate: input.internalDate ?? new Date("2026-01-01T00:00:00Z"),
      hasAttachments: input.hasAttachments ?? false,
      raw: input.raw ?? null,
    });
    return uid;
  }

  /** Explicitly change UIDVALIDITY (simulate a server-side reset). */
  public changeUidValidity(folderName: string, newValidity: bigint): void {
    const f = this.folder(folderName);
    f.uidvalidity = newValidity;
    f.uidnext = 1n;
    f.messages.clear();
  }

  public queueIdleSignal(folderName: string, signal: ImapIdleSignal): void {
    this.folder(folderName).pendingSignals.push(signal);
  }
}

export class FakeImapClient implements ImapClient {
  private connected = false;
  public constructor(private readonly server: FakeImapServer) {}

  public connect(): Promise<void> {
    if (!this.server.connectOk) {
      return Promise.reject(
        new TransportError("provider_connect_failed", "connect failed", {
          retryable: true,
        }),
      );
    }
    if (!this.server.authOk) {
      return Promise.reject(
        new TransportError("provider_auth_failed", "auth failed"),
      );
    }
    this.connected = true;
    return Promise.resolve();
  }

  private ensure(): void {
    if (!this.connected) {
      throw new TransportError("provider_disconnected", "not connected");
    }
  }

  public listFolders(): Promise<readonly ImapFolderStatus[]> {
    this.ensure();
    return Promise.resolve(
      this.server.listFolderNames().map((name) => {
        const f = this.server.folder(name);
        return {
          name: f.name,
          role: f.role,
          uidvalidity: f.uidvalidity,
          uidnext: f.uidnext,
          highestModseq: null,
        };
      }),
    );
  }

  public statusFolder(folder: string): Promise<ImapFolderStatus> {
    this.ensure();
    const f = this.server.folder(folder);
    return Promise.resolve({
      name: f.name,
      role: f.role,
      uidvalidity: f.uidvalidity,
      uidnext: f.uidnext,
      highestModseq: null,
    });
  }

  public fetchSince(
    folder: string,
    sinceUid: bigint,
    limit: number,
  ): Promise<{ uidvalidity: bigint; messages: readonly ImapFetchedMessage[] }> {
    this.ensure();
    const f = this.server.folder(folder);
    const msgs = [...f.messages.values()]
      .filter((m) => m.uid > sinceUid)
      .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
      .slice(0, limit)
      .map((m) => this.toFetched(m, f.uidvalidity));
    return Promise.resolve({ uidvalidity: f.uidvalidity, messages: msgs });
  }

  public fetchOne(
    folder: string,
    uid: bigint,
  ): Promise<{ uidvalidity: bigint; message: ImapFetchedMessage | null }> {
    this.ensure();
    const f = this.server.folder(folder);
    const m = f.messages.get(uid.toString());
    return Promise.resolve({
      uidvalidity: f.uidvalidity,
      message: m === undefined ? null : this.toFetched(m, f.uidvalidity),
    });
  }

  public append(
    folder: string,
    mime: Buffer,
    flags: readonly string[],
  ): Promise<ImapAppendResult> {
    this.ensure();
    const f = this.server.folder(folder);
    const uid = f.uidnext;
    f.uidnext = f.uidnext + 1n;
    f.messages.set(uid.toString(), {
      uid,
      flags: new Set(flags),
      messageId: parseMessageId(mime),
      references: parseHeader(mime, "references"),
      subject: parseHeader(mime, "subject"),
      from: parseHeader(mime, "from"),
      to: parseHeader(mime, "to"),
      size: BigInt(mime.length),
      internalDate: new Date(),
      hasAttachments: false,
      raw: Buffer.from(mime),
    });
    return Promise.resolve({ uid, uidvalidity: f.uidvalidity });
  }

  public addFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void> {
    this.ensure();
    const m = this.server.folder(folder).messages.get(uid.toString());
    if (m !== undefined) for (const fl of flags) m.flags.add(fl);
    return Promise.resolve();
  }

  public removeFlags(
    folder: string,
    uid: bigint,
    flags: readonly string[],
  ): Promise<void> {
    this.ensure();
    const m = this.server.folder(folder).messages.get(uid.toString());
    if (m !== undefined) for (const fl of flags) m.flags.delete(fl);
    return Promise.resolve();
  }

  public moveMessage(
    folder: string,
    uid: bigint,
    toFolder: string,
  ): Promise<void> {
    this.ensure();
    const src = this.server.folder(folder);
    const dst = this.server.folder(toFolder);
    const m = src.messages.get(uid.toString());
    if (m !== undefined) {
      src.messages.delete(uid.toString());
      const newUid = dst.uidnext;
      dst.uidnext = dst.uidnext + 1n;
      dst.messages.set(newUid.toString(), { ...m, uid: newUid });
    }
    return Promise.resolve();
  }

  public searchByMessageId(
    folder: string,
    messageId: string,
  ): Promise<bigint | null> {
    this.ensure();
    const f = this.server.folder(folder);
    for (const m of f.messages.values()) {
      if (m.messageId === messageId) return Promise.resolve(m.uid);
    }
    return Promise.resolve(null);
  }

  public idle(
    folder: string,
    timeoutMs: number,
  ): Promise<ImapIdleSignal | null> {
    this.ensure();
    const f = this.server.folder(folder);
    const queued = f.pendingSignals.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), Math.min(timeoutMs, 5));
      if (typeof t.unref === "function") t.unref();
    });
  }

  public logout(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  private toFetched(m: FakeMessage, uidvalidity: bigint): ImapFetchedMessage {
    return {
      uid: m.uid,
      uidvalidity,
      messageId: m.messageId,
      inReplyTo: null,
      referencesHeader: m.references,
      subject: m.subject,
      fromSummary: m.from,
      toSummary: m.to,
      internalDate: m.internalDate,
      sizeBytes: m.size,
      flags: [...m.flags],
      hasAttachments: m.hasAttachments,
    };
  }
}
