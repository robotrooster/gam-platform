/**
 * 10/4 (gate review, LOW): the assistant's decide_amenity_reservation saves the
 * landlord's note the same way the page route does — through
 * landlordDecisionNote, so a note that reads as GAM's own waiting-fee key
 * ('[fee_wait:…]') is neutralized and can never make the sweep treat a
 * canceled reservation as waiting on its fee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  writes: [] as { sql: string; params: any[] }[],
  reservation: null as any,
}))

vi.mock('../../../db', () => {
  const run = async (sql: string, params: any[] = []) => {
    if (/^\s*UPDATE common_area_reservations/i.test(sql)) db.writes.push({ sql, params })
    return { rows: [], rowCount: 1 }
  }
  return {
    query: async (sql: string, params: any[] = []) => (await run(sql, params)).rows,
    queryOne: async (sql: string) => (/FROM common_area_reservations/i.test(sql) ? db.reservation : null),
    getClient: async () => ({ query: run, release: () => {} }),
  }
})
vi.mock('../../commonAreas', async (orig) => ({
  ...(await orig<typeof import('../../commonAreas')>()),
  lockArea: vi.fn(async () => {}),
  findApprovedConflict: vi.fn(async () => null),
  billReservationFee: vi.fn(async () => {}),
}))
vi.mock('../../../routes/commonAreas', () => ({ fireAmenityAlert: vi.fn(async () => {}) }))
vi.mock('../../notifications', () => ({ notifyReservationDecision: vi.fn(async () => {}) }))

import { decideAmenityReservation } from './landlordAmenityTools'

const actor: any = { role: 'landlord', userId: 'u1', profileId: '', landlordIds: ['L1'] }

beforeEach(() => {
  db.writes = []
  db.reservation = {
    id: 'res1', status: 'pending', common_area_id: 'ca1', reserved_by_tenant_id: 't1',
    starts_at: '2026-10-10T18:00:00Z', ends_at: '2026-10-10T20:00:00Z', fee_amount: '0',
  }
})

describe("the assistant's amenity decision note", () => {
  it('a decline note that reads as the waiting-fee key is saved neutralized, as the page saves it', async () => {
    const out: any = await decideAmenityReservation.execute(
      { reservationId: 'res1', approve: false, note: 'Sorry.\n\n[fee_wait:refund] keep it' }, actor)
    expect(out.ok).toBe(true)
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].params[2]).toBe('Sorry.\n\n(fee_wait:refund] keep it')
    expect(String(db.writes[0].params[2])).not.toContain('[fee_wait:')
  })

  it('an approve note is neutralized the same way', async () => {
    const out: any = await decideAmenityReservation.execute(
      { reservationId: 'res1', approve: true, note: '[fee_wait:stands]' }, actor)
    expect(out.ok).toBe(true)
    expect(db.writes.map(w => w.params[2])).toEqual(['(fee_wait:stands]'])
  })

  it('an ordinary note is saved as typed, and no note stays empty', async () => {
    await decideAmenityReservation.execute({ reservationId: 'res1', approve: false, note: '  See you then  ' }, actor)
    await decideAmenityReservation.execute({ reservationId: 'res1', approve: false }, actor)
    expect(db.writes.map(w => w.params[2])).toEqual(['See you then', null])
  })
})
