/**
 * S628 — A MISNAMED PARAMETER IS SILENT, AND THAT IS THE WORST KIND.
 *
 * 323 of the API's zod objects are plain `z.object`; only 19 are `.strict()`.
 * Zod strips unknown keys rather than rejecting them. So if a manifest entry
 * declares `unitID` where the route reads `unitId`, nothing errors: the field is
 * dropped, the endpoint returns 200 on whatever is left, and the agent tells a
 * landlord their rent change is done while nothing changed at all.
 *
 * Every other guard we have would pass that. portalActionPaths.test.ts checks
 * the ADDRESS. The type checker never sees the route. The suite mocks the
 * transport. A typo here survives all of it and only surfaces as "I changed it
 * and it didn't take" from a customer, weeks later, with no error anywhere.
 *
 * So: every parameter name a manifest entry declares must actually appear in
 * the route file that serves it. That is a loose check on purpose — a name may
 * be read in a handler, named in a zod const above it, or destructured into a
 * service call — but a name that appears NOWHERE in the file it is being sent
 * to cannot possibly be read, and that is the failure worth catching.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { PORTAL_ACTIONS } from './portalActions'

const API = join(__dirname, '../../')
const ROUTES = join(API, 'routes')

/** router variable -> the source of the file that declares it. */
function sourceByRouter(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    for (const m of src.matchAll(/export const (\w+Router)\s*[:=]/g)) out[m[1]] = src
  }
  return out
}

/** '/api/units' -> router variable, longest mount wins. */
function mounts(): Record<string, string> {
  const src = readFileSync(join(API, 'index.ts'), 'utf8')
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/app\.use\(\s*'(\/api\/[a-z0-9/-]+)'\s*,\s*([\s\S]{0,140}?)\)/g)) {
    const r = (m[2].match(/(\w+Router)/) || [])[1]
    if (r) out[m[1]] = r
  }
  return out
}

const SRC = sourceByRouter()
const MOUNTS = mounts()

function fileFor(path: string): string | null {
  let best: string | null = null
  for (const base of Object.keys(MOUNTS)) {
    if (path === base || path.startsWith(base + '/')) {
      if (!best || base.length > best.length) best = base
    }
  }
  return best ? SRC[MOUNTS[best]] ?? null : null
}

describe('every declared parameter is a name the route actually reads', () => {
  it.each(PORTAL_ACTIONS.map((a) => [a.id, a] as const))('%s', (_id, a) => {
    const src = fileFor(a.path)
    expect(src, `no route file resolves for ${a.path}`).toBeTruthy()

    // Path params are substituted into the URL, not the body — the path test
    // already proves those line up with the route's own :segments.
    const bodyParams = Object.keys(a.params).filter((p) => !(a.pathParams ?? []).includes(p))

    const missing = bodyParams.filter((p) => {
      // Word-boundary match so `note` does not satisfy itself via `notes`.
      return !new RegExp(`\\b${p}\\b`).test(src!)
    })

    expect(missing, missing.length
      ? `\n${a.id} sends ${missing.join(', ')} — no such name appears in the route file.\n` +
        'zod strips unknown keys, so this would NOT error: the field is dropped, the\n' +
        'call returns 200, and the agent reports it as done.\n'
      : '').toEqual([])
  })
})
