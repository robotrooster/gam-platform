/**
 * S629 — which units can be invited into, in ONE place.
 *
 * The rule already existed in InviteTenantModal, built to Nic's S613
 * directive: "any pending invites should block things from showing up on this
 * list. It would only show up back on this list if there's a timeout at the
 * end of the acceptance flow." The new roster invite form on Tenant Onboarding
 * listed every unit instead, so the same mistake it prevents — offering one
 * space to two households — was reachable again from the other door.
 *
 * The three exclusions:
 *   occupied        — somebody lives there
 *   owner-occupied  — no lease, no rent, not for letting
 *   already invited — an invite is live, or accepted and mid-flow
 *
 * "Already invited" is computed server-side (units.ts, pending_invite_count):
 * an invite lives seven days, accepting clears the expiry, so a live invite
 * and an accepted-but-unfinished one both block, and only a lapsed one
 * releases the unit.
 *
 * Hidden rather than grayed, per the rule Nic set for the meter pickers — "I
 * don't want them grayed out because then I still have to scroll around
 * looking for just the odd one or two" — with a count underneath, so nothing
 * vanishes unexplained.
 */
export interface InvitableUnit {
  tenantId?: string | null
  status?: string | null
  pendingInviteCount?: number | string | null
}

export function canInviteToUnit(u: InvitableUnit): boolean {
  return !u.tenantId
    && u.status !== 'owner_use'
    && !(Number(u.pendingInviteCount || 0) > 0)
}

/**
 * 10/26 (Nic) — AN OCCUPIED SPOT CAN BE TAKEN OVER.
 *
 *   "When you approve the lease and then go to invite them to the unit, that
 *    unit list only populates with vacancies. It doesn't populate with the
 *    ability to click on one that's occupied and then initiate that takeover
 *    process. So we need to do that."
 *
 * Country Acres MH 28 is the case the succession subsystem was built for
 * (services/spotSuccession, 10/24): Susie McCoy is leaving and the Bowmans'
 * daughter is taking the spot from November 1. The machinery fires off the
 * REPLACEMENT'S signature — but a lease has to be drafted for that spot first,
 * and that could not happen because the invite list showed only vacancies.
 *
 * WHY THIS IS NOT JUST UN-HIDING THEM. S613's reason for hiding occupied units
 * was to stop one space being offered to two households by accident, which is a
 * real thing that happened when thirty invites went out in a sitting. So a
 * takeover is its OWN choice, shown apart and named as a takeover, and an
 * ordinary invite still cannot land on an occupied unit. The "already invited"
 * exclusion applies here as hard as it does there: a spot with an incoming
 * lease already pending is NOT offered for takeover either, or two replacements
 * get promised the same spot — exactly the bug, one layer up.
 *
 * An owner-occupied unit is still never offered: there is no tenancy to take
 * over, and the owner is not a person being replaced.
 */
export function canTakeOverUnit(u: InvitableUnit): boolean {
  return !!u.tenantId
    && u.status !== 'owner_use'
    && !(Number(u.pendingInviteCount || 0) > 0)
}

/** Why units are missing from the list, phrased for the line underneath it. */
export function hiddenUnitReasons(all: ReadonlyArray<InvitableUnit>): string[] {
  const hidden = all.filter(u => !canInviteToUnit(u))
  // 10/26: an occupied unit that can be TAKEN OVER is offered, not hidden, so
  // it is not counted as missing. Only one whose spot is already promised to an
  // incoming lease is.
  const occupied = hidden.filter(u => u.tenantId && !canTakeOverUnit(u)).length
  const invited = hidden.filter(u => !u.tenantId && Number(u.pendingInviteCount || 0) > 0).length
  const ownerUse = hidden.filter(u => !u.tenantId && u.status === 'owner_use').length
  return [
    occupied && `${occupied} occupied`,
    invited && `${invited} already invited`,
    ownerUse && `${ownerUse} owner-occupied`,
  ].filter(Boolean) as string[]
}
