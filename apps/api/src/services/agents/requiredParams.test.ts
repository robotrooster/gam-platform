/**
 * S628 — A ROUTE THAT REQUIRES SIXTEEN FIELDS AND A TOOL THAT DECLARES EIGHT.
 *
 * paramNames.test.ts catches a name the route never reads — the SILENT failure.
 * This catches the opposite and louder one: a manifest entry that omits a field
 * the route's zod schema demands. `add_employee` did exactly that. It declared
 * eight params where books_employees needs sixteen, so every single call would
 * have 400'd and the agent would have relayed "the system said no" forever
 * without ever being able to say what was missing.
 *
 * Loud is not the same as caught. Nothing in the suite calls these endpoints —
 * the dispatcher's transport is mocked everywhere — so a permanently broken
 * action looks identical to a working one until somebody tries it in front of a
 * customer.
 *
 * HOW IT READS THE SCHEMA. Zod is runtime, so this parses the source instead:
 * find the schema the handler passes req.body to, take its top-level keys, and
 * treat a key as REQUIRED unless it carries .optional() / .nullish() /
 * .nullable() / .default() on its own line. That is approximate by nature, so
 * where it cannot find a schema it says nothing rather than guessing — the aim
 * is zero false alarms, because a noisy guard gets muted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { PORTAL_ACTIONS } from './portalActions'

const API = join(__dirname, '../../')
const ROUTES = join(API, 'routes')

function routeFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    for (const m of src.matchAll(/export const (\w+Router)\s*[:=]/g)) out[m[1]] = src
  }
  return out
}
function mounts(): Record<string, string> {
  const src = readFileSync(join(API, 'index.ts'), 'utf8')
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/app\.use\(\s*'(\/api\/[a-z0-9/-]+)'\s*,\s*([\s\S]{0,140}?)\)/g)) {
    const r = (m[2].match(/(\w+Router)/) || [])[1]
    if (r) out[m[1]] = r
  }
  return out
}
const FILES = routeFiles()
const MOUNTS = mounts()

function fileFor(path: string): string | null {
  let best: string | null = null
  for (const b of Object.keys(MOUNTS)) {
    if (path === b || path.startsWith(b + '/')) if (!best || b.length > best.length) best = b
  }
  return best ? FILES[MOUNTS[best]] ?? null : null
}

/** The handler body for one METHOD + declared sub-path, up to the next route. */
function handlerFor(src: string, method: string, sub: string): string | null {
  const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\w+Router\\.${method.toLowerCase()}\\(\\s*'${esc}'`, 'g')
  const m = re.exec(src)
  if (!m) return null
  const rest = src.slice(m.index)
  const next = rest.slice(1).search(/\n\w+Router\.(get|post|patch|put|delete)\(/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** Top-level keys of a `z.object({...})` body, and whether each is required. */
function keysOf(objSrc: string): { name: string; required: boolean }[] {
  const out: { name: string; required: boolean }[] = []
  let depth = 0
  for (const raw of objSrc.split('\n')) {
    const line = raw.trim()
    // Only depth-1 lines are top-level keys of the object.
    const m = depth === 1 ? line.match(/^(\w+)\s*:/) : null
    if (m) {
      const optional = /\.(optional|nullish|nullable|default)\s*\(/.test(line)
      out.push({ name: m[1], required: !optional })
    }
    depth += (raw.match(/[({[]/g) || []).length - (raw.match(/[)}\]]/g) || []).length
  }
  return out
}

/**
 * Routes that do NOT use zod destructure req.body and enforce with explicit
 * throws — `const { a, b } = req.body` then `if (!a || !b) throw AppError(400)`.
 * That is most of them: the zod path covered only 37 of 207 actions, and the
 * one real bug found so far (add_employee) happened to sit inside it. Reading
 * the other pattern is where the rest would hide.
 */
function requiredFromThrows(handler: string): string[] | null {
  const destructure = handler.match(/const\s*\{([^}]+)\}\s*=\s*req\.body/)
  if (!destructure) return null
  // ONLY names taken off req.body count. The first pass flagged `ok`, `tmpl`,
  // `owned`, `s`, `t` — every one a local holding a database lookup, guarded by
  // its own `if (!ok) throw AppError(400)`. Those are ownership checks on ids
  // the tool already sends, not fields it is failing to supply, and demanding
  // them would have sent me editing the manifest to add nonsense params.
  const fromBody = new Set(
    destructure[1].split(',')
      .map((x) => x.split(/[:=]/)[0].trim())
      .filter(Boolean))
  const out = new Set<string>()
  // if (!a || !b || !c) throw new AppError(400, ...)     — the common shape
  for (const m of handler.matchAll(
    /if\s*\(([^)]*?)\)\s*\{?\s*(?:throw new AppError\(\s*400|return res\.status\(400)/g)) {
    const cond = m[1]
    // Only a plain negation names a REQUIRED field. `if (x && !y)` and
    // `if (v != null && bad(v))` are validity checks on something optional,
    // and counting those would demand fields the route is happy without.
    if (/&&/.test(cond)) continue
    for (const neg of cond.matchAll(/!\s*([A-Za-z_$][\w$]*)/g)) {
      if (fromBody.has(neg[1])) out.add(neg[1])
    }
    for (const und of cond.matchAll(/([A-Za-z_$][\w$]*)\s*===?\s*undefined/g)) {
      if (fromBody.has(und[1])) out.add(und[1])
    }
  }
  return [...out]
}

/** The schema this handler validates req.body with, if it can be found. */
function bodySchema(src: string, handler: string): string | null {
  // (a) inline:  const body = z.object({ ... }).parse(req.body)
  const inline = handler.match(/z\.object\(\{[\s\S]*?\}\)[\s\S]{0,80}?\.parse\(\s*req\.body/)
  if (inline) return inline[0]
  // (b) named:   const body = someSchema.parse(req.body)  →  const someSchema = z.object({...})
  const named = handler.match(/(\w+)\s*\.parse\(\s*req\.body/)
  if (named) {
    const decl = src.match(new RegExp(`const ${named[1]}\\s*=\\s*z\\.object\\(\\{[\\s\\S]*?\\n\\}\\)`))
    if (decl) return decl[0]
  }
  return null
}

/** How many actions this test could actually read a schema for. */
let examined = 0

describe('every field a route requires is a field the agent can supply', () => {
  it.each(PORTAL_ACTIONS.map((a) => [a.id, a] as const))('%s', (_id, a) => {
    const src = fileFor(a.path)
    if (!src) return
    const base = Object.keys(MOUNTS).filter((b) => a.path === b || a.path.startsWith(b + '/'))
      .sort((x, y) => y.length - x.length)[0]
    const handler = handlerFor(src, a.method, a.path.slice(base.length) || '/')
    if (!handler) return                       // path test owns address errors
    const schema = bodySchema(src, handler)
    const required = schema
      ? keysOf(schema).filter((k) => k.required).map((k) => k.name)
      : requiredFromThrows(handler)
    if (!required) return                      // neither pattern — say nothing
    examined++

    const declared = new Set(Object.keys(a.params))
    const missing = required
      .filter((n) => !declared.has(n) && !(a.pathParams ?? []).includes(n))

    expect(missing, missing.length
      ? `\n${a.id} → ${a.method} ${a.path} requires ${missing.join(', ')}, which the tool does not ` +
        'declare.\nEvery call would be rejected, and the agent could never say what was missing.\n'
      : '').toEqual([])
  })

  /**
   * A GUARD THAT EXAMINES NOTHING PASSES EVERYTHING, so the reach is asserted
   * alongside the result. The first version of this suite read only the zod
   * path and reported "207 passed" while having actually looked at 37 — an 18%
   * check wearing a clean bill of health.
   *
   * WHAT 61 COVERS AND WHAT IT DOES NOT. It is every action whose route either
   * validates with a `z.object` this can parse, or destructures req.body and
   * throws a 400 on a missing field. The remaining ~146 mostly accept whatever
   * they are given and fail later in SQL, or guard in a shape not parsed here —
   * for those, nothing is claimed. This is a floor on how much is verified, not
   * a statement that the rest is fine.
   */
  it('actually read a schema for a meaningful share of the manifest', () => {
    console.log(`  [requiredParams] read required fields for ${examined} of ${PORTAL_ACTIONS.length} actions`)
    expect(examined).toBeGreaterThanOrEqual(55)
  })
})
