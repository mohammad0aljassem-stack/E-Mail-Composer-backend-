import { describe, expect, it } from "vitest";
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  singletonKeys,
} from "../../src/queues/queue-config.js";

describe("queue families + policies", () => {
  // Test 35 (unit portion): send_message has ZERO automatic retries.
  it("send_message retryLimit is exactly 0", () => {
    expect(QUEUE_DEFINITIONS[QUEUE_NAMES.sendMessage].retryLimit).toBe(0);
    expect(QUEUE_DEFINITIONS[QUEUE_NAMES.sendMessage].retryBackoff).toBe(false);
  });

  it("sync_mailbox retries with bounded exponential backoff (max ~5)", () => {
    const q = QUEUE_DEFINITIONS[QUEUE_NAMES.syncMailbox];
    expect(q.retryLimit).toBe(5);
    expect(q.retryBackoff).toBe(true);
    expect(q.retryDelayMax).toBeGreaterThan(0);
  });

  it("draft_mirror retries max ~3", () => {
    expect(QUEUE_DEFINITIONS[QUEUE_NAMES.draftMirror].retryLimit).toBe(3);
  });

  it("apply_mutation allows bounded retries", () => {
    expect(
      QUEUE_DEFINITIONS[QUEUE_NAMES.applyMutation].retryLimit,
    ).toBeGreaterThan(0);
  });

  it("builds deterministic idempotency/dedup keys", () => {
    expect(singletonKeys.sendMessage("intent-1")).toBe("send:intent-1");
    expect(singletonKeys.draftMirror("d1", "3")).toBe("draft:d1:3");
    expect(singletonKeys.syncMailbox("mb", "INBOX")).toBe("sync:mb:INBOX");
  });

  it("dispatch + continuation keys are generation-scoped and cursor-distinct", () => {
    const dispatch = singletonKeys.syncRequest("r1", 1);
    const cont = singletonKeys.syncRequestContinuation("r1", 1, "200");
    expect(dispatch).toBe("sync-req:r1:gen:1");
    expect(cont).toBe("sync-req:r1:gen:1:uid:200");
    // Never collides with the generation's dispatch key of the running job...
    expect(cont).not.toBe(dispatch);
    // ...deterministic per (request, generation, cursor) so a crash-recovery
    // duplicate dedups, while a NEW cursor position yields a NEW key.
    expect(singletonKeys.syncRequestContinuation("r1", 1, "200")).toBe(cont);
    expect(singletonKeys.syncRequestContinuation("r1", 1, "400")).not.toBe(
      cont,
    );
    // A durable RE-CLAIM bumps the generation, minting a NEW keyspace that is
    // intentionally not deduped against the dead generation's queued jobs.
    expect(singletonKeys.syncRequest("r1", 2)).toBe("sync-req:r1:gen:2");
    expect(singletonKeys.syncRequest("r1", 2)).not.toBe(dispatch);
    expect(singletonKeys.syncRequestContinuation("r1", 2, "200")).not.toBe(
      cont,
    );
  });
});
