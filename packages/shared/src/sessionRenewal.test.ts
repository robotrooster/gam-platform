/**
 * S655 (Nic): sign-ins on the admin console, Support and GAM Books end a set
 * time after they started, even while in use, unless the person ticked "Keep
 * me signed in on this device". Every other portal keeps renewing while in use
 * (S654). The portals decide whether to ask for a renewal with
 * sessionRenewalDue, so a fixed pass must never read as due.
 */
import { describe, it, expect } from 'vitest'
import {
  sessionRenewalDue, sessionPolicyOfClaims, FIXED_SESSION_ROLES,
  readKeepSignedInChoice, rememberKeepSignedInChoice,
} from './sessionRenewal'

const DAY = 24 * 60 * 60
const now = () => Math.floor(Date.now() / 1000)

/** An unsigned pass with these claims — the helper only reads the payload. */
function pass(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`
}

describe('sessionRenewalDue', () => {
  it('a rolling pass older than a day is due for renewal', () => {
    expect(sessionRenewalDue(pass({ role: 'landlord', sp: 'rolling', iat: now() - 2 * DAY, exp: now() + 5 * DAY }))).toBe(true)
  })

  it('a rolling pass younger than a day is not due yet', () => {
    expect(sessionRenewalDue(pass({ role: 'landlord', sp: 'rolling', iat: now() - 3600, exp: now() + 6 * DAY }))).toBe(false)
  })

  it('a fixed pass is never renewed, however old it is', () => {
    expect(sessionRenewalDue(pass({ role: 'landlord', sp: 'fixed', iat: now() - 6 * DAY, exp: now() + DAY }))).toBe(false)
    expect(sessionRenewalDue(pass({ role: 'super_admin', sp: 'fixed', iat: now() - 6 * DAY, exp: now() + DAY }))).toBe(false)
  })

  it('a staff pass that chose to stay signed in renews like any other', () => {
    expect(sessionRenewalDue(pass({ role: 'super_admin', sp: 'rolling', iat: now() - 2 * DAY, exp: now() + 5 * DAY }))).toBe(true)
  })

  it('an older staff pass with no policy on it is treated as fixed, as it always behaved', () => {
    for (const role of FIXED_SESSION_ROLES) {
      expect(sessionRenewalDue(pass({ role, iat: now() - 2 * DAY, exp: now() + 5 * DAY }))).toBe(false)
    }
  })

  it('an older landlord or tenant pass with no policy on it keeps renewing', () => {
    expect(sessionRenewalDue(pass({ role: 'landlord', iat: now() - 2 * DAY, exp: now() + 5 * DAY }))).toBe(true)
    expect(sessionRenewalDue(pass({ role: 'tenant', iat: now() - 2 * DAY, exp: now() + 5 * DAY }))).toBe(true)
  })

  it('an expired pass, a pending sign-in pass, or garbage is never renewed', () => {
    expect(sessionRenewalDue(pass({ role: 'landlord', sp: 'rolling', iat: now() - 8 * DAY, exp: now() - 60 }))).toBe(false)
    expect(sessionRenewalDue(pass({ role: 'landlord', sp: 'rolling', purpose: 'email_otp_pending', iat: now() - 2 * DAY, exp: now() + 60 }))).toBe(false)
    expect(sessionRenewalDue('not-a-token')).toBe(false)
    expect(sessionRenewalDue(null)).toBe(false)
  })
})

describe('sessionPolicyOfClaims', () => {
  it('an explicit policy wins over the role', () => {
    expect(sessionPolicyOfClaims({ role: 'admin', sp: 'rolling' })).toBe('rolling')
    expect(sessionPolicyOfClaims({ role: 'landlord', sp: 'fixed' })).toBe('fixed')
  })
  it('with none, staff roles are fixed and everyone else rolling', () => {
    expect(sessionPolicyOfClaims({ role: 'portfolio_manager' })).toBe('fixed')
    expect(sessionPolicyOfClaims({ role: 'bookkeeper' })).toBe('rolling')
    expect(sessionPolicyOfClaims({ role: 'admin', sp: 'forever' })).toBe('fixed')
    expect(sessionPolicyOfClaims(null)).toBe('rolling')
  })
})

describe('the remembered "Keep me signed in" choice', () => {
  it('starts unticked and never throws when the browser has no storage', () => {
    // The API test runner is Node: no localStorage at all, like a blocked one.
    expect(readKeepSignedInChoice('gam_test_keep')).toBe(false)
    expect(() => rememberKeepSignedInChoice('gam_test_keep', true)).not.toThrow()
  })
})
