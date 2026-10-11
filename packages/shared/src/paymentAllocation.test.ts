import { describe, it, expect } from 'vitest'
import { allocateOldestFirst, compareForAllocation, sortForAllocation } from './paymentAllocation'


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

// ── S622: carried-forward arrears sit outside FIFO ───────────────────
//
// Nic: "if they are behind a thousand dollars and we're carrying forward, they
// need to be paying on the new lease and making payments towards the outstanding
// balance. Outstanding balance that is carried forward should be exempt from
// first in, first out."
//
// Arrears are by definition the OLDEST charge, so pure oldest-first hands every
// rent dollar to the old debt and leaves the new lease short — a late fee and an
// eviction clock on a lease the tenant has been paying in full.
describe('carried-forward balance is paid last', () => {
  const arrears = {
    id: 'arrears', amount: 1000, due_date: '2026-01-01', type: 'carried_balance',
  }
  const rent = { id: 'rent', amount: 800, due_date: '2026-09-01', type: 'rent' }

  it('a rent-sized payment pays the RENT, not the older arrears', () => {
    const r = allocateOldestFirst([arrears, rent], 800)
    expect(r.lines).toEqual([{ payment_id: 'rent', amount_applied: 800 }])
    expect(r.unapplied).toBe(0)
  })

  it('anything above the rent flows on to the arrears', () => {
    const r = allocateOldestFirst([arrears, rent], 950)
    expect(r.lines).toEqual([
      { payment_id: 'rent',    amount_applied: 800 },
      { payment_id: 'arrears', amount_applied: 150 },
    ])
  })

  it('the arrears still take a PARTIAL payment — that is the point of the carve-out', () => {
    const r = allocateOldestFirst([{ ...arrears, amount_paid: 150 }], 200)
    expect(r.lines).toEqual([{ payment_id: 'arrears', amount_applied: 200 }])
  })

  it('propane is still paid before arrears — a fill would otherwise age into the same trap', () => {
    const propane = {
      id: 'propane', amount: 120, due_date: '2026-08-20',
      type: 'utility', entry_description: 'PROPANE',
    }
    const r = allocateOldestFirst([arrears, propane, rent], 920)
    expect(r.lines.map(l => l.payment_id)).toEqual(['rent', 'propane'])
  })

  it('rent is still paid oldest-first among itself', () => {
    const sept = { id: 'sept', amount: 800, due_date: '2026-09-01', type: 'rent' }
    const aug  = { id: 'aug',  amount: 800, due_date: '2026-08-01', type: 'rent' }
    const r = allocateOldestFirst([arrears, sept, aug], 1600)
    expect(r.lines.map(l => l.payment_id)).toEqual(['aug', 'sept'])
  })
})

// ── S655 (money plan §1.4): the ONE allocation order ─────────────────
//
// Kim Harland's rent, water and trash were due the same day and created in the
// same second. Her $450 move-in special belongs on the rent; before the type
// tie-break, which line took the money depended on the order a query happened
// to return them in.
describe('S655 the one allocation order', () => {
  const at = '2026-09-01T07:00:00.000Z'
  const row = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, amount: 100, due_date: '2026-09-01', type, created_at: at, ...extra })

  it('same-day rows sort rent, utility, late fee, fee, home payment, then creation time', () => {
    const shuffled = [
      row('home', 'home_payment'),
      row('fee', 'fee'),
      row('late', 'late_fee'),
      row('deposit', 'deposit'),
      row('water-later', 'utility', { created_at: '2026-09-01T07:00:05.000Z' }),
      row('water', 'utility'),
      row('rent', 'rent'),
    ]
    expect(sortForAllocation(shuffled).map(r => r.id)).toEqual(
      ['rent', 'water', 'water-later', 'late', 'fee', 'home', 'deposit'])
  })

  it('same day, same type and same second: the id decides, so every path agrees', () => {
    const a = row('aaaa', 'utility'), b = row('bbbb', 'utility')
    expect(sortForAllocation([b, a]).map(r => r.id)).toEqual(['aaaa', 'bbbb'])
    expect(compareForAllocation(a, b)).toBeLessThan(0)
  })

  it('an older due date still beats the type order', () => {
    const oldFee = { ...row('old-fee', 'fee'), due_date: '2026-08-01' }
    expect(sortForAllocation([row('rent', 'rent'), oldFee]).map(r => r.id)).toEqual(['old-fee', 'rent'])
  })

  it('propane and carried balance still sink below everything', () => {
    const propane = row('propane', 'utility', { entry_description: 'PROPANE', due_date: '2026-07-01' })
    const carried = row('carried', 'carried_balance', { due_date: '2026-01-01' })
    const sorted = sortForAllocation([carried, propane, row('home', 'home_payment'), row('rent', 'rent')])
    expect(sorted.map(r => r.id)).toEqual(['rent', 'home', 'propane', 'carried'])
  })

  it('a row with no creation time sorts after the rows that have one, then by id (the SQL twin\'s NULLS LAST)', () => {
    const x = { id: 'zzz', amount: 10, due_date: '2026-09-01', type: 'utility' }
    const y = { id: 'aaa', amount: 10, due_date: '2026-09-01', type: 'utility' }
    const dated = row('mmm', 'utility')
    expect(sortForAllocation([x, y]).map(r => r.id)).toEqual(['aaa', 'zzz'])
    expect(sortForAllocation([x, dated, y]).map(r => r.id)).toEqual(['mmm', 'aaa', 'zzz'])
    // A missing creation time never jumps the type order or the due date.
    const rent = { id: 'zzz-rent', amount: 10, due_date: '2026-09-01', type: 'rent' }
    expect(sortForAllocation([dated, rent]).map(r => r.id)).toEqual(['zzz-rent', 'mmm'])
  })

  it('the order is total: rows with and without a creation time sort the same in every arrival order', () => {
    const rows = [
      row('b-dated', 'utility', { created_at: '2026-09-01T07:00:02.000Z' }),
      { id: 'c-undated', amount: 10, due_date: '2026-09-01', type: 'utility' },
      row('d-dated', 'utility'),
      { id: 'a-undated', amount: 10, due_date: '2026-09-01', type: 'utility', created_at: null },
      row('e-dated', 'utility'),
    ]
    const expected = ['d-dated', 'e-dated', 'b-dated', 'a-undated', 'c-undated']
    const permutations = <T,>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
    for (const p of permutations(rows)) expect(sortForAllocation(p).map(r => r.id)).toEqual(expected)
    // Antisymmetric and transitive over every pair and triple.
    const sign = (n: number) => Math.sign(n)
    for (const a of rows) for (const b of rows) {
      expect(sign(compareForAllocation(a, b)) + sign(compareForAllocation(b, a))).toBe(0)
      if (a !== b) expect(compareForAllocation(a, b)).not.toBe(0)
      for (const c of rows) {
        if (compareForAllocation(a, b) < 0 && compareForAllocation(b, c) < 0) expect(compareForAllocation(a, c)).toBeLessThan(0)
      }
    }
  })

  it('a credit the size of the rent lands on the rent (Kim Harland)', () => {
    const res = allocateOldestFirst(
      [row('trash', 'utility'), row('water', 'utility'), { ...row('rent', 'rent'), amount: 450 }], 450)
    expect(res.lines).toEqual([{ payment_id: 'rent', amount_applied: 450 }])
  })
})
