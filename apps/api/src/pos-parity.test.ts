// S570 (Nic): the POS register screen is intentionally shipped in TWO apps —
// the landlord portal's /pos tab (apps/landlord) and the standalone POS portal
// (apps/pos). They MUST stay identical: a landlord signs into either with the
// same experience; only the surrounding app (login/access) differs. The two
// apps' auth/api layers diverge enough that a single shared component would mean
// unifying auth first (a bigger, riskier refactor), so for now the files are
// kept byte-identical and THIS test enforces it. If it fails: you edited one
// POSPage.tsx and not the other — apply the same change to both.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('POS register parity (landlord tab === standalone portal)', () => {
  it('apps/landlord and apps/pos POSPage.tsx are byte-identical', () => {
    const root = resolve(__dirname, '../../..')  // apps/api/src → repo root
    const landlord = readFileSync(resolve(root, 'apps/landlord/src/pages/POSPage.tsx'), 'utf8')
    const standalone = readFileSync(resolve(root, 'apps/pos/src/pages/POSPage.tsx'), 'utf8')
    expect(standalone).toBe(landlord)
  })
})
