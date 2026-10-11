/**
 * S655: what the Invite Tenant result says about each person, from what
 * actually reached them.
 *
 * The invite routes report, per person, `notified`: 'email' (an email to set
 * up their account), 'notice' (a notice in the GAM account they already use),
 * or null (nothing went: a lease drafted, which emails nobody until the
 * landlord signs, or the send failed). The screen used to read every person
 * who was not emailed as "already has a GAM account — they were told there",
 * including a new person whose email failed.
 */

export type Reached = 'email' | 'notice' | null

export interface InvitePersonOutcome {
  email: string
  alreadyOnPlatform: boolean
  notified: Reached
}

/** The route's per-person `notified`, read defensively. */
export function reachedBy(d: any): Reached {
  return d?.notified === 'email' || d?.notified === 'notice' ? d.notified : null
}

/**
 * A household invited to a unit whose lease could NOT draft: the usual invite
 * was tried instead. Says who was contacted, and for anyone who was not, what
 * to press.
 */
export function unitInviteFallbackLine(x: InvitePersonOutcome): string {
  if (x.notified === 'email') return `${x.email} was sent an email to set up their account.`
  if (x.notified === 'notice') return `${x.email} already has a GAM account — they were told there.`
  if (x.alreadyOnPlatform) {
    return `${x.email} already has a GAM account, but the notice to them did not go through. ` +
      'They get one email once the lease is drafted and you sign it.'
  }
  return `${x.email} has not been contacted yet — their email did not go out. ` +
    'Press Re-send invite next to them on the Front Desk.'
}

/** An applicant invited to a PROPERTY (they screen first). */
export function screeningInviteLine(x: InvitePersonOutcome): string {
  if (x.notified === 'email') return `${x.email} will get an email to set up their account and start their background check.`
  if (x.notified === 'notice') return `${x.email} already has a GAM account — your invite is waiting for them there.`
  if (x.alreadyOnPlatform) {
    return `${x.email} already has a GAM account, but the notice to them did not go through. Invite them again to send it.`
  }
  return `${x.email} has not been contacted yet — their email did not go out. ` +
    'Press Re-send invite next to them on the Front Desk.'
}

/** The result's heading. */
export function inviteResultTitle(r: { screened: boolean; drafted: boolean; draftBlocked: string[]; sent: InvitePersonOutcome[] }): string {
  if (r.screened) {
    if (r.sent.some(x => x.notified === 'email')) return 'Invite Sent'
    if (r.sent.length > 0 && r.sent.every(x => x.notified === 'notice')) return 'Already on GAM'
    return 'Not sent yet'
  }
  if (r.drafted) return r.draftBlocked.length > 0 ? 'Some leases drafted' : 'Lease drafted'
  return 'Lease not drafted yet'
}
