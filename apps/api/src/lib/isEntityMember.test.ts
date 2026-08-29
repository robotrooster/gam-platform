/**
 * S629 — the stale-token bug that cost a real landlord his evening.
 *
 * He signed up Aug 24, created "TruBlu Management LLC" Aug 28, and could not
 * save a property under it. `landlordIds` rides in the JWT, minted at login,
 * so his four-day-old token listed only the blank entity signup had given him.
 * The Add Property picker reads entities from the DATABASE and offered the new
 * LLC; the route checked the TOKEN and refused it. "You are not a member of
 * that entity" — about an entity he had created himself, an hour earlier.
 *
 * The ordering is the whole point: the token is the fast path, and the DB is
 * consulted ONLY when the token says no. That cannot loosen the check — a
 * membership row is required either way — it can only stop a stale token from
 * denying a true membership.
 */
import { describe, it, expect, vi } from 'vitest'
import { isEntityMember } from './landlordScope'
import type { AuthPayload } from '../middleware/auth'

const user = (over: Partial<AuthPayload> = {}) => ({
  userId: 'u1', role: 'landlord', profileId: 'blank-entity',
  landlordIds: ['blank-entity'], ...over,
} as AuthPayload)

describe('isEntityMember', () => {
  it('says yes from the token without touching the database', async () => {
    const q = vi.fn()
    expect(await isEntityMember(user(), 'blank-entity', q as any)).toBe(true)
    expect(q).not.toHaveBeenCalled()
  })

  it('falls back to the database when the token is stale — the measured case', async () => {
    // TruBlu was created after this token was minted.
    const q = vi.fn().mockResolvedValue([{ one: 1 }])
    expect(await isEntityMember(user(), 'trublu', q as any)).toBe(true)
    expect(q).toHaveBeenCalledWith(expect.stringContaining('landlord_members'), ['u1', 'trublu'])
  })

  it('still refuses an entity the user is genuinely not a member of', async () => {
    // The check must not be loosened: somebody else's LLC stays closed.
    const q = vi.fn().mockResolvedValue([])
    expect(await isEntityMember(user(), 'someone-elses-llc', q as any)).toBe(false)
  })

  it('scopes the lookup to the calling user, never the entity alone', async () => {
    const q = vi.fn().mockResolvedValue([])
    await isEntityMember(user({ userId: 'u2' }), 'trublu', q as any)
    expect(q.mock.calls[0][1]).toEqual(['u2', 'trublu'])
  })
})
