/**
 * NO EMAIL EVER SHIPS A localhost LINK.
 *
 * This is the third time. Nic, the first time:
 *
 *   "Lisa's email link is trying to go to localhost. You keep sending links to
 *    localhost when that's not what we're doing. You need to send links to the
 *    right place."
 *
 * lib/portalUrls was written that day to end it: one environment variable per
 * surface, and in production no localhost fallback at all — a missing variable
 * is a loud error, never a quiet dead link.
 *
 * It did not end it. On 10/21, eight more were found in this one file: six
 * functions whose `portalUrl` parameter DEFAULTED to a localhost address, and
 * two that read the env var with a localhost `||` fallback of their own. Every
 * caller of those six passed `undefined`, so every one of them had always sent
 * a dead button — and nine had already gone out, five of them "your application
 * has been approved" to real applicants.
 *
 * A default is easy to miss in review: the call site looks fine, because the
 * wrong value is written somewhere else entirely. So this does not trust
 * review. It reads the file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')

/**
 * The ONE file allowed to name a localhost address in a URL DEFAULT: it is the
 * thing that decides what a portal's address is, and its dev-host table is the
 * point. Plus index.ts, whose localhost entries are CORS origins, not links.
 */
const ALLOWED = new Set(['lib/portalUrls.ts', 'index.ts'])

/*
 * NOT guarded here, deliberately: the `process.env.X || 'http://localhost…'`
 * fallback, which about twenty call sites still use (auth, esign, pm,
 * properties, businessUsers, publicCustomerPortal and others). Those at least
 * READ the right variable, so with the environment set they send the right
 * link — which is why they have never been seen to break. They are a weaker
 * version of the same hazard (a missing variable becomes a quiet dead link
 * instead of a loud error) and are worth a sweep onto portalUrls one day, but
 * sweeping them is not this test's job and failing on them would say something
 * is broken that is not.
 */

function sourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const path = rel ? `${rel}/${name}` : name
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'test') continue
      out.push(...sourceFiles(full, path))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

/** A localhost address inside a string literal — not one inside a comment. */
function localhostLinks(src: string): string[] {
  return src.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => /['"`]https?:\/\/localhost/.test(line))
    .map(line => line.trim())
}

describe('every link an email sends goes somewhere real', () => {
  it('services/email.ts in particular carries no localhost address at all', () => {
    // Where all eight lived. Held to the stricter rule: not in a default, not
    // in an `||` fallback, not anywhere. Ask lib/portalUrls instead.
    const src = readFileSync(join(SRC, 'services/email.ts'), 'utf8')
    const inCode = src.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(line => /localhost:\d/.test(line))
    expect(inCode).toEqual([])
  })

  it('no function takes a portal address as a parameter with a hard-coded default', () => {
    // The exact shape that hid these for weeks: `portalUrl = 'http://localhost…'`
    // — a URL-ish name assigned a localhost literal outright, with no
    // environment read in front of it to make it right anywhere else.
    const offenders: string[] = []
    for (const path of sourceFiles(SRC)) {
      if (ALLOWED.has(path)) continue
      const src = readFileSync(join(SRC, path), 'utf8')
      for (const m of src.matchAll(/\b\w*[uU]rl\w*\s*=\s*['"`]https?:\/\/localhost/g)) {
        offenders.push(`${path}: ${src.slice(m.index!, m.index! + 70).split('\n')[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
