/**
 * 10/27 (Nic) — WHAT A PRINTED STATEMENT SAYS.
 *
 *   "main charges should be at the top of the thing with late fees being
 *    underneath... It needs to be main charges first, chronological order, late
 *    fees, chronological order... Rent for July, August, September, and October
 *    should also be combined onto that one line item."
 *
 * Two earlier layouts grouped by INVOICE, which is how the ledger is built and
 * not how a bill is read: six months of rent came out as six headings with one
 * line each, late fees scattered between them, and — worse — May and June rent
 * merged under a heading that said "May", which made correct billing look like
 * a double charge.
 */
import { describe, it, expect } from 'vitest'
import { itemizeSheet } from './BillPrintPage'

const line = (label: string, amount: number, dueDate: string, opts: { detail?: string | null; type?: string; gam?: boolean } = {}) =>
  ({ id: `${label}-${dueDate}-${amount}`, label, amount, dueDate, detail: opts.detail ?? null, type: opts.type, open: true, gam: opts.gam }) as any
const bill = (id: string, dueDate: string, lines: any[]) =>
  ({ id, invoiceNumber: id, dueDate, lines, amountPaid: 0, creditApplied: 0, balance: 0, totalAmount: 0, unitNumber: null, propertyName: null }) as any

describe('a printed statement', () => {
  it("combines six months of rent into one line that names the months", () => {
    const bills = ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']
      .map((d, i) => bill(`INV-${i}`, d, [line('Rent', 1195, d)]))
    const { charges } = itemizeSheet(bills)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ label: 'Rent', qty: 6, unit: 1195, amount: 7170 })
    // The months must be ON the line — collapsing six charges and saying
    // nothing else hides which months are behind.
    expect(charges[0].when).toBe('May, Jun, Jul, Aug, Sep, Oct 2026')
  })

  it('puts charges first and late fees under them, each oldest first', () => {
    const bills = [
      bill('a', '2026-09-01', [line('Late fee', 15, '2026-09-05', { type: 'late_fee' }), line('Rent', 1195, '2026-09-01')]),
      bill('b', '2026-08-01', [line('Rent', 1195, '2026-08-01'), line('Water', 61.25, '2026-08-01', { detail: 'meter 1204 → 1261' })]),
      bill('c', '2026-10-01', [line('Late fee', 15, '2026-10-05', { type: 'late_fee' })]),
    ]
    const { charges, lateFees } = itemizeSheet(bills)
    expect(charges.map(c => c.label)).toEqual(['Rent', 'Water'])
    expect(charges[0].qty).toBe(2)            // August + September rent, together
    expect(lateFees.map(c => c.label)).toEqual(['Late fee'])
    expect(lateFees[0]).toMatchObject({ qty: 2, unit: 15, amount: 30 })
  })

  it("Soren Tremaine's 54 daily late fees are one line, not a page and a half", () => {
    const days = Array.from({ length: 54 }, (_, i) =>
      line('Late fee', 5, `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, { type: 'late_fee' }))
    const { lateFees } = itemizeSheet([bill('x', '2026-09-01', days)])
    expect(lateFees).toHaveLength(1)
    expect(lateFees[0]).toMatchObject({ qty: 54, unit: 5, amount: 270 })
  })

  it('one of a thing carries its own date, not a month list', () => {
    const { charges } = itemizeSheet([bill('a', '2026-07-01', [line('Rent', 1195, '2026-07-01')])])
    expect(charges[0].qty).toBe(1)
    expect(charges[0].when).toBe('July 1, 2026')
  })

  it('same price, different charge: never merged', () => {
    const { charges } = itemizeSheet([bill('a', '2026-07-01', [
      line('Key fee', 5, '2026-07-01'), line('Pet fee', 5, '2026-07-01'),
    ])])
    expect(charges).toHaveLength(2)
    expect(charges.every(c => c.qty === 1)).toBe(true)
  })

  it('two water bills on different reads stay apart — the read is part of the charge', () => {
    const { charges } = itemizeSheet([bill('a', '2026-07-01', [
      line('Water', 20, '2026-07-01', { detail: 'meter 100 → 120' }),
      line('Water', 20, '2026-08-01', { detail: 'meter 300 → 320' }),
    ])])
    expect(charges).toHaveLength(2)
  })

  it('months from different years are each named with their year', () => {
    const { charges } = itemizeSheet([
      bill('a', '2025-12-01', [line('Rent', 1000, '2025-12-01')]),
      bill('b', '2026-01-01', [line('Rent', 1000, '2026-01-01')]),
    ])
    expect(charges[0].when).toBe('Dec 2025, Jan 2026')
  })

  it('nothing owed itemises to nothing', () => {
    expect(itemizeSheet([])).toEqual({ charges: [], lateFees: [] })
  })
})

/**
 * 10/28 (Nic): a charge of GAM's rides the bill but is not one of the
 * landlord's priced lines — "not counted in the landlord's books". It is stated
 * once under their totals ("Tenant owes GAM"), so it must stay out of the itemized
 * rows, which sum to the landlord's own subtotal.
 */
describe("GAM's own charge on a printed statement", () => {
  it('is not one of the itemized charges', () => {
    const bills = [bill('a', '2026-10-01', [
      line('Rent', 440, '2026-10-01'),
      line('Security deposit', 2000, '2026-10-01', { type: 'deposit' }),
      line('Tenant owes GAM', 124, '2026-10-01', { type: 'fee', gam: true }),
    ])]
    const { charges, lateFees } = itemizeSheet(bills)
    expect(charges.map(c => c.label)).toEqual(['Rent', 'Security deposit'])
    expect(lateFees).toHaveLength(0)
    // The rows sum to the landlord's own money and nothing else.
    expect(charges.reduce((t, c) => t + c.amount, 0)).toBe(2440)
  })

  it('keeps the deposit whole, as the landlord is shown it', () => {
    const bills = [bill('a', '2026-10-01', [
      line('Security deposit', 2000, '2026-10-01', { type: 'deposit' }),
    ])]
    const { charges } = itemizeSheet(bills)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ label: 'Security deposit', qty: 1, amount: 2000, detail: null })
  })
})
