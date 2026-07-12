import { randomUUID } from "node:crypto";

/**
 * Injectable id + Message-ID generation. Swappable in tests for deterministic
 * ids. The Message-ID is generated ONCE, before enqueue, stored in the
 * immutable send snapshot, and reused for SMTP + Sent copy + reconciliation.
 */
export interface IdGenerator {
  uuid(): string;
  /** RFC 5322 Message-ID of the form `<uuid@domain>`. */
  messageId(domain: string): string;
  /** Opaque worker instance id (for claims/heartbeats). */
  workerId(): string;
}

const DOMAIN_RE = /^[^<>@\s]+$/;

export class RandomIdGenerator implements IdGenerator {
  public uuid(): string {
    return randomUUID();
  }

  public messageId(domain: string): string {
    const safeDomain = DOMAIN_RE.test(domain) ? domain : "mail.local";
    return `<${randomUUID()}@${safeDomain}>`;
  }

  public workerId(): string {
    return `worker-${randomUUID()}`;
  }
}
