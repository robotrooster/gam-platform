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

/**
 * router variable -> the source of the file that declares it, and of every
 * other route file that hangs routes on it (10/12: routes/booksLoansAssets.ts
 * registers the Vendors, Loans and Fixed assets routes on booksRouter).
 */
function sourceByRouter(): Record<string, string> {
  const out: Record<string, string> = {}
  const extra: Record<string, string[]> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    const own = new Set<string>()
    for (const m of src.matchAll(/export const (\w+Router)\s*[:=]/g)) { out[m[1]] = src; own.add(m[1]) }
    for (const r of new Set([...src.matchAll(/\b(\w+Router)\.(?:get|post|patch|put|delete)\(\s*'/g)].map(m => m[1]))) {
      if (!own.has(r)) (extra[r] ||= []).push(src)
    }
  }
  for (const [r, srcs] of Object.entries(extra)) if (out[r]) out[r] = [out[r], ...srcs].join('\n')
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

/**
 * 10/19 (review) — AND THE OTHER DIRECTION, WHICH IS WORSE.
 *
 * The check above walks declared name → route file. Nothing walked route
 * requirement → declared name, and that gap is not silent like a typo: it is a
 * permanent dead end. On 10/19 the work-trade route began refusing a pause that
 * does not say whether the space is still being used, and
 * update_work_trade_agreement — whose own description invites "pause Danny's
 * trade while he is away" — had no parameter that could carry the answer. Every
 * such request 400'd, the assistant had nothing to resolve it with, and the
 * trade stayed active after the landlord had been read the change and said yes.
 *
 * A route may of course demand a field for a sub-operation no action performs,
 * so this is not a sweep: it is the pairing between a refusal and the action
 * that can trigger it, asserted from BOTH ends so that rewording or removing
 * either side fails here rather than passing on a pairing that no longer exists.
 */
describe('a field a route refuses an action without is a field the action declares', () => {
  const WORK_TRADE = '/api/work-trade/:agreementId'

  it('pausing a work trade declares the space answer the route insists on', () => {
    const src = fileFor(WORK_TRADE)
    expect(src, 'no route file resolves for the work-trade agreement patch').toBeTruthy()
    // The refusal, as the route writes it. S628 parity is a claim about the
    // route's actual behavior, so it is read from the route.
    expect(src!, 'the route no longer refuses a pause without the space answer — is this pairing stale?')
      .toMatch(/pausingNow && spaceOccupiedWhilePaused === undefined/)

    const canPause = PORTAL_ACTIONS.filter(
      (a) => a.path === WORK_TRADE && /paused/.test(a.params.status?.description ?? ''))
    expect(canPause.length, 'no action can set a work trade to paused any more').toBeGreaterThan(0)

    for (const a of canPause) {
      expect(Object.keys(a.params),
        `${a.id} can pause a work trade, and the route refuses a pause without ` +
        'spaceOccupiedWhilePaused — so every pause it makes is a 400 the model has no ' +
        'declared parameter to satisfy.')
        .toContain('spaceOccupiedWhilePaused')
    }
  })
})
