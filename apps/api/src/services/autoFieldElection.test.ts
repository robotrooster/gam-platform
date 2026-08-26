/**
 * S622: the term election is the hardest thing in a lease, and the thing most
 * likely to break silently. It is pinned here against a synthetic document that
 * reproduces every difficulty in Oak Park's, so a change that quietly flattens
 * the nesting or loses the second option fails a test instead of a signature.
 *
 * Nic's actual requirement, in his words: "if I were to completely delete this
 * template and then click to auto place my fields again, I would want the auto
 * placement engine to come up with the same results that we have right now."
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { autoPlaceFields } from './autoFieldPlacement'
import { makeElectionLease } from '../test/fixtures/makeElectionLease'

let fields: any[]
const byLabel = (frag: string) =>
  fields.find(f => String(f.label ?? '').toLowerCase().includes(frag.toLowerCase()))

beforeAll(async () => {
  const r = await autoPlaceFields(await makeElectionLease())
  fields = r.fields
}, 300000)

describe('S622 term election on a hard document', () => {
  it('finds BOTH options of the outer election, across the page break', () => {
    const outer = fields.find(f => f.leaseColumn === 'lease_type')
    expect(outer, 'no lease_type election detected').toBeTruthy()
    expect(outer.options).toMatch(/fixed term/i)
    expect(outer.options).toMatch(/month-to-month/i)
    // The second option lives on page 2 and must have its own box there.
    const second = fields.find(f => f.parentOption && /month-to-month/i.test(f.parentOption)
      && String(f.label ?? '').toLowerCase() === String(f.parentOption).toLowerCase())
    expect(second, 'the second option has no box of its own').toBeTruthy()
    expect(second.page).toBe(2)
  })

  it('finds the NESTED election and hangs it on the first option', () => {
    const inner = fields.find(f => f.leaseColumn === 'auto_renew_mode')
    expect(inner, 'no nested election detected').toBeTruthy()
    expect(inner.parentOption).toMatch(/fixed term/i)
    expect(inner.options).toMatch(/continue/i)
    expect(inner.options).toMatch(/vacate/i)
  })

  it('does not confuse the two elections — indentation separates them', () => {
    const outer = fields.find(f => f.leaseColumn === 'lease_type')
    const inner = fields.find(f => f.leaseColumn === 'auto_renew_mode')
    expect(outer.options).not.toMatch(/vacate/i)   // the inner pair is not the outer's
    expect(inner.options).not.toMatch(/month-to-month term/i)
    expect(inner.x).toBeGreaterThan(outer.x)       // and it is printed indented
  })

  it('binds each branch’s blanks to that branch', () => {
    const start = fields.find(f => f.leaseColumn === 'start_date')
    const end   = fields.find(f => f.leaseColumn === 'end_date')
    expect(start?.parentOption).toMatch(/fixed term/i)
    expect(end?.parentOption).toMatch(/fixed term/i)
  })

  it('stops at the next numbered clause — rent is NOT part of the election', () => {
    const rent = fields.find(f => f.leaseColumn === 'rent_amount')
    expect(rent, 'rent blank not found').toBeTruthy()
    expect(rent.parentOption ?? null).toBeNull()
  })

  it('gives the same answer every run — the structure is parsed, not guessed', async () => {
    const shape = (fs: any[]) => fs
      .filter(f => f.fieldType === 'radio_group' || f.parentKey)
      .map(f => `${f.page}:${Math.round(f.x)}:${f.leaseColumn ?? ''}:${f.parentOption ?? ''}`)
      .sort().join('|')
    const again = await autoPlaceFields(await makeElectionLease())
    expect(shape(again.fields)).toBe(shape(fields))
  }, 300000)
})
