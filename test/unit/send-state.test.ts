import { describe, expect, it } from "vitest";
import {
  canTransition,
  isPostAcceptance,
  isTerminal,
  requiresHumanOnRestart,
  SEND_STATES,
  type SendState,
} from "../../src/domain/send-state.js";

describe("send state machine", () => {
  it("treats completed/needs_human_review/cancelled as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("needs_human_review")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("confirmed")).toBe(false);
  });

  it("has no outgoing transitions from terminal states", () => {
    for (const to of SEND_STATES) {
      // Same-state field-only updates are always allowed; skip them.
      if (to !== "completed") {
        expect(canTransition("completed", to)).toBe(false);
      }
      if (to !== "needs_human_review") {
        expect(canTransition("needs_human_review", to)).toBe(false);
      }
      if (to !== "cancelled") {
        expect(canTransition("cancelled", to)).toBe(false);
      }
    }
  });

  it("never allows re-entering SMTP after acceptance", () => {
    // No path from smtp_accepted (or later) back to smtp_in_progress.
    const post: SendState[] = [
      "smtp_accepted",
      "sent_copy_pending",
      "completed",
    ];
    for (const s of post) {
      expect(canTransition(s, "smtp_in_progress")).toBe(false);
      expect(isPostAcceptance(s)).toBe(true);
    }
  });

  it("smtp_in_progress can only advance to accepted/failed/review", () => {
    expect(canTransition("smtp_in_progress", "smtp_accepted")).toBe(true);
    expect(canTransition("smtp_in_progress", "failed_before_delivery")).toBe(
      true,
    );
    expect(canTransition("smtp_in_progress", "needs_human_review")).toBe(true);
    // Never back to queued (no auto-resend on restart).
    expect(canTransition("smtp_in_progress", "queued")).toBe(false);
    expect(requiresHumanOnRestart("smtp_in_progress")).toBe(true);
  });

  it("allows the happy path confirmed→…→completed", () => {
    expect(canTransition("confirmed", "queued")).toBe(true);
    expect(canTransition("queued", "claimed")).toBe(true);
    expect(canTransition("claimed", "smtp_in_progress")).toBe(true);
    expect(canTransition("smtp_accepted", "sent_copy_pending")).toBe(true);
    expect(canTransition("sent_copy_pending", "completed")).toBe(true);
    expect(canTransition("smtp_accepted", "completed")).toBe(true);
  });

  it("allows same-state field-only updates", () => {
    for (const s of SEND_STATES) expect(canTransition(s, s)).toBe(true);
  });
});
