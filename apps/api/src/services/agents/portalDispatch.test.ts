/**
 * S626 — the dispatcher is the security boundary, so it is tested like one.
 *
 * It lets the agent perform real actions through real endpoints with real
 * authorization. Everything that keeps that safe lives here: the allowlist, the
 * audience check, failing closed without credentials, and a token that carries
 * the caller's own claims and cannot widen them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { dispatchPortalAction, __setTransport } from './portalDispatch'
import { PORTAL_ACTIONS, getPortalAction } from './portalActions'

const LANDLORD = {
  userId: 'u1', role: 'landlord', profileId: '99999999-9999-4999-8999-999999999999',
  auth: { userId: 'u1', role: 'landlord', profileId: '99999999-9999-4999-8999-999999999999', email: 'a@b.dev',
          permissions: { 'leases.edit': true }, iat: 111, exp: 222 },
} as any
const ANON = { userId: 'c1', role: 'prospect', profileId: 'c1' } as any

let seen: { url: string; init: any }[] = []
beforeEach(() => {
  seen = []
  process.env.JWT_SECRET ||= 'test-secret'
  __setTransport(async (url, init) => { seen.push({ url, init }); return { status: 200, json: { data: { id: 'x' } } } })
})
afterEach(() => { __setTransport(null) })

describe('the allowlist is the boundary', () => {
  it('refuses an action that is not declared', async () => {
    const r = await dispatchPortalAction('delete_everything', {}, LANDLORD)
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('unknown_action')
    expect(seen).toHaveLength(0)   // nothing was sent
  })

  it('contains nothing from another portal, and nothing credential-shaped', () => {
    const banned = /\/(admin|business|pos|platform|superadmin)\b|password|otp|totp|two-factor|\/stripe\/|card/i
    for (const a of PORTAL_ACTIONS) {
      expect(banned.test(a.path), `${a.id} → ${a.path}`).toBe(false)
    }
  })

  it('every action is landlord or tenant — no other audience can dispatch', () => {
    for (const a of PORTAL_ACTIONS) {
      expect(['landlord', 'tenant'], a.id).toContain(a.audience)
    }
  })
})

describe('audience and credentials', () => {
  it('a landlord cannot reach a tenant action', async () => {
    const tenantAction = PORTAL_ACTIONS.find((a) => a.audience === 'tenant')!
    const r = await dispatchPortalAction(tenantAction.id, {}, LANDLORD)
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('wrong_audience')
    expect(seen).toHaveLength(0)
  })

  it('an anonymous audience is refused before anything else', async () => {
    // A prospect or a site visitor has no landlord actions at all, so the
    // audience gate stops it first. Either refusal is safe; this is the order.
    const r = await dispatchPortalAction('add_units', { propertyId: 'p', unitNumber: '1' }, ANON)
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('wrong_audience')
    expect(seen).toHaveLength(0)
  })

  it('fails CLOSED for the right audience with no credentials', async () => {
    // The real case: a landlord session that somehow carries no claims. It must
    // do nothing and must not let the agent pretend it did.
    const noAuth = { userId: 'u1', role: 'landlord', profileId: '99999999-9999-4999-8999-999999999999' } as any
    const r = await dispatchPortalAction('add_units', { propertyId: 'p', unitNumber: '1' }, noAuth)
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('no_credentials')
    expect(r.error).toMatch(/do not claim it was done/i)
    expect(seen).toHaveLength(0)
  })

  it('refuses before building a URL when a path param is missing', async () => {
    const r = await dispatchPortalAction('update_unit', {}, LANDLORD)
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('missing_param')
    // A missing :unitId would otherwise produce a literal ":unitId" in the URL.
    // S630: ids here are real uuids — a non-uuid unitId is now READ as a unit
    // number and resolved against the landlord's own units before dispatch.
    expect(seen).toHaveLength(0)
  })
})

describe('the internal token carries the caller and nothing more', () => {
  it('mints from the caller’s own claims and cannot widen them', async () => {
    await dispatchPortalAction('update_unit', { unitId: '88888888-8888-4888-8888-888888888888', rentAmount: 1250 }, LANDLORD)
    const auth = seen[0].init.headers.Authorization.replace('Bearer ', '')
    const decoded: any = jwt.verify(auth, process.env.JWT_SECRET!)
    expect(decoded.userId).toBe('u1')
    expect(decoded.role).toBe('landlord')
    expect(decoded.permissions).toEqual({ 'leases.edit': true })
    // Short-lived, and the caller's original iat/exp are not carried through.
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(60)
    expect(decoded.exp).not.toBe(222)
  })

  it('puts path params in the path and everything else in the body', async () => {
    await dispatchPortalAction('update_unit', { unitId: '88888888-8888-4888-8888-888888888888', rentAmount: 1250 }, LANDLORD)
    expect(seen[0].url).toMatch(/\/api\/units\/88888888-8888-4888-8888-888888888888\/details$/)
    expect(JSON.parse(seen[0].init.body)).toEqual({ rentAmount: 1250 })
    expect(seen[0].init.method).toBe('PATCH')
  })

  it('marks the call as coming from the assistant, for the audit trail', async () => {
    await dispatchPortalAction('update_unit', { unitId: '88888888-8888-4888-8888-888888888888' }, LANDLORD)
    expect(seen[0].init.headers['X-GAM-Actor']).toBe('agent')
  })
})

describe('a refusal from the API is passed through honestly', () => {
  it('does not invent a reason, and does not report success', async () => {
    __setTransport(async () => ({ status: 409, json: { error: 'This unit is in eviction mode' } }))
    const r = await dispatchPortalAction('update_unit', { unitId: '88888888-8888-4888-8888-888888888888' }, LANDLORD)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('This unit is in eviction mode')
  })

  it('an unreachable API is never reported as done', async () => {
    __setTransport(async () => { throw new Error('ECONNREFUSED') })
    const r = await dispatchPortalAction('update_unit', { unitId: '88888888-8888-4888-8888-888888888888' }, LANDLORD)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/do NOT tell them it was done/i)
  })
})

describe('every declared action is reachable as a tool', () => {
  it('has a matching generated tool with the same audience', async () => {
    const { PORTAL_ACTION_TOOLS } = await import('./tools/portalActionTools')
    expect(PORTAL_ACTION_TOOLS).toHaveLength(PORTAL_ACTIONS.length)
    for (const t of PORTAL_ACTION_TOOLS) {
      const a = getPortalAction(t.name)!
      expect(a, t.name).toBeTruthy()
      expect(t.audiences).toEqual([a.audience])
    }
  })

  it('anything that changes an account says CONFIRM FIRST', async () => {
    const { PORTAL_ACTION_TOOLS } = await import('./tools/portalActionTools')
    for (const t of PORTAL_ACTION_TOOLS) {
      if (getPortalAction(t.name)!.confirmFirst) {
        expect(t.description, t.name).toMatch(/CONFIRM FIRST/)
      }
    }
  })
})
