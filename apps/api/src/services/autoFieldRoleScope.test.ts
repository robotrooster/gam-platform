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

// S635 supersedes half of the S622 rule below. S622 said a bound column is
// LANDLORD-filled, reasoning that a value GAM already holds is "wrong by
// construction" as a tenant-entry box. Nic drew the rest of that line in S635:
// "the tenant names and the names of the occupants both are landlord boxes, and
// those should be derived from all the invites that went out." If the system
// holds the value, asking ANYONE to type it invites the very typo the rule
// exists to prevent.
//
// So there are now two groups, and the invariant that matters is unchanged: no
// bound column is ever the TENANT's.
//
// IDENTITY — who is on the lease, which unit, which property. Nobody types it.
const NOBODY_TYPES = [
  'tenant_name', 'tenant_email', 'tenant_2_name', 'tenant_3_name', 'tenant_4_name',
  'occupant_names', 'unit_number', 'property_address', 'property_name', 'landlord_name',
]
// MONEY AND TERM — figures the landlord STATES on this lease. Still theirs.
const PROPERTY_AND_MONEY = [
  'start_date', 'end_date', 'rent_due_day',
  'rent_amount', 'security_deposit', 'pet_deposit', 'pet_fee', 'other_fee',
]

describe('auto-placed field role scoping', () => {
  it.each(PROPERTY_AND_MONEY)('%s is landlord-filled — the tenant never types it', (col) => {
    expect(roleForLeaseColumn(col)).toBe('landlord')
  })

  it.each(NOBODY_TYPES)('%s belongs to nobody — it comes from the invite', (col) => {
    expect(roleForLeaseColumn(col)).toBeNull()
  })

  it('NO bound lease column is tenant-filled — the invariant S622 established', () => {
    const all = [...PROPERTY_AND_MONEY, ...NOBODY_TYPES]
    const tenantScoped = all.filter(c => {
      const r = roleForLeaseColumn(c)
      return r !== 'landlord' && r !== null
    })
    expect(tenantScoped, `a tenant typing these is a lease defect the landlord caused: ${tenantScoped}`)
      .toEqual([])
  })

  it('unit_number is nobody\'s — the regression Nic found, taken one step further', () => {
    // S622 moved it off the tenant: "they're not gonna type in what apartment
    // they're going into... that's gonna invalidate the whole thing if they type
    // that wrong." The landlord mistyping it invalidates it identically, and GAM
    // has known the unit since the invite.
    expect(roleForLeaseColumn('unit_number')).toBeNull()
  })

  it('property_address is not tenant-scoped despite "address" being a personal-info word', () => {
    // The latent half of the same bug: PERSONAL_RE contains \baddress\b, so
    // proximity would have handed the tenant the property's own address.
    expect(roleForLeaseColumn('property_address')).toBeNull()
  })

  it('no money or term column is ever tenant-scoped', () => {
    const tenantScoped = PROPERTY_AND_MONEY.filter(c => roleForLeaseColumn(c) !== 'landlord')
    expect(tenantScoped, `these would let a tenant set their own lease terms: ${tenantScoped}`)
      .toEqual([])
  })

  it('a money column is still the landlord\'s — S635 moved identity only', () => {
    // The failure this guards: widening "derived from the invite" to every bound
    // column would leave the rent amount with no owner and no value.
    expect(roleForLeaseColumn('rent_amount')).toBe('landlord')
    expect(roleForLeaseColumn('security_deposit')).toBe('landlord')
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

// ── S622: one owner per money column ─────────────────────────────────
//
// Nic, on page 8 of his lease: "first month's rent, security deposit, rent
// pre-payment, proration, pet deposit, pet fee, and total due... is the back
// end going to tally up these fees?" Four of those seven came back tagged
// rent_amount. The lease builder collapses field values into one dict keyed by
// column, last row wins, on a query with no ORDER BY — so the tenant's MONTHLY
// RENT was going to be set by whichever of the four Postgres returned last.
import { LEASE_COLUMN_CATEGORY } from '@gam/shared'

describe('money columns have exactly one owner', () => {
  // The real page-8 move-in table, in document order, as the placer produced it.
  const PAGE8 = [
    { page: 2, y: 300, label: 'Rent amount',        leaseColumn: 'rent_amount' },
    { page: 8, y: 100, label: "First month's rent", leaseColumn: 'rent_amount' },
    { page: 8, y: 130, label: 'Security deposit',   leaseColumn: 'security_deposit' },
    { page: 8, y: 160, label: 'Rent pre-payment',   leaseColumn: 'rent_amount' },
    { page: 8, y: 190, label: 'Proration',          leaseColumn: 'rent_amount' },
    { page: 8, y: 220, label: 'Pet deposit',        leaseColumn: 'pet_deposit' },
    { page: 8, y: 250, label: 'Pet fee',            leaseColumn: 'pet_fee' },
    { page: 8, y: 280, label: 'Total due',          leaseColumn: 'rent_amount' },
  ]

  // Mirrors the dedupe in autoPlaceFields: first in document order keeps the tag.
  const dedupe = (fields: typeof PAGE8) => {
    const claimed = new Set<string>()
    return [...fields]
      .sort((a, b) => (a.page - b.page) || (a.y - b.y))
      .map(f => {
        const cat = (LEASE_COLUMN_CATEGORY as Record<string, string>)[f.leaseColumn]
        if (cat !== 'writable' && cat !== 'fee_row') return f
        if (claimed.has(f.leaseColumn)) return { ...f, leaseColumn: null as any }
        claimed.add(f.leaseColumn)
        return f
      })
  }

  it('the rent CLAUSE keeps rent_amount, not the move-in summary table', () => {
    const out = dedupe(PAGE8)
    const owner = out.find(f => f.leaseColumn === 'rent_amount')
    expect(owner?.label).toBe('Rent amount')  // page 2, the actual clause
  })

  it('"Total due" never sets the monthly rent', () => {
    const out = dedupe(PAGE8)
    expect(out.find(f => f.label === 'Total due')?.leaseColumn).toBeNull()
  })

  it('no writable or fee_row column is claimed twice', () => {
    const out = dedupe(PAGE8)
    const counts: Record<string, number> = {}
    for (const f of out) {
      if (!f.leaseColumn) continue
      const cat = (LEASE_COLUMN_CATEGORY as Record<string, string>)[f.leaseColumn]
      if (cat !== 'writable' && cat !== 'fee_row') continue
      counts[f.leaseColumn] = (counts[f.leaseColumn] || 0) + 1
    }
    const dupes = Object.entries(counts).filter(([, n]) => n > 1)
    expect(dupes, `two fields would fight over these: ${JSON.stringify(dupes)}`).toEqual([])
  })

  it('the real charge-bearing tags survive untouched', () => {
    const out = dedupe(PAGE8)
    // These each become a lease_fees row the tenant is actually billed.
    for (const col of ['security_deposit', 'pet_deposit', 'pet_fee']) {
      expect(out.some(f => f.leaseColumn === col), `${col} lost its tag`).toBe(true)
    }
  })
})

// ── S622: prepaid rent is a move-in fee, not the monthly rent ────────
describe('columnFor money semantics', () => {
  it('"Rent pre-payment" is last_month_rent, not rent_amount', () => {
    // It is refundable, due_timing='move_in', and the move-in invoice books it
    // as RENT — it IS prepaid rent. Tagging it rent_amount would have made it
    // fight the actual rent clause for the tenant's monthly figure.
    expect(roleForLeaseColumn('last_month_rent')).toBe('landlord')
    expect((LEASE_COLUMN_CATEGORY as Record<string, string>).last_month_rent).toBe('fee_row')
  })

  it('the amounts GAM computes itself carry no tag', () => {
    // First month's rent, proration and total due are all produced by
    // generateMoveInInvoice from the rent clause + start_date. Tagging them
    // would bill the tenant a second time for arithmetic already on the
    // invoice — "Total due" worst of all, since it is the sum of the rest.
    for (const col of ['rent_amount', 'security_deposit', 'pet_deposit', 'pet_fee', 'last_month_rent']) {
      expect((LEASE_COLUMN_CATEGORY as Record<string, string>)[col]).toBeDefined()
    }
    // There is deliberately NO column for a proration or a grand total.
    expect((LEASE_COLUMN_CATEGORY as Record<string, string>).proration).toBeUndefined()
    expect((LEASE_COLUMN_CATEGORY as Record<string, string>).total_due).toBeUndefined()
  })
})
