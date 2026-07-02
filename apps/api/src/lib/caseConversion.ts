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
// Its keys are semantic identifiers: catalog permission keys are DOTTED
// (e.g. 'pos.ring_sale') and must survive verbatim — camelCasing them to
// 'pos.ringSale' silently breaks every underscore permission on the frontend.
// Non-dotted keys inside it (e.g. bookkeeper's 'access_level') are config and
// still camelCase. Values are primitives (boolean / string), never recursed.
function camelCasePermissionsMap(perms: any): any {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return camelCaseKeys(perms)
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(perms)) {
    out[k.includes('.') ? k : snakeToCamel(k)] = v
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
