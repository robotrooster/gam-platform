// Resolve which landlord a request operates on. S126 pattern: owner roles
// (landlord) carry landlord.id in profileId; team workers carry it
// separately as a landlordId JWT claim (S82). Admins return null — they
// have no implicit landlord scope, so any admin route hitting a
// landlord-scoped endpoint must pass an explicit landlordId via query.
export function resolveLandlordIdForUser(user: any): string | null {
  if (!user) return null
  if (user.role === 'landlord') return user.profileId ?? null
  if (['property_manager','onsite_manager','maintenance','bookkeeper'].includes(user.role)) {
    return user.landlordId ?? null
  }
  return null
}
