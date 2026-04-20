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
    out[snakeToCamel(key)] = camelCaseKeys(value)
  }
  return out as T
}
