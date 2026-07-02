import { useAuth } from '../context/AuthContext'

// Owner roles hold every permission implicitly — they are the landlord (or
// platform staff acting for them). Staff hold exactly the keys in their scope's
// permissions map. Keys are the ones defined in @gam/shared PERMISSION_CATALOG.
const OWNER_ROLES = ['landlord', 'admin', 'super_admin']

/**
 * Central permission gate for landlord-portal surfaces. Usage:
 *   const { can, isOwner } = usePerms()
 *   {can('properties.create') && <button>Add property</button>}
 *   const visibleTabs = TABS.filter(t => can(t.perm))
 *
 * `can(key)` is TRUE for owners (always) and for staff who hold that key.
 * This is UI gating; action routes are additionally gated server-side.
 */
export function usePerms() {
  const { user } = useAuth()
  const isOwner = !!user && OWNER_ROLES.includes(user.role)
  const can = (key: string): boolean => isOwner || (user?.permissions as any)?.[key] === true
  return { can, isOwner }
}
