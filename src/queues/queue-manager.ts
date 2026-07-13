import { PgBoss } from "pg-boss";
import type { Logger } from "../observability/logger.js";
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  singletonKeys,
  type ApplyMutationJob,
  type DraftMirrorJob,
  type QueueName,
  type SendMessageJob,
  type SyncMailboxJob,
} from "./queue-config.js";

/**
 * Thin wrapper over pg-boss that registers the four queue families with their
 * exact policies and exposes typed enqueue helpers. Per-workspace fair
 * concurrency uses pg-boss job groups (group.id = workspaceId). send_message is
 * enqueued WITHOUT any retry override — the queue's retryLimit is 0.
 */
export class QueueManager {
  private readonly boss: PgBoss;
  private readonly log: Logger;

  public constructor(options: {
    connectionString: string;
    schema: string;
    logger: Logger;
  }) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema,
    });
    this.log = options.logger;
    this.boss.on("error", (err: Error) => {
      this.log.error("pgboss_error", { name: err.name });
    });
  }

  public get instance(): PgBoss {
    return this.boss;
  }

  public async start(): Promise<void> {
    await this.boss.start();
    for (const [name, def] of Object.entries(QUEUE_DEFINITIONS)) {
      await this.boss.createQueue(name, def);
    }
  }

  public async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, close: true });
  }

  /**
   * Read back a queue's persisted retry policy. Used by tests to assert
   * send_message.retryLimit === 0 against the real pg-boss metadata.
   */
  public async getRetryLimit(name: QueueName): Promise<number | null> {
    const q = await this.boss.getQueue(name);
    if (q === null) return null;
    return q.retryLimit ?? null;
  }

  public async enqueueSync(job: SyncMailboxJob): Promise<string | null> {
    return this.boss.send(
      QUEUE_NAMES.syncMailbox,
      { ...job },
      {
        singletonKey: singletonKeys.syncMailbox(job.mailboxId, job.folder),
        group: { id: job.workspaceId },
      },
    );
  }

  /**
   * Enqueue a sync_mailbox job that originated from a durable
   * transport.sync_requests row. The singletonKey is DETERMINISTIC in the
   * durable request id (not mailbox+folder), so re-dispatch after a crash / lease
   * expiry can never create a duplicate job for the same request. Per-workspace
   * fair concurrency is preserved via the pg-boss job group.
   */
  public async enqueueSyncForRequest(
    job: SyncMailboxJob & { syncRequestId: string },
  ): Promise<string | null> {
    return this.boss.send(
      QUEUE_NAMES.syncMailbox,
      { ...job },
      {
        singletonKey: singletonKeys.syncRequest(job.syncRequestId),
        group: { id: job.workspaceId },
      },
    );
  }

  /**
   * Enqueue the CONTINUATION of a durable multi-batch sync request: the in-job
   * batch loop hit its bound while the executor still reports needsFollowUp.
   * The job payload carries the SAME syncRequestId (every continuation stays
   * associated with the original durable request); the singletonKey is
   * deterministic in (request id, cursor position) so it can never collide with
   * the original `sync-req:{id}` dispatch key, and a crash-recovery duplicate
   * of the same continuation dedups to null (see singletonKeys).
   */
  public async enqueueSyncContinuation(
    job: SyncMailboxJob & { syncRequestId: string; cursorUid: string },
  ): Promise<string | null> {
    const { cursorUid, ...payload } = job;
    return this.boss.send(
      QUEUE_NAMES.syncMailbox,
      { ...payload },
      {
        singletonKey: singletonKeys.syncRequestContinuation(
          job.syncRequestId,
          cursorUid,
        ),
        group: { id: job.workspaceId },
      },
    );
  }

  public async enqueueDraftMirror(job: DraftMirrorJob): Promise<string | null> {
    return this.boss.send(
      QUEUE_NAMES.draftMirror,
      { ...job },
      {
        singletonKey: singletonKeys.draftMirror(job.draftId, job.revision),
        group: { id: job.workspaceId },
      },
    );
  }

  public async enqueueSend(job: SendMessageJob): Promise<string | null> {
    // NOTE: deliberately no retryLimit override — the queue is retryLimit:0.
    // singletonKey on the immutable intent prevents a duplicate enqueue.
    return this.boss.send(
      QUEUE_NAMES.sendMessage,
      { ...job },
      {
        singletonKey: singletonKeys.sendMessage(job.sendIntentId),
        group: { id: job.workspaceId },
      },
    );
  }

  public async enqueueMutation(job: ApplyMutationJob): Promise<string | null> {
    return this.boss.send(
      QUEUE_NAMES.applyMutation,
      { ...job },
      {
        singletonKey: singletonKeys.applyMutation(
          job.mailboxId,
          job.folder,
          job.uid,
          job.mutation.kind,
        ),
        group: { id: job.workspaceId },
      },
    );
  }
}
