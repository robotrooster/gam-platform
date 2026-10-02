/**
 * S655 review — the Invite Tenant result says who was actually contacted.
 *
 * When a household's lease could not draft, the usual invite was tried
 * instead, and the screen described everyone who was not emailed as "already
 * has a GAM account — they were told there". A new person whose email failed
 * was told about too, and the landlord had no idea they still needed one.
 */
import { describe, it, expect } from 'vitest'
import { inviteResultTitle, reachedBy, screeningInviteLine, unitInviteFallbackLine } from './inviteOutcome'

const NEW = 'new@test.dev'
const ON_GAM = 'onGam@test.dev'

describe('a household whose lease could not draft', () => {
  it('says an email went only when it did', () => {
    expect(unitInviteFallbackLine({ email: NEW, alreadyOnPlatform: false, notified: 'email' }))
      .toBe(`${NEW} was sent an email to set up their account.`)
  })

  it('says "told there" only for someone with a GAM account whose notice went', () => {
    expect(unitInviteFallbackLine({ email: ON_GAM, alreadyOnPlatform: true, notified: 'notice' }))
      .toBe(`${ON_GAM} already has a GAM account — they were told there.`)
  })

  it('tells the landlord a new person was not contacted, and what to press', () => {
    const line = unitInviteFallbackLine({ email: NEW, alreadyOnPlatform: false, notified: null })
    expect(line).toMatch(/has not been contacted yet/)
    expect(line).toMatch(/Re-send invite next to them on the Front Desk/)
    expect(line).not.toMatch(/told there|already has a GAM account/)
  })

  it('does not claim someone on GAM was told when their notice failed', () => {
    const line = unitInviteFallbackLine({ email: ON_GAM, alreadyOnPlatform: true, notified: null })
    expect(line).not.toMatch(/told there/)
    expect(line).toMatch(/did not go through/)
    expect(line).toMatch(/one email once the lease is drafted and you sign it/)
  })
})

describe('an applicant invited to screen', () => {
  it('promises the email only when it went', () => {
    expect(screeningInviteLine({ email: NEW, alreadyOnPlatform: false, notified: 'email' }))
      .toMatch(/will get an email to set up their account and start their background check/)
    const failed = screeningInviteLine({ email: NEW, alreadyOnPlatform: false, notified: null })
    expect(failed).toMatch(/has not been contacted yet/)
    expect(failed).not.toMatch(/will get an email|already has a GAM account/)
  })

  it('says the invite waits in their account only when the notice went', () => {
    expect(screeningInviteLine({ email: ON_GAM, alreadyOnPlatform: true, notified: 'notice' }))
      .toMatch(/already has a GAM account — your invite is waiting for them there/)
    expect(screeningInviteLine({ email: ON_GAM, alreadyOnPlatform: true, notified: null }))
      .toMatch(/did not go through\. Invite them again/)
  })
})

describe('the result heading', () => {
  const person = (notified: 'email' | 'notice' | null, alreadyOnPlatform = false) => ({ email: NEW, alreadyOnPlatform, notified })

  it('reads as not sent when no screening invite went', () => {
    expect(inviteResultTitle({ screened: true, drafted: false, draftBlocked: [], sent: [person(null)] })).toBe('Not sent yet')
    expect(inviteResultTitle({ screened: true, drafted: false, draftBlocked: [], sent: [person('email')] })).toBe('Invite Sent')
    expect(inviteResultTitle({ screened: true, drafted: false, draftBlocked: [], sent: [person('notice', true)] })).toBe('Already on GAM')
  })

  it('says when some leases drafted and others did not', () => {
    expect(inviteResultTitle({ screened: false, drafted: true, draftBlocked: [], sent: [] })).toBe('Lease drafted')
    expect(inviteResultTitle({ screened: false, drafted: true, draftBlocked: ['x'], sent: [] })).toBe('Some leases drafted')
    expect(inviteResultTitle({ screened: false, drafted: false, draftBlocked: ['x'], sent: [] })).toBe('Lease not drafted yet')
  })
})

describe("reading the route's notified", () => {
  it('keeps email and notice, and treats anything else as nothing reached them', () => {
    expect(reachedBy({ notified: 'email' })).toBe('email')
    expect(reachedBy({ notified: 'notice' })).toBe('notice')
    expect(reachedBy({ notified: null })).toBeNull()
    expect(reachedBy({ inviteSent: true })).toBeNull()
    expect(reachedBy(undefined)).toBeNull()
  })
})
