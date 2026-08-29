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
 * Hidden rather than greyed, per the rule Nic set for the meter pickers — "I
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

/** Why units are missing from the list, phrased for the line underneath it. */
export function hiddenUnitReasons(all: ReadonlyArray<InvitableUnit>): string[] {
  const hidden = all.filter(u => !canInviteToUnit(u))
  const occupied = hidden.filter(u => u.tenantId).length
  const invited = hidden.filter(u => !u.tenantId && Number(u.pendingInviteCount || 0) > 0).length
  const ownerUse = hidden.filter(u => !u.tenantId && u.status === 'owner_use').length
  return [
    occupied && `${occupied} occupied`,
    invited && `${invited} already invited`,
    ownerUse && `${ownerUse} owner-occupied`,
  ].filter(Boolean) as string[]
}
