import pg from "pg";

/**
 * Integration tests require a LOCAL Postgres carrying the canonical schema.
 * Bring it up with `bash scripts/test-db.sh --print` and export:
 *   TEST_DATABASE_URL         (postgres superuser — used for seeding + pg-boss)
 *   TEST_WORKER_DATABASE_URL  (least-privileged transport_worker login)
 */
export const SUPERUSER_URL = process.env.TEST_DATABASE_URL ?? "";
export const WORKER_URL = process.env.TEST_WORKER_DATABASE_URL ?? "";
export const HAS_DB = SUPERUSER_URL !== "";

export function superuserPool(): pg.Pool {
  return new pg.Pool({ connectionString: SUPERUSER_URL, max: 4 });
}
export function workerPool(): pg.Pool {
  return new pg.Pool({ connectionString: WORKER_URL, max: 4 });
}

let seedCounter = 0;

export interface SeededContext {
  workspaceId: string;
  userId: string;
  mailboxId: string;
  draftId: string;
}

/**
 * Seed the FK chain (auth.users → users → workspace → member → mailbox → draft)
 * as the superuser, returning ids. Enables the mailbox by default so sends pass
 * the mailbox-enabled precheck.
 */
export async function seedContext(
  db: pg.Pool,
  opts?: { enabled?: boolean; killSwitch?: boolean },
): Promise<SeededContext> {
  seedCounter += 1;
  const r = await db.query<{
    workspace_id: string;
    user_id: string;
    mailbox_id: string;
    draft_id: string;
  }>(
    `
    with au as (
      insert into auth.users (id, email)
      values (gen_random_uuid(), 'user${seedCounter}@test.local')
      returning id
    ), u as (
      insert into public.users (id, email) select id, 'user${seedCounter}@test.local' from au
      returning id
    ), w as (
      insert into public.workspaces (name) values ('ws-${seedCounter}') returning id
    ), m as (
      insert into public.workspace_members (workspace_id, user_id, role)
      select w.id, u.id, 'owner' from w, u returning workspace_id, user_id
    ), mb as (
      insert into public.mailboxes
        (workspace_id, email_address, imap_host, imap_port, imap_security,
         smtp_host, smtp_port, smtp_security, enabled, kill_switch, created_by)
      select w.id, 'mb${seedCounter}@test.local', 'imap.test.local', 993, 'ssl',
             'smtp.test.local', 465, 'ssl', $1, $2, u.id
      from w, u returning id, workspace_id
    ), d as (
      insert into public.drafts (workspace_id, subject, body_json, created_by, updated_by)
      select w.id, 'subject', '{"type":"doc"}'::jsonb, u.id, u.id from w, u
      returning id
    )
    select w.id as workspace_id, u.id as user_id, mb.id as mailbox_id, d.id as draft_id
    from w, u, mb, d
    `,
    [opts?.enabled ?? true, opts?.killSwitch ?? false],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("seed failed");
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    mailboxId: row.mailbox_id,
    draftId: row.draft_id,
  };
}
