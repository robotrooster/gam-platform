import { describe, it, expect } from 'vitest'
import { allocateOldestFirst } from './paymentAllocation'


/**
 * S609 (Nic): PROPANE IS PAID LAST, whatever its date.
 *
 *   "We also need to let it sit outside of the first in, first out charges on
 *    the ledger, because if it doesn't sit outside of that, it's gonna apply the
 *    payment to the oldest charge, which would supersede the rent, which would
 *    still end up letting the tenant acquire late fees if the tenant can't pay
 *    the whole thing."
 *
 * A tank filled on the 20th is OLDER than rent due the 1st of next month, so
 * pure oldest-first hands the money to the propane and leaves the rent short.
 * Late fees are computed on RENT alone, so that shortfall is exactly what starts
 * a late fee and an eviction clock — over a propane bill.
 */
describe('S609 propane is allocated last', () => {
  const rent = (id: string, amount: number, due: string) =>
    ({ id, amount, due_date: due, type: 'rent', entry_description: 'RENT' })
  const propane = (id: string, amount: number, due: string) =>
    ({ id, amount, due_date: due, type: 'utility', entry_description: 'PROPANE' })

  it('rent is satisfied before an OLDER propane charge', () => {
    const res = allocateOldestFirst(
      [propane('p', 400, '2026-01-20'), rent('r', 500, '2026-02-01')],
      500,
    )
    // All $500 goes to rent even though the propane is a month older.
    expect(res.lines).toEqual([{ payment_id: 'r', amount_applied: 500 }])
  })

  it('propane takes whatever is left once everything else is covered', () => {
    const res = allocateOldestFirst(
      [propane('p', 400, '2026-01-20'), rent('r', 500, '2026-02-01')],
      700,
    )
    expect(res.lines).toEqual([
      { payment_id: 'r', amount_applied: 500 },
      { payment_id: 'p', amount_applied: 200 },
    ])
  })

  it('non-propane charges keep strict oldest-first among themselves', () => {
    const res = allocateOldestFirst(
      [rent('feb', 500, '2026-02-01'), rent('jan', 500, '2026-01-01')],
      500,
    )
    expect(res.lines).toEqual([{ payment_id: 'jan', amount_applied: 500 }])
  })

  it('several propane charges stay oldest-first among themselves', () => {
    const res = allocateOldestFirst(
      [propane('newer', 100, '2026-03-01'), propane('older', 100, '2026-01-01')],
      100,
    )
    expect(res.lines).toEqual([{ payment_id: 'older', amount_applied: 100 }])
  })

  it('rows with no type behave exactly as before', () => {
    const res = allocateOldestFirst(
      [{ id: 'b', amount: 50, due_date: '2026-02-01' },
       { id: 'a', amount: 50, due_date: '2026-01-01' }],
      50,
    )
    expect(res.lines).toEqual([{ payment_id: 'a', amount_applied: 50 }])
  })
})
