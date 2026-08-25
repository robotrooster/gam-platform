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
