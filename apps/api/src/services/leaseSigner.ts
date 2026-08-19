// S605 (Nic): who signs a lease on the landlord's behalf.
//
// "Have it go to the landlord when there's no on-site manager selected, and have
// it go to the on-site manager if permission is checked. Limit that permission
// to only one user per property. And if that person gets fired or removed from
// permission, then it defaults back to the landlord or the owner."
//
// Every e-sign path used to resolve `landlords.user_id` — the account owner,
// unconditionally — so an entitled on-site manager could open the signing queue
// but never be the named signer.
//
// The designation lives in ONE column on the property, because the rule is one
// signer per property. The column records INTENT; this resolver is the
// AUTHORITY. A manager who has been removed from the property, had leases.sign
// revoked, or been deactivated still has a row pointing at them — no constraint
// can catch that, so entitlement is re-checked on every resolve and the owner
// takes over silently. Firing someone should not require remembering to clear a
// setting before leases stop being addressed to them.
import { queryOne } from '../db'

export type ResolvedSigner = {
  userId: string
  name: string
  email: string
  phone: string | null
  /** true when this is the account owner rather than a designated manager. */
  isOwner: boolean
}

/**
 * Resolve the landlord-side signer for a property.
 *
 * Falls back to the entity's account owner whenever there is no designation, or
 * the designated user is no longer entitled to sign for this property. Returns
 * null only if the landlord entity itself has no user — a data-integrity
 * problem, not an ordinary one.
 */
export async function resolveLeaseSigner(
  landlordId: string,
  propertyId: string | null,
): Promise<ResolvedSigner | null> {
  const owner = await queryOne<any>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

  const shape = (r: any, isOwner: boolean): ResolvedSigner => ({
    userId: r.id,
    name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
    email: r.email,
    phone: r.phone ?? null,
    isOwner,
  })

  if (!propertyId) return owner ? shape(owner, true) : null

  // Designated signer, re-verified: still scoped to THIS property (or all
  // properties for the entity) and still holding leases.sign.
  const designated = await queryOne<any>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone
       FROM properties p
       JOIN users u ON u.id = p.lease_signer_user_id
       JOIN onsite_manager_scopes s
         ON s.user_id = u.id
        AND s.landlord_id = p.landlord_id
        AND (s.all_properties = TRUE OR p.id = ANY(s.property_ids))
      WHERE p.id = $1
        AND p.lease_signer_user_id IS NOT NULL
        AND COALESCE((s.permissions ->> 'leases.sign')::boolean, FALSE) = TRUE
      LIMIT 1`, [propertyId])

  if (designated) return shape(designated, false)
  return owner ? shape(owner, true) : null
}
