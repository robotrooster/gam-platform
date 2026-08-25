/**
 * S622: who owns an auto-placed box.
 *
 * Nic caught the unit number scoped to the tenant on his first real lease:
 * "they're not gonna type in what apartment they're going into in the lease.
 * That's gonna invalidate the whole thing if they type that wrong."
 *
 * The rule the placer is supposed to follow was already written in its own
 * comment — "the tenant must never set rent, term dates, space number, fees" —
 * but the role decision consulted the words AROUND the blank before the column
 * it had already resolved. "Apartment #" on an "Address:" line matched the
 * personal-info pattern and lost.
 *
 * These are money and term values on a signed lease. A wrong one is not a
 * cosmetic defect, so the guard is exhaustive over every column the placer can
 * assign rather than a spot check.
 */
import { describe, it, expect } from 'vitest'
import { roleForLeaseColumn } from './autoFieldPlacement'

// Every column columnFor() can return, plus tenant_name from the personal path.
const PROPERTY_AND_MONEY = [
  'unit_number', 'property_address',
  'start_date', 'end_date', 'rent_due_day',
  'rent_amount', 'security_deposit', 'pet_deposit', 'pet_fee', 'other_fee',
]
// S622: Nic extended the rule to names — "for accuracy, and that way if there
// ever is a fault, the landlord can't blame it on the tenant." Every value GAM
// already holds is the landlord's to state, so NO bound column is tenant-filled.
const LANDLORD_TOO = ['tenant_name', 'tenant_email']

describe('auto-placed field role scoping', () => {
  it.each(PROPERTY_AND_MONEY)('%s is landlord-filled — the tenant never types it', (col) => {
    expect(roleForLeaseColumn(col)).toBe('landlord')
  })

  it.each(LANDLORD_TOO)('%s is landlord-filled — the landlord states it, not the tenant', (col) => {
    expect(roleForLeaseColumn(col)).toBe('landlord')
  })

  it('NO bound lease column is tenant-filled — the landlord owns every value GAM holds', () => {
    const all = [...PROPERTY_AND_MONEY, ...LANDLORD_TOO]
    const tenantScoped = all.filter(c => roleForLeaseColumn(c) !== 'landlord')
    expect(tenantScoped, `a tenant typing these is a lease defect the landlord caused: ${tenantScoped}`)
      .toEqual([])
  })

  it('unit_number is landlord-scoped — the regression Nic found', () => {
    expect(roleForLeaseColumn('unit_number')).toBe('landlord')
  })

  it('property_address is landlord-scoped despite "address" being a personal-info word', () => {
    // The latent half of the same bug: PERSONAL_RE contains \\baddress\\b, so
    // proximity would have handed the tenant the property's own address.
    expect(roleForLeaseColumn('property_address')).toBe('landlord')
  })

  it('no money or term column is ever tenant-scoped', () => {
    const tenantScoped = PROPERTY_AND_MONEY.filter(c => roleForLeaseColumn(c) !== 'landlord')
    expect(tenantScoped, `these would let a tenant set their own lease terms: ${tenantScoped}`)
      .toEqual([])
  })
})

// ── S622: signature-column binding ───────────────────────────────────
//
// Nic, reviewing page 8 of the first real lease: "the first two dates for the
// first two tenants [are] not linked to when they actually sign. It's linked to
// when the landlord signed." A signing date attributed to the wrong party is a
// defect in a signed instrument, so this is worth pinning exactly.
import { signerColumnAt } from './autoFieldPlacement'

describe('signerColumnAt — which signature column a box belongs to', () => {
  // The real geometry off Oak Park's lease: two columns, each ~182 wide.
  const LABELS = [
    { role: 'primary' as const,  x: 43,  y: 334 },
    { role: 'landlord' as const, x: 295, y: 334 },
  ]
  const BELOW = 284 // a date row under the signature line

  it('binds a date under the tenant signature to the TENANT', () => {
    // The regression: x=132 is inside the tenant column (43..225).
    expect(signerColumnAt(LABELS, 132, BELOW)).toBe('primary')
  })

  it('binds a date under the landlord signature to the LANDLORD', () => {
    expect(signerColumnAt(LABELS, 384, BELOW)).toBe('landlord')
  })

  it('binds each column at its own left edge', () => {
    expect(signerColumnAt(LABELS, 43, BELOW)).toBe('primary')
    expect(signerColumnAt(LABELS, 295, BELOW)).toBe('landlord')
  })

  it('never lets a box in the left column bind to the right one', () => {
    // Every x across the tenant block must stay with the tenant — the old
    // nearest-by-distance rule flipped partway across it.
    for (let x = 43; x < 295; x += 7) {
      expect(signerColumnAt(LABELS, x, BELOW), `x=${x} escaped the tenant column`).toBe('primary')
    }
  })

  it('falls back to the nearest label when a box sits left of every column', () => {
    expect(signerColumnAt(LABELS, 5, BELOW)).toBe('primary')
  })

  it('ignores labels that sit below the box', () => {
    const onlyBelow = [{ role: 'landlord' as const, x: 295, y: 100 }]
    expect(signerColumnAt(onlyBelow, 384, BELOW)).toBe('primary') // no label above → default
  })
})
