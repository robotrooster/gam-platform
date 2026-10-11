/**
 * Final sweep (10/3) — a temporary lock never signs a tenant out.
 *
 * Five wrong passwords lock the account for fifteen minutes. The app renews its
 * pass on load and whenever it comes back into view; that renewal used to be
 * answered 401 during a lock, and a 401 reads as "this pass is dead", so the
 * tenant was signed out without a word. The server now answers 423 and the app
 * keeps the pass it holds.
 */
import { describe, it, expect, vi } from 'vitest'
import { renewTenantSession, renewalAnswerIsLock, RENEWAL_LOCKED_STATUS } from './sessionRenewal'

// A tenant pass signed two days ago, good for five more (the signature is never read).
const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const now = Math.floor(Date.now() / 1000)
const OLD_PASS = `${b64({ alg: 'HS256' })}.${b64({ userId: 'u1', role: 'tenant', iat: now - 2 * 86400, exp: now + 5 * 86400 })}.sig`
const FRESH_PASS = `${b64({ alg: 'HS256' })}.${b64({ userId: 'u1', role: 'tenant', iat: now - 60, exp: now + 7 * 86400 })}.sig`
const httpError = (status: number, error = 'refused') =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

function harness(answer: () => Promise<string>, start = OLD_PASS) {
  let stored: string | null = start
  const signOut = vi.fn(() => { stored = null })
  const storeToken = vi.fn((t: string) => { stored = t })
  const run = () => renewTenantSession({
    readToken: () => stored, requestRenewal: answer, storeToken, signOut,
  })
  return { run, signOut, storeToken, token: () => stored }
}

describe('renewTenantSession', () => {
  it('a lock answer keeps the pass: no sign-out, nothing stored, the same pass stays', async () => {
    const h = harness(() => Promise.reject(httpError(RENEWAL_LOCKED_STATUS,
      'Your account is temporarily locked after too many sign-in attempts. You are still signed in; your sign-in renews on its own once the lock ends.')))
    expect(await h.run()).toBe('kept_locked')
    expect(h.signOut).not.toHaveBeenCalled()
    expect(h.storeToken).not.toHaveBeenCalled()
    expect(h.token()).toBe(OLD_PASS)
  })

  it('after the lock ends, the next renewal goes through', async () => {
    let locked = true
    const h = harness(() => locked ? Promise.reject(httpError(423)) : Promise.resolve('NEW_PASS'))
    expect(await h.run()).toBe('kept_locked')
    locked = false
    expect(await h.run()).toBe('renewed')
    expect(h.token()).toBe('NEW_PASS')
    expect(h.signOut).not.toHaveBeenCalled()
  })

  it('a pass the server refuses (401) still signs out', async () => {
    const h = harness(() => Promise.reject(httpError(401, 'Your password was changed. Please sign in again.')))
    expect(await h.run()).toBe('signed_out')
    expect(h.signOut).toHaveBeenCalledTimes(1)
    expect(h.token()).toBeNull()
  })

  it('a pulled account (403) still signs out', async () => {
    const h = harness(() => Promise.reject(httpError(403)))
    expect(await h.run()).toBe('signed_out')
    expect(h.signOut).toHaveBeenCalledTimes(1)
  })

  it('a blip (no response, or the API restarting) keeps the pass', async () => {
    const offline = harness(() => Promise.reject(new Error('Network Error')))
    expect(await offline.run()).toBe('kept')
    expect(offline.token()).toBe(OLD_PASS)
    const restarting = harness(() => Promise.reject(httpError(502)))
    expect(await restarting.run()).toBe('kept')
    expect(restarting.signOut).not.toHaveBeenCalled()
  })

  it('renews and stores the new pass', async () => {
    const h = harness(() => Promise.resolve('NEW_PASS'))
    expect(await h.run()).toBe('renewed')
    expect(h.storeToken).toHaveBeenCalledWith('NEW_PASS')
  })

  it('a pass less than a day old is not renewed at all', async () => {
    const answer = vi.fn(() => Promise.resolve('NEW_PASS'))
    const h = harness(answer, FRESH_PASS)
    expect(await h.run()).toBe('not_due')
    expect(answer).not.toHaveBeenCalled()
  })

  it('a sign-out while the renewal was in flight wins: the new pass is not stored', async () => {
    let h: ReturnType<typeof harness>
    h = harness(async () => { h.signOut(); return 'NEW_PASS' })
    expect(await h.run()).toBe('superseded')
    expect(h.storeToken).not.toHaveBeenCalled()
    expect(h.token()).toBeNull()
  })
})

describe('renewalAnswerIsLock', () => {
  it('is the 423 answer only', () => {
    expect(renewalAnswerIsLock(httpError(423))).toBe(true)
    expect(renewalAnswerIsLock(httpError(401))).toBe(false)
    expect(renewalAnswerIsLock(new Error('Network Error'))).toBe(false)
    expect(renewalAnswerIsLock(undefined)).toBe(false)
  })
})
