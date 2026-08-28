/**
 * S626 — every allowlisted action must point at a route that exists.
 *
 * The dispatcher calls real endpoints, and the unit tests mock the transport —
 * so a typo in a path, or a route that gets renamed later, would sail through
 * every other test and only surface as a 404 in front of a customer, most
 * likely reported by the agent as "that didn't work" with no idea why.
 *
 * This resolves each manifest entry against the router mounts in index.ts AND
 * the paths actually declared in the route file, method included.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { PORTAL_ACTIONS } from './portalActions'

const API = join(__dirname, '../../')
const ROUTES = join(API, 'routes')

/** '/api/units' -> the router variable mounted there. */
function mounts(): Record<string, string> {
  const src = readFileSync(join(API, 'index.ts'), 'utf8')
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/app\.use\(\s*'(\/api\/[a-z0-9-]+)'\s*,\s*([\s\S]{0,140}?)\)/g)) {
    const router = (m[2].match(/(\w+Router)/) || [])[1]
    if (router) out[m[1]] = router
  }
  return out
}

/** Every (METHOD, path) a router file declares. */
function declared(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    for (const m of src.matchAll(/(\w+Router)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)) {
      (out[m[1]] ||= new Set()).add(`${m[2].toUpperCase()} ${m[3] || '/'}`)
    }
  }
  return out
}

/** ':unitId' and ':id' are the same shape to a router. */
const normalise = (p: string) => (p.replace(/:[A-Za-z0-9_]+/g, ':x') || '/')

describe('every allowlisted action resolves to a real route', () => {
  const MOUNTS = mounts()
  const DECLARED = declared()

  it('index.ts was parsed — the mount table is not empty', () => {
    expect(Object.keys(MOUNTS).length).toBeGreaterThan(40)
  })

  it.each(PORTAL_ACTIONS.map((a) => [a.id, a.method, a.path] as const))(
    '%s → %s %s', (_id, method, path) => {
      const base = '/api/' + path.split('/')[2]
      const router = MOUNTS[base]
      expect(router, `nothing is mounted at ${base}`).toBeTruthy()

      const sub = path.slice(base.length) || '/'
      const want = `${method} ${normalise(sub)}`
      const have = [...(DECLARED[router!] ?? new Set<string>())].map((d) => {
        const [m, ...rest] = d.split(' ')
        return `${m} ${normalise(rest.join(' '))}`
      })
      expect(have, `${router} declares no ${want}`).toContain(want)
    })

  it('path params in the manifest match the ones in the path', () => {
    for (const a of PORTAL_ACTIONS) {
      const inPath = [...a.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort()
      expect((a.pathParams ?? []).slice().sort(), a.id).toEqual(inPath)
      // And each one must be a declared parameter, or the model cannot supply it.
      for (const p of inPath) expect(Object.keys(a.params), `${a.id}.${p}`).toContain(p)
    }
  })

  it('every required param is a declared param', () => {
    for (const a of PORTAL_ACTIONS) {
      for (const r of a.required ?? []) {
        expect(Object.keys(a.params), `${a.id} requires undeclared ${r}`).toContain(r)
      }
    }
  })
})
