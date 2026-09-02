// apps/api/src/middleware/scope.ts
//
// Access scope helpers — single source of truth for "can this user
// access this landlord's resources?" checks.
//
// Three helpers, three access tiers:
//
//   canAccessLandlordResource — operational read/write.
//     Front-counter staff (property_manager, onsite_manager, maintenance)
//     get access. Used for schedule, availability, maintenance
//     coordination, unpaid invoices for at-counter payment, etc.
//
//   canViewLandlordFinances — financial reads only.
//     Admin and the landlord themselves. NO team members. Used for
//     /economics, reports, P&L. (16a will add owner_user_id read access
//     for owners on properties they own.)
//
//   canManageLandlordResource — write actions on resources.
//     Admin and the landlord themselves. Optionally specific team roles
//     allowed by caller (e.g. PM can edit units, maintenance cannot).
//     Defaults to all team roles if allowedTeamRoles not specified.
//
// All three return false for tenants and for users with no matching
// landlord scope.
//
// Bookkeeper access is books-only and handled separately via
// landlordScope() in routes/books.ts; bookkeeper does not match here.

import type { AuthPayload } from './auth'

const TEAM_ROLES = ['property_manager', 'onsite_manager', 'maintenance'] as const

function isTeamRole(role: string): boolean {
  return (TEAM_ROLES as readonly string[]).includes(role)
}

// S633: a landlord matches an entity when it is one of the entities their
// ACCOUNT owns. `landlordIds` is that whole set, refreshed from the database on
// every request (see requireAuth), so it is current rather than frozen at login.
//
// This used to also accept `user.profileId === landlordId`. profileId named one
// arbitrary entity — the session's "active" company — and an account is not an
// entity, so that comparison is gone. It is not a loosening either way: the same
// membership facts decide the answer, they are just no longer read through a
// piece of session state that could name the wrong company.
function landlordOwns(user: AuthPayload, landlordId: string): boolean {
  return (user.landlordIds ?? []).includes(landlordId)
}

export function canAccessLandlordResource(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && landlordOwns(user, landlordId)) return true
  if (isTeamRole(user.role) && user.landlordId === landlordId) return true
  return false
}

export function canViewLandlordFinances(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && landlordOwns(user, landlordId)) return true
  return false
}

export function canManageLandlordResource(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined,
  allowedTeamRoles?: readonly string[]
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && landlordOwns(user, landlordId)) return true
  const allowed = allowedTeamRoles ?? TEAM_ROLES
  if (allowed.includes(user.role) && user.landlordId === landlordId) return true
  return false
}
