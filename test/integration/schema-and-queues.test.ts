import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { JsonLogger } from "../../src/observability/logger.js";
import { QueueManager } from "../../src/queues/queue-manager.js";
import { QUEUE_NAMES } from "../../src/queues/queue-config.js";
import { HAS_DB, SUPERUSER_URL, superuserPool } from "./helpers.js";

const d = HAS_DB ? describe : describe.skip;

d("canonical schema is loaded", () => {
  let db: pg.Pool;
  beforeAll(() => {
    db = superuserPool();
  });
  afterAll(async () => {
    await db.end();
  });

  it("has the public transport tables", async () => {
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('mailboxes','mailbox_folders','mail_messages',
                             'draft_mirrors','send_intents','send_attempts',
                             'transport_audit')`,
    );
    expect(r.rows).toHaveLength(7);
  });

  it("has the PRIVATE transport schema tables", async () => {
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'transport'`,
    );
    const names = r.rows.map((x) => x.table_name).sort();
    expect(names).toEqual(
      ["mailbox_credentials", "worker_claims", "worker_heartbeats"].sort(),
    );
  });

  it("created the least-privileged transport_worker role", async () => {
    const r = await db.query<{ rolname: string; rolbypassrls: boolean }>(
      `select rolname, rolbypassrls from pg_roles where rolname = 'transport_worker'`,
    );
    expect(r.rows[0]?.rolname).toBe("transport_worker");
  });

  it("mailbox_credentials has the AEAD columns (no plaintext column)", async () => {
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'transport' and table_name = 'mailbox_credentials'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    for (const c of [
      "ciphertext",
      "nonce",
      "auth_tag",
      "algorithm",
      "key_version",
      "aad",
    ]) {
      expect(cols).toContain(c);
    }
    expect(cols).not.toContain("plaintext");
    expect(cols).not.toContain("password");
  });
});

d("pg-boss queue policies (real metadata)", () => {
  let queues: QueueManager;
  beforeAll(async () => {
    queues = new QueueManager({
      connectionString: SUPERUSER_URL,
      schema: "pgboss_test",
      logger: new JsonLogger({ level: "error", sink: { write: () => {} } }),
    });
    await queues.start();
  });
  afterAll(async () => {
    await queues.stop();
  });

  // Test 35 (integration level): send_message has ZERO retries in real pg-boss.
  it("send_message.retryLimit is exactly 0 in pg-boss", async () => {
    expect(await queues.getRetryLimit(QUEUE_NAMES.sendMessage)).toBe(0);
  });

  it("sync_mailbox has a positive retry limit", async () => {
    expect(await queues.getRetryLimit(QUEUE_NAMES.syncMailbox)).toBe(5);
  });

  it("dedups a send job by singletonKey (immutable intent)", async () => {
    // A fresh intent id each run (pg-boss state persists across test runs).
    const sendIntentId = `intent-${randomUUID()}`;
    const id1 = await queues.enqueueSend({
      workspaceId: "ws",
      sendIntentId,
      sendAttemptId: "attempt-xyz",
    });
    const id2 = await queues.enqueueSend({
      workspaceId: "ws",
      sendIntentId,
      sendAttemptId: "attempt-xyz",
    });
    expect(id1).not.toBeNull();
    // The duplicate is de-duplicated (no second job id).
    expect(id2).toBeNull();
  });
});
