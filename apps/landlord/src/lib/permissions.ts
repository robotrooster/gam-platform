import { useAuth } from '../context/AuthContext'

// Owner roles hold every permission implicitly — they are the landlord (or
// platform staff acting for them). Staff hold exactly the keys in their scope's
// permissions map. Keys are the ones defined in @gam/shared PERMISSION_CATALOG.
const OWNER_ROLES = ['landlord', 'admin', 'super_admin']

/**
 * S641 — the API camelizes every response, and permission keys are DATA inside
 * one.
 *
 * `take_payment` therefore reaches this browser as `takePayment`, while every
 * other key survives untouched because they all contain a dot
 * (`balances.view`, `pos.tab.register`) and the converter leaves those alone.
 * So `can('take_payment')` was false for a front-desk user who genuinely held
 * it, and gating the Record payment button on it made the button vanish for the
 * one person who needed it. It had been ungated before, which is the only
 * reason nobody had hit this.
 *
 * Accept both spellings rather than renaming the key: a rename is a migration
 * plus every call site, and the next dotless key somebody adds would walk into
 * exactly the same trap. Checked at the gate, once.
 */
function camelize(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())
}

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
  const can = (key: string): boolean => {
    if (isOwner) return true
    const perms = (user?.permissions as any) || {}
    // The key as written, and the shape the wire gives it back in.
    return perms[key] === true || perms[camelize(key)] === true
  }
  return { can, isOwner }
}
