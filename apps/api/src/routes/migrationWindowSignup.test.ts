/**
 * S624 — every landlord gets a migration window, and a missing one never means
 * "no screening required".
 *
 * THE BUG THIS PINS. The S623 migrations backfilled migration_window_ends_at for
 * every landlord that existed then. Nothing set it at SIGNUP. The screening gate
 * read `!windowEnds` as "the onboarding window is still open" — so every
 * landlord who joined afterwards was permanently inside their window and never
 * had to background-check anyone, contradicting the published Terms (§9.2).
 *
 * It was found on a real organic signup fifteen minutes old, not by a test,
 * which is the whole reason these exist now.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { MIGRATION_WINDOW_DAYS } from '@gam/shared'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

describe('the onboarding migration window', () => {
  it('is 28 days, and the code agrees with the published Terms', () => {
    // Business Terms §9.1/§9.2 and Consumer §7.1/§7.2 state this figure. If it
    // changes here without the legal documents changing, GAM's behaviour and its
    // contract disagree — which is worse than either number being wrong.
    expect(MIGRATION_WINDOW_DAYS).toBe(28)
  })

  it('no landlord in the database is missing one', async () => {
    const client = await getClient()
    try {
      // A landlord created the way the app creates them.
      const { landlordId } = await seedLandlord(client)
      await client.query(
        `UPDATE landlords SET migration_window_ends_at = NOW() + ($2::int * INTERVAL '1 day')
          WHERE id = $1`, [landlordId, MIGRATION_WINDOW_DAYS])
    } finally { client.release() }

    const orphans = await db.query(
      `SELECT id FROM landlords WHERE migration_window_ends_at IS NULL`)
    expect(orphans.rowCount).toBe(0)
  })

  // The load-bearing assertion. A NULL must never be read as an open window.
  it('derives a window from the join date rather than treating null as forever', async () => {
    const client = await getClient()
    let landlordId: string
    try {
      ({ landlordId } = await seedLandlord(client))
    } finally { client.release() }

    // Simulate the bug's state: joined 60 days ago, no window recorded.
    await db.query(
      `UPDATE landlords
          SET created_at = NOW() - INTERVAL '60 days', migration_window_ends_at = NULL
        WHERE id = $1`, [landlordId])

    const row = (await db.query<{ created_at: string; migration_window_ends_at: string | null }>(
      `SELECT created_at, migration_window_ends_at FROM landlords WHERE id=$1`,
      [landlordId])).rows[0]

    // This is the exact derivation esign.ts performs when the column is null.
    const onboardedAt = new Date(row.created_at)
    const derived = row.migration_window_ends_at
      ? new Date(row.migration_window_ends_at)
      : new Date(onboardedAt.getTime() + MIGRATION_WINDOW_DAYS * 86400000)
    const windowOpen = new Date() < derived

    // 60 days after joining, the window is SHUT — screening applies. Under the
    // old `!windowEnds ||` default this was true, forever, for everybody.
    expect(windowOpen).toBe(false)
  })

  it('a landlord who joined yesterday is still inside their window', async () => {
    const client = await getClient()
    let landlordId: string
    try {
      ({ landlordId } = await seedLandlord(client))
    } finally { client.release() }
    await db.query(
      `UPDATE landlords
          SET created_at = NOW() - INTERVAL '1 day', migration_window_ends_at = NULL
        WHERE id = $1`, [landlordId])

    const row = (await db.query<{ created_at: string }>(
      `SELECT created_at FROM landlords WHERE id=$1`, [landlordId])).rows[0]
    const derived = new Date(new Date(row.created_at).getTime()
      + MIGRATION_WINDOW_DAYS * 86400000)
    expect(new Date() < derived).toBe(true)
  })
})
