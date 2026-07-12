/**
 * Transport worker entrypoint.
 *
 * Fail-closed startup: when MAIL_TRANSPORT_V1_ENABLED is false the worker
 * connects only enough to report health = transport-disabled; it registers NO
 * work handlers, opens NO IMAP/SMTP connection, and decrypts NO credential.
 *
 * NOT a scheduler/runtime for CI — CI runs tests. This is the long-lived worker.
 */
import { loadConfig } from "../config/env.js";
import { AesGcmCredentialCipher } from "../crypto/aes-gcm-cipher.js";
import { SystemClock } from "../domain/clock.js";
import { PgDatabase } from "../db/pool.js";
import {
  AuditRepository,
  CredentialRepository,
  FolderRepository,
  HeartbeatRepository,
  MailboxRepository,
  MessageRepository,
  SendAttemptRepository,
  SendIntentRepository,
  WorkerClaimRepository,
} from "../db/repositories.js";
import { checkHealth } from "../health/health.js";
import { Heartbeat } from "../observability/heartbeat.js";
import { JsonLogger } from "../observability/logger.js";
import { QueueManager } from "../queues/queue-manager.js";
import { QUEUE_NAMES } from "../queues/queue-config.js";
import type {
  ApplyMutationJob,
  SendMessageJob,
  SyncMailboxJob,
} from "../queues/queue-config.js";
import { ImapSmtpProviderFactory } from "../workers/provider-factory.js";
import { SendExecutor } from "../workers/send-executor.js";
import { SyncExecutor } from "../workers/sync-executor.js";
import { MutationExecutor } from "../workers/mutation-executor.js";
import type { Job } from "pg-boss";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger({
    level: config.logLevel,
    bindings: { worker_id: config.workerId },
  });

  const db = new PgDatabase({ connectionString: config.databaseUrl });
  const clock = new SystemClock();
  const heartbeats = new HeartbeatRepository(db);
  const heartbeat = new Heartbeat({
    heartbeats,
    clock,
    logger,
    workerId: config.workerId,
    intervalMs: config.heartbeatIntervalMs,
  });

  const health = await checkHealth({
    db,
    clock,
    transportEnabled: config.transportEnabled,
    globalKillSwitch: config.globalKillSwitch,
  });
  logger.info("startup_health", {
    status: health.status,
    transport_enabled: health.transportEnabled,
    db_reachable: health.dbReachable,
  });

  const queues = new QueueManager({
    connectionString: config.databaseUrl,
    schema: config.pgBossSchema,
    logger,
  });
  await queues.start();
  heartbeat.start();

  if (!config.transportEnabled) {
    // Fail-closed: no work handlers, no provider, no decryption.
    logger.warn("transport_disabled_idle");
  } else {
    const cipher = new AesGcmCredentialCipher({
      keyring: config.credentialKeyring,
      activeKeyVersion: config.activeKeyVersion,
    });
    const providerFactory = new ImapSmtpProviderFactory({
      credentials: new CredentialRepository(db),
      cipher,
      config: {
        imapCommandTimeoutMs: config.imapCommandTimeoutMs,
        smtpTimeoutMs: config.smtpTimeoutMs,
      },
    });

    const syncExec = new SyncExecutor({
      mailboxes: new MailboxRepository(db),
      folders: new FolderRepository(db),
      messages: new MessageRepository(db),
      audit: new AuditRepository(db),
      providerFactory,
      clock,
      logger,
      config: { batchSize: 200 },
    });
    const sendExec = new SendExecutor({
      intents: new SendIntentRepository(db),
      attempts: new SendAttemptRepository(db),
      mailboxes: new MailboxRepository(db),
      claims: new WorkerClaimRepository(db),
      audit: new AuditRepository(db),
      providerFactory,
      payloadResolver: {
        // Phase 3A ships no draft->payload assembler in the worker; that is a
        // Phase 3B controlled-mailbox step. Fail closed if invoked.
        resolve: () => {
          throw new Error("send payload resolver not configured");
        },
      },
      clock,
      logger,
      config: {
        workerId: config.workerId,
        claimLeaseMs: config.claimLeaseMs,
        globalKillSwitch: config.globalKillSwitch,
        sentFolder: "Sent",
      },
    });
    const mutationExec = new MutationExecutor({
      mailboxes: new MailboxRepository(db),
      audit: new AuditRepository(db),
      providerFactory,
      logger,
    });
    await queues.instance.work(
      QUEUE_NAMES.syncMailbox,
      async (jobs: Job<SyncMailboxJob>[]) => {
        for (const job of jobs) await syncExec.execute(job.data);
      },
    );
    await queues.instance.work(
      QUEUE_NAMES.sendMessage,
      async (jobs: Job<SendMessageJob>[]) => {
        for (const job of jobs) {
          await sendExec.execute({
            sendIntentId: job.data.sendIntentId,
            sendAttemptId: job.data.sendAttemptId,
            workspaceId: job.data.workspaceId,
          });
        }
      },
    );
    await queues.instance.work(
      QUEUE_NAMES.applyMutation,
      async (jobs: Job<ApplyMutationJob>[]) => {
        for (const job of jobs) {
          const d = job.data;
          const mutation =
            d.mutation.kind === "move"
              ? {
                  kind: "move" as const,
                  folder: d.folder,
                  uid: BigInt(d.uid),
                  toFolder: d.mutation.toFolder,
                }
              : {
                  kind: d.mutation.kind,
                  folder: d.folder,
                  uid: BigInt(d.uid),
                  flags: d.mutation.flags,
                };
          await mutationExec.execute({
            workspaceId: d.workspaceId,
            mailboxId: d.mailboxId,
            mutation,
          });
        }
      },
    );
    // draft_mirror worker intentionally not registered by default in 3A
    // (queue exists; the DraftMirrorExecutor + its tests are complete).

    logger.info("workers_registered");
  }

  // Graceful shutdown: stop taking new work, flush heartbeat, close pools.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_begin", { signal });
    void (async (): Promise<void> => {
      await queues.stop().catch(() => undefined);
      await heartbeat.stop().catch(() => undefined);
      await db.end().catch(() => undefined);
      logger.info("shutdown_complete");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Fail closed on any startup error.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "worker_startup_failed",
      error: err instanceof Error ? err.name : "unknown",
    }),
  );
  process.exit(1);
});
