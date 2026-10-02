// S570 (Nic): the POS register screen is intentionally shipped in TWO apps —
// the landlord portal's /pos tab (apps/landlord) and the standalone POS portal
// (apps/pos). They MUST stay identical: a landlord signs into either with the
// same experience; only the surrounding app (login/access) differs.
//
// S654 (Nic): "make sure that point of sale standalone is byte identical to point
// of sale on the landlord page. That way there's no deviation down the road."
// The old guard compared two files; the register also runs on the reader
// helper, the API client, the sign-in context and the dialogs — and two of
// those had drifted (the standalone missed the "errors stay up" toast fix, the
// server's plain-sentence error messages, and the S639 cache wipe on sign-in).
// So the guard now FOLLOWS THE IMPORTS: every file the register page reaches,
// directly or through another file, must be byte-identical in both apps. A new
// import is covered the day it is added. No exceptions list.
//
// If it fails: you edited a file in one app and not the other — make the same
// change in both (copy the file across).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join, normalize } from 'path'

const root = resolve(__dirname, '../../..')  // apps/api/src → repo root
const ENTRY_POINTS = ['pages/POSPage.tsx', 'pages/POSPayLinks.tsx']

function closure(app: string): Set<string> {
  const base = join(root, 'apps', app, 'src')
  const seen = new Set<string>()
  const stack = [...ENTRY_POINTS]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    const src = readFileSync(join(base, f), 'utf8')
    const re = /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const rel = m[1] ?? m[2]
      const d = normalize(join(dirname(f), rel))
      const hit = [d, `${d}.tsx`, `${d}.ts`, `${d}/index.tsx`, `${d}/index.ts`].find(c => existsSync(join(base, c)))
      if (hit) stack.push(hit)
    }
  }
  return seen
}

describe('POS register parity (landlord tab === standalone portal)', () => {
  const landlord = closure('landlord')
  const standalone = closure('pos')

  it('both registers reach the same files', () => {
    expect([...standalone].sort()).toEqual([...landlord].sort())
  })

  for (const f of [...closure('landlord')].sort()) {
    it(`${f} is byte-identical in apps/landlord and apps/pos`, () => {
      const a = readFileSync(join(root, 'apps/landlord/src', f), 'utf8')
      const b = readFileSync(join(root, 'apps/pos/src', f), 'utf8')
      expect(b, `${f} differs — copy the change to both apps`).toBe(a)
    })
  }
})
