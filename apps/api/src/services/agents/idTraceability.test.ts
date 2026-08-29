/**
 * S628 — the invented id, which is the one invention nobody was checking.
 *
 * Every other net in the runner reads the REPLY. This one reads the tool
 * ARGUMENTS, because the reply can be perfectly honest while the call under it
 * carries a fabricated reference.
 *
 * From the validation run, a landlord starting an eviction:
 *   ▸ "I'm starting an eviction on spot 7"  → agent asks for a unit ID
 *   ▸ "yes, turn it on"                     → set_eviction_mode(unitId: 'unit_12345')
 *
 * The 500 it got back was the lucky outcome. An invented id that happens to
 * MATCH turns eviction mode on for the wrong tenant: a real notice, a real
 * clock, the wrong home.
 */
import { describe, it, expect } from 'vitest'
import { untraceableIdArgs, lookItUpFirst } from './idTraceability'

const RESULT = JSON.stringify({ units: [{ id: 'a3f9c2e1-77b4-4d2a-9f10-5c8e6b1d0a44', label: 'Spot 7' }] })

describe('untraceableIdArgs', () => {
  it('catches the measured case — an id no lookup returned', () => {
    expect(untraceableIdArgs({ unitId: 'unit_12345' }, [RESULT])).toEqual(['unitId'])
  })

  it('allows an id a tool actually returned, however deeply nested', () => {
    expect(untraceableIdArgs(
      { unitId: 'a3f9c2e1-77b4-4d2a-9f10-5c8e6b1d0a44', evicting: true }, [RESULT])).toEqual([])
  })

  it('allows an id the person typed themselves', () => {
    // A landlord pasting a reference is quoting a real one.
    expect(untraceableIdArgs({ leaseId: 'lease_88c1f0d7a2' },
      ['', 'cancel lease_88c1f0d7a2 please'])).toEqual([])
  })

  it('ignores arguments that are not references', () => {
    // "spot 7" is a NAME. A number, a flag and a short word are not ids, and
    // firing on them would block ordinary calls.
    expect(untraceableIdArgs(
      { unitId: '7', evicting: true, reason: 'nonpayment', count: 3 } as any, [RESULT])).toEqual([])
  })

  it('refuses an id on the very first action, when nothing has been looked up', () => {
    expect(untraceableIdArgs({ unitId: 'unit_12345' }, [])).toEqual(['unitId'])
    // ...but still lets a non-reference through, so a first action with real
    // arguments is not blocked for having no history.
    expect(untraceableIdArgs({ title: 'Leak', unitId: '7' } as any, [])).toEqual([])
  })

  it('only inspects id-shaped argument names', () => {
    expect(untraceableIdArgs({ description: 'the long-ish free text nobody looked up' }, [RESULT])).toEqual([])
  })

  it('names every offending argument, not just the first', () => {
    expect(untraceableIdArgs({ unitId: 'unit_12345', leaseId: 'lease_99999x' }, [RESULT]))
      .toEqual(['unitId', 'leaseId'])
  })
})

describe('lookItUpFirst', () => {
  it('tells the model to look it up rather than guess again', () => {
    const msg = lookItUpFirst(['unitId'])
    expect(msg).toContain('unitId')
    expect(msg).toMatch(/do not retry with another guess/i)
    expect(msg).toMatch(/look the record up first/i)
  })
})
