/**
 * The knowledge wall — enforced against the content on disk.
 *
 * S620 (Nic): "the tenant agent keeps telling people stuff about the landlord
 * or the booking side that has nothing to do with being a tenant... maybe we
 * make them separate things and knowledge bases completely."
 *
 * Retrieval now filters to ONE scope per profile, so cross-audience content
 * cannot be retrieved — provided the content itself is filed correctly and
 * stays that way. This suite is that proviso. It reads the markdown directly,
 * needs no database and no embedding endpoint, and fails on the two ways the
 * wall rots:
 *
 *   1. A PRODUCT NAME lands in a scope that must never have heard of it.
 *      Found on the day this was written: landlord/ending-a-lease.md named
 *      FlexDeposit, a tenant product, inside the landlord agent's knowledge.
 *   2. A DUPLICATED FACT DRIFTS. Dropping the shared pool means universal
 *      facts are copied per audience, and copies drift — a landlord was told a
 *      nightly booking cost 5% when it had been 3% since S616. Every copy of a
 *      canonical key must state the same figures.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { parseArticle } from './ingestKnowledge'
import { KNOWLEDGE_SCOPES, type KnowledgeScope } from './types'
import { AGENT_PROFILES } from './profiles'

const CONTENT_ROOT = join(__dirname, 'knowledge-content')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

interface Article {
  path: string
  scope: KnowledgeScope
  title: string
  body: string
  canonical?: string
}

const ARTICLES: Article[] = walk(CONTENT_ROOT).map((file) => {
  const parsed = parseArticle(readFileSync(file, 'utf8'))
  return { path: relative(CONTENT_ROOT, file), ...parsed }
})

/**
 * Terms that BELONG to one audience and must not appear in another's
 * knowledge. Straight from the product-siloing rule: a landlord agent has
 * never heard of FlexPay, a tenant agent has never heard of FlexVault.
 *
 * `allow` names the scopes that may legitimately use the term. Everything
 * else is a violation. Word-boundary matched so "deposit" is untouched — only
 * the PRODUCT names are owned.
 */
const OWNED_TERMS: { term: RegExp; label: string; allow: KnowledgeScope[] }[] = [
  // Tenant-side products. A landlord or a prospect must never be told these
  // exist; that is a cross-side leak, not a helpful aside.
  { term: /\bFlexPay\b/i, label: 'FlexPay (tenant product)', allow: ['tenant'] },
  { term: /\bFlexCredit\b/i, label: 'FlexCredit (tenant product)', allow: ['tenant'] },
  { term: /\bFlexDeposit\b/i, label: 'FlexDeposit (tenant product)', allow: ['tenant'] },
  // Landlord-side product. A tenant agent has never heard of it — the S617
  // scope-guard leak was this exact word.
  { term: /\bFlexVault\b/i, label: 'FlexVault (landlord product)', allow: ['landlord', 'sales'] },
  // GAM's own rate card is what GAM charges a LANDLORD. A tenant never pays
  // it, and on a booking site "what does it cost" means the nightly rate.
  { term: /\$2 per occupied unit\b/i, label: "GAM's per-unit platform fee", allow: ['landlord', 'sales'] },
  { term: /\bplatform fee\b/i, label: "GAM's platform fee", allow: ['landlord', 'sales'] },
  // On-Time Pay is shelved AND landlord-only; it must not surface anywhere
  // tenant-facing even if someone re-adds an article about it.
  { term: /\bOn-Time Pay\b/i, label: 'On-Time Pay (landlord-only, shelved)', allow: ['landlord'] },
]

describe('knowledge scopes', () => {
  it('every article sits in a directory matching its declared scope', () => {
    const misfiled = ARTICLES
      .filter((a) => !a.path.startsWith(`${a.scope}/`))
      .map((a) => `${a.path} declares scope '${a.scope}'`)
    expect(misfiled).toEqual([])
  })

  it('every scope a profile reads has content behind it', () => {
    // A profile pointed at an empty slice retrieves nothing at all and answers
    // from the model's head. That is how the guest and visitor agents ran
    // before S620 — pointed at knowledge that was never about them.
    const withContent = new Set(ARTICLES.map((a) => a.scope))
    const starved = AGENT_PROFILES
      .flatMap((p) => p.knowledgeScopes.map((s) => ({ profile: p.id, scope: s })))
      .filter(({ scope }) => !withContent.has(scope))
      .map(({ profile, scope }) => `${profile} reads '${scope}' — no articles`)
    expect(starved).toEqual([])
  })

  it('no profile reads more than one scope — the wall is one slice per audience', () => {
    // Nic, S620: "maybe we make them separate things and knowledge bases
    // completely." Two scopes on a profile is the shared pool creeping back.
    const wide = AGENT_PROFILES
      .filter((p) => p.knowledgeScopes.length > 1)
      .map((p) => `${p.id}: ${p.knowledgeScopes.join(' + ')}`)
    expect(wide).toEqual([])
  })

  it('declares no scope that is not a real scope', () => {
    const bad = ARTICLES.filter((a) => !KNOWLEDGE_SCOPES.includes(a.scope))
    expect(bad).toEqual([])
  })
})

describe('cross-audience product leakage', () => {
  for (const { term, label, allow } of OWNED_TERMS) {
    it(`${label} appears only in ${allow.join('/')}`, () => {
      const leaks = ARTICLES
        .filter((a) => !allow.includes(a.scope) && term.test(a.body))
        .map((a) => a.path)
      expect(leaks).toEqual([])
    })
  }
})

/**
 * Figures a copy states. Deliberately NARROW: money, percentages, and the two
 * count/length forms that appear in duplicated security content. Prose differs
 * between audiences by design — that is the whole point of duplicating rather
 * than sharing — so only the NUMBERS are compared. List markers ("1.") and
 * ordinary counts are ignored; they carry no risk of a wrong answer.
 */
function figuresIn(body: string): string[] {
  const out = [
    ...(body.match(/\$[\d,]+(?:\.\d{1,2})?/g) ?? []),
    ...(body.match(/\b\d+(?:\.\d+)?%/g) ?? []),
    ...(body.match(/\b\d+[-\s]digit\b/gi) ?? []),
    ...(body.match(/\b\d+\s+(?:one-time|recovery)\s+codes?\b/gi) ?? []),
  ].map((s) => s.toLowerCase().replace(/\s+/g, ' '))
  return [...new Set(out)].sort()
}

describe('canonical facts stay in sync across their copies', () => {
  const groups = new Map<string, Article[]>()
  for (const a of ARTICLES) {
    if (!a.canonical) continue
    const list = groups.get(a.canonical) ?? []
    list.push(a)
    groups.set(a.canonical, list)
  }

  it('finds the canonical groups', () => {
    // Guards the test itself: a typo'd frontmatter key would silently make
    // every assertion below vacuous.
    expect(groups.size).toBeGreaterThan(0)
  })

  it('no canonical key is stranded in a single scope', () => {
    // A key with one copy is either a leftover from a deleted copy or a
    // mislabel. Either way the marker is claiming a relationship that no
    // longer exists.
    const lonely = [...groups.entries()]
      .filter(([, copies]) => copies.length < 2)
      .map(([key, copies]) => `${key}: only ${copies[0].path}`)
    expect(lonely).toEqual([])
  })

  it('one copy per scope — no scope carries two versions of the same fact', () => {
    const doubled: string[] = []
    for (const [key, copies] of groups) {
      const byScope = new Map<string, string[]>()
      for (const c of copies) byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), c.path])
      for (const [scope, paths] of byScope) {
        if (paths.length > 1) doubled.push(`${key} in ${scope}: ${paths.join(', ')}`)
      }
    }
    expect(doubled).toEqual([])
  })

  it('every copy states the same figures', () => {
    // THE 5%-vs-3% CHECK. Duplication without this is how one stale article
    // told a landlord a nightly booking cost 5% for two sessions after it
    // changed. Voice may differ; numbers may not.
    const drifted: string[] = []
    for (const [key, copies] of groups) {
      const seen = copies.map((c) => ({ path: c.path, figures: figuresIn(c.body) }))
      const first = seen[0]
      for (const other of seen.slice(1)) {
        if (JSON.stringify(other.figures) !== JSON.stringify(first.figures)) {
          drifted.push(
            `${key}: ${first.path} states [${first.figures.join(', ')}] but ` +
            `${other.path} states [${other.figures.join(', ')}]`
          )
        }
      }
    }
    expect(drifted).toEqual([])
  })
})
