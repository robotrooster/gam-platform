/**
 * 10/22 (Nic) — "it says one item needs attention, but there's nothing
 * populating in the list."
 *
 * The API has always sent NINE kinds of to-do and counted all nine into the
 * total the card shows. The card rendered eight. So a park owing its home
 * inventory was counted and had nowhere to appear: a number with nothing under
 * it, and no way to make it go away.
 *
 * It survived because it was one row among fifty-seven. Taking the fifty-six
 * tenant-ACH rows off (10/21) left it standing on its own, which is how a quiet
 * two-year-old bug becomes visible the day you tidy up around it.
 *
 * This reads both files. A count with no section is the bug; a section with no
 * count is a card that can never fill. Neither is allowed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const API = join(__dirname, '../../../api/src/routes/landlords.ts')
const PAGE = join(__dirname, 'DashboardPage.tsx')

/** The keys inside the `counts:` object the todos route answers with. */
function countedKinds(): string[] {
  const src = readFileSync(API, 'utf8')
  const start = src.indexOf('        counts: {')
  expect(start, 'the todos route still answers with a counts object').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('},', start))
  return [...block.matchAll(/^\s{10}(\w+):/gm)].map(m => m[1]).filter(k => k !== 'total')
}

/** The keys the dashboard's to-do card actually renders a section for. */
function renderedKinds(): string[] {
  const src = readFileSync(PAGE, 'utf8')
  const start = src.indexOf('const sections = [')
  expect(start, 'the dashboard still builds a sections list').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('\n  ]', start))
  return [...block.matchAll(/\{\s*key:\s*'([^']+)'/g)].map(m => m[1])
}

describe('every kind of to-do the server counts has somewhere to appear', () => {
  it('counts nothing it cannot show', () => {
    const counted = countedKinds()
    const rendered = renderedKinds()
    expect(counted.length).toBeGreaterThan(5)   // the reader found the block
    const countedButInvisible = counted.filter(k => !rendered.includes(k))
    expect(countedButInvisible).toEqual([])
  })

  it('shows nothing it never counts — a section that can never fill is dead furniture', () => {
    const counted = countedKinds()
    const renderedButUncounted = renderedKinds().filter(k => !counted.includes(k))
    expect(renderedButUncounted).toEqual([])
  })

  it('home inventory in particular, since that is the one that was missing', () => {
    expect(countedKinds()).toContain('homeInventory')
    expect(renderedKinds()).toContain('homeInventory')
  })
})
