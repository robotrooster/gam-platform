/**
 * S630: a landlord has "spot 7", never a uuid.
 *
 * S628 stopped an invented id reaching a mutating endpoint but left no way
 * through, so every landlord action case in the two-turn run died: the model
 * asked the landlord for a uuid, or made one up and was refused. Resolution
 * happens in dispatch now, scoped to that landlord's own units.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn() }))
import { query } from '../../db'
import { dispatchPortalAction, __setTransport } from './portalDispatch'

const LANDLORD = {
  userId: 'u1', role: 'landlord', profileId: '', landlordIds: ['ll-1'],
  auth: { userId: 'u1', role: 'landlord', profileId: '', landlordIds: ['ll-1'] },
} as any

const UNITS = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'RV 07' },
  { id: '22222222-2222-4222-8222-222222222222', label: 'Apt 204' },
]

let sent: any = null
beforeEach(() => {
  sent = null
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret'
  ;(query as any).mockReset()
  ;(query as any).mockResolvedValue(UNITS)
  __setTransport(async (url: string, init: any) => {
    sent = { url, init }
    return { status: 200, json: { success: true, data: { ok: true } } }
  })
})
afterEach(() => __setTransport(null))

describe('dispatchPortalAction — unit id from what the landlord said', () => {
  it('resolves a spoken unit number to the real id', async () => {
    const res = await dispatchPortalAction(
      'set_eviction_mode', { unitId: 'spot 7', enable: true, confirm: true }, LANDLORD)
    expect(res.ok).toBe(true)
    expect(sent.url).toContain('11111111-1111-4111-8111-111111111111')
    // The number never reaches the endpoint as a path segment.
    expect(sent.url).not.toContain('spot')
  })

  it('passes a real uuid straight through', async () => {
    await dispatchPortalAction(
      'set_eviction_mode',
      { unitId: '22222222-2222-4222-8222-222222222222', enable: true, confirm: true }, LANDLORD)
    expect(sent.url).toContain('22222222-2222-4222-8222-222222222222')
  })

  // The whole point of S628: an id the agent made up must not reach a mutating
  // endpoint. It must still not, and now it fails with something useful.
  it('refuses an invented id and names the real units', async () => {
    const res: any = await dispatchPortalAction(
      'set_eviction_mode', { unitId: 'unit_12345', enable: true, confirm: true }, LANDLORD)
    expect(res.ok).toBe(false)
    expect(sent).toBeNull()                       // nothing was dispatched
    expect(res.error).toMatch(/nothing on this account matches "unit_12345"/i)
    expect(res.error).toMatch(/RV 07/)            // tells the agent what IS there
    expect(res.error).toMatch(/never invent an id/i)
  })

  // Eviction is not a thing to guess at.
  it('refuses rather than choosing between two units with the same number', async () => {
    ;(query as any).mockResolvedValue([
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'RV 07' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Lot 7' },
    ])
    const res: any = await dispatchPortalAction(
      'set_eviction_mode', { unitId: '7', enable: true, confirm: true }, LANDLORD)
    expect(res.ok).toBe(false)
    expect(sent).toBeNull()
    expect(res.error).toMatch(/matches more than one/i)
    expect(res.error).toMatch(/RV 07, Lot 7/)
    expect(res.error).toMatch(/Do NOT pick one/i)
  })

  // Scoping is the safety property: the lookup is by landlord_id, so another
  // landlord's unit is not a candidate whatever the model passes.
  it('only ever considers this landlord\'s own units', async () => {
    await dispatchPortalAction(
      'set_eviction_mode', { unitId: 'RV 07', enable: true, confirm: true }, LANDLORD)
    const sql = (query as any).mock.calls[0][0]
    const params = (query as any).mock.calls[0][1]
    expect(sql).toMatch(/p\.landlord_id = ANY\(\$1/)
    expect(params).toEqual([['ll-1']])
  })

  // S630: leases and properties are named in words, not numbers — "the Alvarez
  // lease", "Oak Park" — and 18 lease actions and 10 property actions carried
  // the same "from a lookup" id the landlord does not have.
  it('resolves a lease by the tenant name the landlord used', async () => {
    ;(query as any).mockResolvedValue([
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'Apt 204 — Maria Alvarez' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'RV 07 — Bob Chen' },
    ])
    await dispatchPortalAction('update_lease', { leaseId: 'Alvarez', rentAmount: 1050 }, LANDLORD)
    expect(sent.url).toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })

  it('resolves a lease by its unit number too', async () => {
    ;(query as any).mockResolvedValue([
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'Apt 204 — Maria Alvarez' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'RV 07 — Bob Chen' },
    ])
    await dispatchPortalAction('update_lease', { leaseId: '204', rentAmount: 1050 }, LANDLORD)
    expect(sent.url).toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })

  it('refuses a name that matches two leases rather than picking one', async () => {
    ;(query as any).mockResolvedValue([
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'Apt 204 — Sam Chen' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'RV 07 — Bob Chen' },
    ])
    const res: any = await dispatchPortalAction(
      'update_lease', { leaseId: 'Chen', rentAmount: 1050 }, LANDLORD)
    expect(res.ok).toBe(false)
    expect(sent).toBeNull()
    expect(res.error).toMatch(/matches more than one/i)
    expect(res.error).toMatch(/Do NOT pick one/i)
  })

  it('asks for the number when none was given', async () => {
    const res: any = await dispatchPortalAction(
      'set_eviction_mode', { enable: true, confirm: true }, LANDLORD)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/which unit/i)
    expect(res.error).toMatch(/do not need an id/i)
  })
})
