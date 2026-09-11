import { PERMISSION_CATALOG } from '@gam/shared'

/**
 * Case conversion utility — snake_case -> camelCase for outgoing API responses.
 * Used by the response middleware in index.ts to ensure the API wire format
 * is camelCase everywhere, while database column names stay snake_case.
 *
 * Recursive. Non-mutating. Handles:
 *   - null, undefined
 *   - primitives (pass through)
 *   - Date, Buffer (pass through, never recursed into)
 *   - arrays (recurse into each element)
 *   - plain objects (convert keys, recurse into values)
 *   - already-camelCase keys (pass through unchanged)
 */

function snakeToCamel(key: string): string {
  if (!key.includes('_')) return key
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

// A `permissions` value is a scope permission MAP, not a normal field object.
// Its keys are semantic identifiers and must survive verbatim — camelCasing
// 'pos.ring_sale' to 'pos.ringSale' silently breaks the frontend's check.
//
// S641: this used to test for a DOT, on the assumption that every catalog key
// has one and anything without is config (bookkeeper's 'access_level'). Two
// catalog keys have no dot — `take_payment` and `guest_access` — so both were
// being rewritten to camelCase on the wire while every `can('take_payment')`
// in the frontend kept asking for the underscore, and got undefined.
//
// It hid for as long as it did because the Record payment button was ungated:
// it rendered for everyone, so nobody could tell the permission never
// answered. The moment Nic's on-site manager was correctly gated, the button
// vanished for the one person who was supposed to have it.
//
// So the question is now the real one — IS THIS A CATALOG KEY? — answered from
// the catalog rather than from the shape of the string. A new key without a
// dot cannot reintroduce this.
const CATALOG_PERMISSION_KEYS: Set<string> = (() => {
  const keys = new Set<string>()
  for (const group of PERMISSION_CATALOG) {
    for (const section of group.sections ?? []) {
      for (const item of section.items ?? []) keys.add(item.key)
    }
  }
  return keys
})()

function camelCasePermissionsMap(perms: any): any {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return camelCaseKeys(perms)
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(perms)) {
    const verbatim = k.includes('.') || CATALOG_PERMISSION_KEYS.has(k)
    out[verbatim ? k : snakeToCamel(k)] = v
  }
  return out
}

export function camelCaseKeys<T = any>(input: any): T {
  if (input === null || input === undefined) return input
  if (typeof input !== 'object') return input
  if (input instanceof Date) return input as T
  if (Buffer.isBuffer(input)) return input as T
  if (Array.isArray(input)) {
    return input.map((item) => camelCaseKeys(item)) as any
  }
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(input)) {
    out[snakeToCamel(key)] = key === 'permissions' ? camelCasePermissionsMap(value) : camelCaseKeys(value)
  }
  return out as T
}
