import { query } from '../db'

// ============================================================
// S517 — service-interruption status auto-activation.
//
// A landlord can post an outage scheduled for the future (status='scheduled').
// The resident notice is sent at post time; this cron flips the notice to
// 'active' once starts_at arrives so the tenant feed + landlord console show
// the true current state.
//
// NOTE: we intentionally do NOT auto-resolve at expected_restore_at — that's
// only an estimate, and 'resolved' fires the all-clear notification. Telling
// residents "service restored" before it actually is would be a false signal,
// so resolution stays a manual landlord action.
// ============================================================

export async function activateDueServiceInterruptions(
  now: Date = new Date(),
): Promise<{ activated: number }> {
  const rows = await query<{ id: string }>(
    `UPDATE service_interruptions
        SET status='active', updated_at=now()
      WHERE status='scheduled' AND starts_at <= $1
      RETURNING id`,
    [now.toISOString()])
  return { activated: rows.length }
}
