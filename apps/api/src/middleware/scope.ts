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

export function canAccessLandlordResource(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && user.profileId === landlordId) return true
  if (isTeamRole(user.role) && user.landlordId === landlordId) return true
  return false
}

export function canViewLandlordFinances(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && user.profileId === landlordId) return true
  return false
}

export function canManageLandlordResource(
  user: AuthPayload | undefined,
  landlordId: string | null | undefined,
  allowedTeamRoles?: readonly string[]
): boolean {
  if (!user || !landlordId) return false
  if (user.role === 'admin' || user.role === 'super_admin') return true
  if (user.role === 'landlord' && user.profileId === landlordId) return true
  const allowed = allowedTeamRoles ?? TEAM_ROLES
  if (allowed.includes(user.role) && user.landlordId === landlordId) return true
  return false
}
