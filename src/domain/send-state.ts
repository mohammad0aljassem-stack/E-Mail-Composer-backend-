/**
 * Outbound send state machine (mirrors the authoritative SQL transition table
 * `public.phase3_send_attempt_transition_ok` from the transport_foundation
 * migration). The DB trigger is the ultimate guard; this TS copy lets the
 * worker reason about legality *before* issuing a compare-and-set UPDATE and
 * keeps the rules unit-testable without a database.
 *
 * SAFETY INVARIANTS encoded here:
 *  - `completed`, `needs_human_review`, `cancelled` are terminal for the
 *    automated path (no outgoing transitions).
 *  - There is NO edge that re-enters SMTP after `smtp_accepted`.
 *  - `smtp_in_progress` can only move to accepted / failed_before_delivery /
 *    needs_human_review — never back to `queued` (a restart mid-DATA must NOT
 *    auto-send again; it goes to needs_human_review).
 */

export const SEND_STATES = [
  "pending_confirmation",
  "confirmed",
  "queued",
  "claimed",
  "smtp_in_progress",
  "smtp_accepted",
  "sent_copy_pending",
  "completed",
  "failed_before_delivery",
  "needs_human_review",
  "cancelled",
] as const;

export type SendState = (typeof SEND_STATES)[number];

/** Terminal states for the automated pipeline (no worker-driven exit). */
export const TERMINAL_STATES: ReadonlySet<SendState> = new Set<SendState>([
  "completed",
  "needs_human_review",
  "cancelled",
]);

const TRANSITIONS: Readonly<Record<SendState, ReadonlySet<SendState>>> = {
  pending_confirmation: new Set<SendState>(["confirmed", "cancelled"]),
  confirmed: new Set<SendState>(["queued", "cancelled"]),
  queued: new Set<SendState>(["claimed", "cancelled"]),
  claimed: new Set<SendState>([
    "smtp_in_progress",
    "failed_before_delivery",
    "needs_human_review",
    "cancelled",
  ]),
  smtp_in_progress: new Set<SendState>([
    "smtp_accepted",
    "failed_before_delivery",
    "needs_human_review",
  ]),
  smtp_accepted: new Set<SendState>([
    "sent_copy_pending",
    "completed",
    "needs_human_review",
  ]),
  sent_copy_pending: new Set<SendState>(["completed", "needs_human_review"]),
  failed_before_delivery: new Set<SendState>([
    "queued",
    "needs_human_review",
    "cancelled",
  ]),
  completed: new Set<SendState>(),
  needs_human_review: new Set<SendState>(),
  cancelled: new Set<SendState>(),
};

export function isTerminal(state: SendState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Whether `to` is a legal successor of `from`. Same-state (field-only update)
 * is allowed, matching the SQL rule `p_from = p_to`.
 */
export function canTransition(from: SendState, to: SendState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].has(to);
}

/**
 * True once SMTP DATA has been accepted: from here the pipeline may only do
 * Sent-copy reconciliation, never another SMTP delivery.
 */
export function isPostAcceptance(state: SendState): boolean {
  return (
    state === "smtp_accepted" ||
    state === "sent_copy_pending" ||
    state === "completed"
  );
}

/**
 * A state from which a restarted worker must NOT auto-continue delivery.
 * `smtp_in_progress` means DATA may be in flight; recovery is human review, not
 * a resend. `claimed` recovers by lease expiry, not by this rule.
 */
export function requiresHumanOnRestart(state: SendState): boolean {
  return state === "smtp_in_progress";
}
