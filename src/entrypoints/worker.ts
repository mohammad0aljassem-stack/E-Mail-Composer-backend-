/**
 * Transport worker entrypoint.
 *
 * Fail-closed startup: when MAIL_TRANSPORT_V1_ENABLED is false the worker
 * connects only enough to report health = transport-disabled; it registers NO
 * work handlers, opens NO IMAP/SMTP connection, and decrypts NO credential.
 * With the master flag on, each handler additionally registers ONLY when its
 * own sub-capability flag (MAIL_SYNC_ENABLED / MAIL_MUTATIONS_ENABLED /
 * MAIL_SEND_ENABLED / ...) is true — see ./registration-plan.ts.
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
  DraftMirrorRepository,
  DraftVersionRepository,
  FolderRepository,
  HeartbeatRepository,
  MailboxRepository,
  MessageRepository,
  SendAttemptRepository,
  SendIntentRepository,
  SyncRequestRepository,
  WorkerClaimRepository,
} from "../db/repositories.js";
import { checkHealth } from "../health/health.js";
import { Heartbeat } from "../observability/heartbeat.js";
import { JsonLogger } from "../observability/logger.js";
import { QueueManager } from "../queues/queue-manager.js";
import { QUEUE_DEFINITIONS, QUEUE_NAMES } from "../queues/queue-config.js";
import type {
  ApplyMutationJob,
  DraftMirrorJob,
  SendMessageJob,
  SyncMailboxJob,
} from "../queues/queue-config.js";
import { plannedRegistrations } from "./registration-plan.js";
import { ImapSmtpProviderFactory } from "../workers/provider-factory.js";
import { DraftMirrorExecutor } from "../workers/draft-mirror-executor.js";
import { DraftVersionMirrorPayloadResolver } from "../workers/draft-mirror-payload-resolver.js";
import { SendExecutor } from "../workers/send-executor.js";
import { DraftVersionSendPayloadResolver } from "../workers/send-payload-resolver.js";
import { SyncExecutor } from "../workers/sync-executor.js";
import { runSyncJob } from "../workers/sync-lifecycle.js";
import { SyncRequestDispatcher } from "../workers/sync-request-dispatcher.js";
import { MutationExecutor } from "../workers/mutation-executor.js";
import type { Job, JobWithMetadata } from "pg-boss";

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
  // Content-free capability matrix (booleans only): the effective per-worker
  // capability flags — each already masked by the master flag in loadConfig.
  logger.info("startup_health", {
    status: health.status,
    transport_enabled: health.transportEnabled,
    db_reachable: health.dbReachable,
    sync_enabled: config.syncEnabled,
    idle_enabled: config.idleEnabled,
    draft_mirror_enabled: config.draftMirrorEnabled,
    mutations_enabled: config.mutationsEnabled,
    send_enabled: config.sendEnabled,
  });

  const queues = new QueueManager({
    connectionString: config.databaseUrl,
    schema: config.pgBossSchema,
    logger,
  });
  await queues.start();
  heartbeat.start();

  let dispatchTimer: ReturnType<typeof setInterval> | null = null;

  // Effective capability registration plan (C2): each handler registers ONLY
  // when the master flag AND its own sub-capability flag are true.
  const plan = plannedRegistrations(config);
  const anyCapability =
    plan.syncMailbox ||
    plan.applyMutation ||
    plan.sendMessage ||
    plan.draftMirror;

  if (!config.transportEnabled) {
    // Fail-closed: no work handlers, no provider, no decryption.
    logger.warn("transport_disabled_idle");
  } else if (!anyCapability) {
    // Master flag on but every sub-capability off: fail-closed idle — no
    // handler registers, no provider factory, no credential is decrypted.
    logger.warn("transport_no_capability_enabled_idle");
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
    const workerClaims = new WorkerClaimRepository(db);

    if (plan.syncMailbox) {
      const syncRequests = new SyncRequestRepository(db);
      const syncExec = new SyncExecutor({
        mailboxes: new MailboxRepository(db),
        folders: new FolderRepository(db),
        messages: new MessageRepository(db),
        audit: new AuditRepository(db),
        providerFactory,
        clock,
        logger,
        config: {
          batchSize: 200,
          globalKillSwitch: config.globalKillSwitch,
        },
      });

      // Durable transport.sync_requests consumer/dispatcher (B3/B4). The
      // worker holds only SELECT+UPDATE on the table; the DEFINER RPC inserts.
      // Runs only because master + sync capability are on (this whole branch
      // is flag-gated).
      const dispatcher = new SyncRequestDispatcher({
        syncRequests,
        mailboxes: new MailboxRepository(db),
        sendClaims: workerClaims,
        enqueueSync: (job) => queues.enqueueSyncForRequest(job),
        clock,
        logger,
        config: {
          transportEnabled: config.transportEnabled,
          globalKillSwitch: config.globalKillSwitch,
          batchSize: config.syncClaimBatchSize,
          leaseMs: config.syncClaimLeaseMs,
          maxAttempts: config.syncMaxAttempts,
        },
      });
      const syncRetryLimit =
        QUEUE_DEFINITIONS[QUEUE_NAMES.syncMailbox].retryLimit ?? 0;

      // Durable multi-batch lifecycle (bounded in-job loop + fenced lease
      // renewal + cursor-keyed continuation): see runSyncJob and the state
      // diagram in ../workers/sync-request-dispatcher.ts. The handler stays
      // thin registration — completion/failure semantics live in runSyncJob.
      await queues.instance.work(
        QUEUE_NAMES.syncMailbox,
        { includeMetadata: true },
        async (jobs: JobWithMetadata<SyncMailboxJob>[]) => {
          for (const job of jobs) {
            await runSyncJob(
              {
                executor: syncExec,
                syncRequests,
                enqueueContinuation: (continuation) =>
                  queues.enqueueSyncContinuation({
                    workspaceId: continuation.workspaceId,
                    mailboxId: continuation.mailboxId,
                    folder: continuation.folder,
                    mode: continuation.mode,
                    syncRequestId: continuation.syncRequestId,
                    cursorUid: continuation.cursorUid,
                  }),
                enqueueFollowUp: (followUp) => queues.enqueueSync(followUp),
                clock,
                logger,
                config: { maxBatchesPerJob: config.syncMaxBatchesPerJob },
              },
              job.data,
              { finalAttempt: job.retryCount >= syncRetryLimit },
            );
          }
        },
      );

      // Poll-drive the durable sync-request dispatcher. This is NOT a
      // scheduler: it only claims already-persisted requests and enqueues
      // pg-boss jobs; it never creates work from SQL and never polls
      // transport_audit.
      dispatchTimer = setInterval(() => {
        void dispatcher.dispatchOnce().catch((err: unknown) => {
          logger.error("sync_dispatch_failed", {
            error: err instanceof Error ? err.name : "unknown",
          });
        });
      }, config.syncDispatchIntervalMs);
      dispatchTimer.unref?.();
    }

    if (plan.sendMessage) {
      const sendExec = new SendExecutor({
        intents: new SendIntentRepository(db),
        attempts: new SendAttemptRepository(db),
        mailboxes: new MailboxRepository(db),
        folders: new FolderRepository(db),
        claims: workerClaims,
        audit: new AuditRepository(db),
        providerFactory,
        // Phase 3B C4: the production resolver reconstructs the confirmed
        // body from the immutable public.draft_versions snapshot (exact
        // source_revision) + the deterministic worker renderer; the executor
        // re-verifies the intent hashes before any SMTP byte. Constructed
        // ONLY inside this sendEnabled-gated branch. NOTE: the canonical
        // migrations grant transport_worker no SELECT on draft_versions yet,
        // so until a future additive UI grant migration lands this resolver
        // fails CLOSED (`draft_version_unreadable`) under the real role.
        payloadResolver: new DraftVersionSendPayloadResolver({
          draftVersions: new DraftVersionRepository(db),
        }),
        clock,
        logger,
        config: {
          workerId: config.workerId,
          claimLeaseMs: config.claimLeaseMs,
          globalKillSwitch: config.globalKillSwitch,
          // Fallback ONLY: the executor resolves the discovered sent-role
          // folder per mailbox (IONOS localizes it) and uses this default when
          // discovery has no sent-role row.
          sentFolder: "Sent",
        },
      });
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
    }

    if (plan.applyMutation) {
      const mutationExec = new MutationExecutor({
        mailboxes: new MailboxRepository(db),
        audit: new AuditRepository(db),
        providerFactory,
        logger,
        config: { globalKillSwitch: config.globalKillSwitch },
      });
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
    }

    if (plan.draftMirror) {
      // Phase 3B C6: draft mirroring, registered ONLY behind master +
      // MAIL_DRAFT_MIRROR_ENABLED (both default false). The executor keeps
      // its invariants (idempotent per draft+revision, stale-revision
      // rejection, append-before-retire, UIDVALIDITY-namespaced UIDs) and is
      // IMAP-only: it never creates a send intent and never constructs SMTP.
      // The payload resolver reads the SAME immutable draft_versions
      // snapshots + deterministic renderer as the send path and fails closed
      // (skipped_missing_payload) when the exact revision is unavailable.
      const mirrorExec = new DraftMirrorExecutor({
        mailboxes: new MailboxRepository(db),
        mirrors: new DraftMirrorRepository(db),
        audit: new AuditRepository(db),
        providerFactory,
        payloadResolver: new DraftVersionMirrorPayloadResolver({
          draftVersions: new DraftVersionRepository(db),
          mailboxes: new MailboxRepository(db),
        }),
        logger,
        config: { draftsFolder: "Drafts" },
      });
      await queues.instance.work(
        QUEUE_NAMES.draftMirror,
        async (jobs: Job<DraftMirrorJob>[]) => {
          for (const job of jobs) {
            await mirrorExec.execute({
              workspaceId: job.data.workspaceId,
              mailboxId: job.data.mailboxId,
              draftId: job.data.draftId,
              revision: BigInt(job.data.revision),
            });
          }
        },
      );
    }

    // Content-free capability matrix (booleans only).
    logger.info("workers_registered", {
      sync_mailbox: plan.syncMailbox,
      sync_dispatcher: plan.syncDispatcher,
      send_message: plan.sendMessage,
      apply_mutation: plan.applyMutation,
      draft_mirror: plan.draftMirror,
    });
  }

  // Graceful shutdown: stop taking new work, flush heartbeat, close pools.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_begin", { signal });
    if (dispatchTimer !== null) clearInterval(dispatchTimer);
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
