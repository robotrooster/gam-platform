/**
 * S652 — the lock rule, which no human applies.
 *
 * Nic threw out the version where somebody at GAM decided: "I don't want it
 * flipped by a person... choice creates the opportunity for discrimination. We
 * need to have a standing company rule and a sweep."
 *
 * And threw out a dollar trigger with it: "we can't have a flat dollar amount
 * because that gives the smaller landlords years to potentially not pay. And
 * smaller or bigger landlords would be locked out immediately on a technicality.
 * So it needs to be per billing cycle."
 *
 * The $10 duplex and the 41-space park must reach the lock at the same POINT —
 * two uncollected bills plus 48 hours — never at the same dollar figure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

const notes: any[] = []
vi.mock('./notifications', () => ({
  createNotification: vi.fn(async (n: any) => { notes.push(n) }),
}))

import { runPortalLockSweep, lockCandidates, LOCK_GRACE_HOURS } from './portalLockSweep'

beforeEach(async () => { await cleanupAllSchema(); notes.length = 0 })

/** A landlord billed `amounts[i]` in month i, none of it collected. */
async function billed(amounts: number[], opts: { agoHoursOfLast?: number } = {}) {
  const c = await db.connect()
  let landlordId = ''
  try {
    await c.query('BEGIN')
    ;({ landlordId } = await seedLandlord(c))
    await c.query('COMMIT')
  } finally { c.release() }

  for (let i = 0; i < amounts.length; i++) {
    const monthsBack = amounts.length - 1 - i
    const at = monthsBack === 0 && opts.agoHoursOfLast != null
      ? `NOW() - INTERVAL '${opts.agoHoursOfLast} hours'`
      : `NOW() - INTERVAL '${monthsBack} months'`
    await query(
      `INSERT INTO landlord_gam_charges
         (landlord_id, kind, amount, collected_amount, source_type, created_at)
       VALUES ($1,'subscription',$2,0,'platform_fee_accrual', ${at})`,
      [landlordId, amounts[i]])
  }
  return landlordId
}

const lockedAt = async (id: string) =>
  (await query<any>(`SELECT platform_locked_at FROM landlords WHERE id=$1`, [id]))[0].platform_locked_at

describe('the rule scales itself', () => {
  it('locks the $10 duplex and the $4,000 park at the same POINT', async () => {
    // Two cycles and 48 hours, whatever the money says. A flat $500 trigger
    // would give the duplex four years and the park a fortnight.
    const duplex = await billed([10, 10], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })
    const park   = await billed([4000, 4000], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })

    const r = await runPortalLockSweep()
    expect(r.locked).toBe(2)
    expect(await lockedAt(duplex)).toBeTruthy()
    expect(await lockedAt(park)).toBeTruthy()
  })

  it('leaves one uncollected bill alone, however large', async () => {
    const park = await billed([4000])
    const r = await runPortalLockSweep()
    expect(r.locked).toBe(0)
    expect(await lockedAt(park)).toBeNull()
  })

  it('waits the 48 hours after the second bill', async () => {
    const id = await billed([10, 10], { agoHoursOfLast: 2 })
    const r = await runPortalLockSweep()
    expect(r.locked).toBe(0)
    expect(await lockedAt(id)).toBeNull()
    // and warns instead
    expect(r.warned).toBe(1)
    expect(notes[0].type).toBe('gam_portal_lock_warning')
  })

  it('warns once per bill, not once a night', async () => {
    // A daily countdown is how somebody learns to filter GAM's mail the week
    // before it matters.
    const id = await billed([10, 10], { agoHoursOfLast: 2 })
    await runPortalLockSweep()
    const [n] = await query<any>(
      `INSERT INTO notifications (user_id, landlord_id, type, title, body)
       SELECT l.user_id, l.id, 'gam_portal_lock_warning', 'x', 'y' FROM landlords l WHERE l.id=$1
       RETURNING id`, [id])
    expect(n).toBeTruthy()
    notes.length = 0
    const again = await runPortalLockSweep()
    expect(again.warned).toBe(0)
  })
})

describe('it only reaches somebody GAM cannot collect from', () => {
  it('leaves a landlord alone while rent is moving through GAM', async () => {
    // There is money to net the fee out of; no lock is needed or fair.
    const id = await billed([10, 10], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })
    await query(
      `INSERT INTO payments (landlord_id, amount, status, type, due_date, entry_description)
       VALUES ($1, 1200, 'settled', 'rent', CURRENT_DATE, 'RENT')`, [id])
    const r = await runPortalLockSweep()
    expect(r.locked).toBe(0)
    expect(await lockedAt(id)).toBeNull()
  })

  it('leaves a landlord alone who has a bank GAM can debit', async () => {
    const id = await billed([10, 10], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })
    await query(
      `UPDATE landlords SET gam_debit_payment_method_id = 'pm_x' WHERE id = $1`, [id])
    const r = await runPortalLockSweep()
    expect(r.locked).toBe(0)
  })

  it('does not count a bank-transfer cost as a billing cycle', async () => {
    // "The next bill coming around" means the recurring bill, not a fee that
    // rode along on somebody's balance.
    const id = await billed([10], { })
    await query(
      `INSERT INTO landlord_gam_charges (landlord_id, kind, amount, collected_amount, source_type)
       VALUES ($1,'bank_debit_cost',6,0,'gam_bank_debit_cost')`, [id])
    const { due } = await lockCandidates()
    expect(due).toHaveLength(0)
  })
})

describe('getting access back', () => {
  it('restores it the moment the balance is settled, with nobody asked', async () => {
    // The lock exists to collect money. The instant the money is there the
    // reason is gone, and nobody should have to ring and wait to be noticed.
    const id = await billed([10, 10], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })
    await runPortalLockSweep()
    expect(await lockedAt(id)).toBeTruthy()

    await query(
      `UPDATE landlord_gam_charges SET collected_amount = amount, collected_at = NOW()
        WHERE landlord_id = $1`, [id])
    const r = await runPortalLockSweep()
    expect(r.released).toBe(1)
    expect(await lockedAt(id)).toBeNull()
  })

  it('does not re-lock somebody in the same run that released them', async () => {
    const id = await billed([10, 10], { agoHoursOfLast: LOCK_GRACE_HOURS + 1 })
    await runPortalLockSweep()
    await query(
      `UPDATE landlord_gam_charges SET collected_amount = amount WHERE landlord_id = $1`, [id])
    const r = await runPortalLockSweep()
    expect(r.released).toBe(1)
    expect(r.locked).toBe(0)
    expect(await lockedAt(id)).toBeNull()
  })
})
