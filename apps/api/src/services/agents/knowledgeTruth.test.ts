/**
 * S626 — WHAT THE AGENTS ARE TOLD MUST MATCH WHAT SHIPPED.
 *
 * Nic asked why the agents make things up. In the case he named as the clearest
 * fabrication, they did not. His note on balance-then-decline read: "'unapplied
 * remainder becomes pay-ahead credit' is FABRICATED — how-payments-are-applied.md
 * says you cannot pay a partial amount or pay ahead."
 *
 * Pay-ahead shipped in S609. lease_prepaid_credits is a real table with a real
 * migration and a real code path. The agent described the platform correctly and
 * the ARTICLE was out of date, so the agent read as though it were inventing.
 * S624 found the same thing and fixed the article.
 *
 * That is the failure mode worth guarding. An agent is only ever as truthful as
 * its knowledge base, and when the product moves and the prose does not it has
 * two options: contradict the article and look like a liar, or follow it and
 * tell a customer something false. Both look identical from outside.
 *
 * S625's own handoff: "Tests guard behaviour; nothing guards explanations."
 * This guards the explanations.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { MANUAL_PAYMENT_FEE, PROCESSING_FEES, CARD_DECLINE_FEE } from '@gam/shared'

const ROOT = join(__dirname, 'knowledge-content')

function allArticles(dir = ROOT, out: { path: string; text: string }[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) allArticles(p, out)
    else if (name.endsWith('.md')) out.push({ path: p.replace(ROOT + '/', ''), text: readFileSync(p, 'utf8') })
  }
  return out
}
const ARTICLES = allArticles()
const CORPUS = ARTICLES.map((a) => a.text).join('\n')

/** Where an article states a figure, it must be the figure the code charges. */
describe('the knowledge base quotes the live fee schedule', () => {
  it('has articles to check', () => expect(ARTICLES.length).toBeGreaterThan(50))

  // S630 DIRECTIVE (Nic): "It's ten dollars per Connect account. So if several
  // properties deposit to the same Stripe account, it's only ten dollar minimum
  // for that setup." Two SALES articles still said per-property after the code
  // changed — Lucy would have quoted a prospect a price GAM does not charge.
  it('never describes the platform minimum as per property', () => {
    // Targeted at the phrasing, not mere co-occurrence: the same sentence
    // legitimately says the ACH fee payer "is set per property".
    const BAD = /(per[- ]propert\w*[^.]{0,30}minimum|minimum[^.]{0,30}per[- ]propert\w*|\$10\s*(a|per)\s*propert\w*)/i
    const offenders = CORPUS.split('\n')
      // "…per payout account — NOT per property" is the correction, not the
      // error, and saying so plainly is the point.
      .map((l) => l.replace(/not per[- ]propert\w*/gi, ''))
      .filter((l) => BAD.test(l))
    expect(offenders, offenders.join('\n')).toHaveLength(0)
  })

  it('states the ACH fee as the constant, never a different flat figure', () => {
    // Standing directive: $6 flat ACH is ironclad revenue.
    expect(PROCESSING_FEES.ACH_FLAT).toBe(6)
    // S630 (Nic): "we are gonna make that absolutely free to pay with cash."
    // The manual fee used to be pinned to the ACH figure so cash never cost
    // more; it is now zero, and cash is the CHEAPEST option rather than an
    // equal one. The knowledge base must not still quote a figure for it —
    // an agent telling a tenant cash costs $6 is quoting a price GAM does not
    // charge.
    expect(MANUAL_PAYMENT_FEE).toBe(0)
    for (const line of CORPUS.split('\n')) {
      if (!/manual[- ]payment fee|paying (this way|by cash)/i.test(line)) continue
      expect(/\$\s?[1-9]/.test(line), `quotes a cash fee: ${line.trim().slice(0, 120)}`).toBe(false)
    }
    // Exclude lines about the DECLINED-payment fee: it is its own constant,
    // legitimately $1, and shares a sentence with the bank/card wording. (A
    // lookahead was the first attempt and it silently backtracked "$1.00" down
    // to "1" until the exclusion passed — filter the line, don't out-clever the
    // regex engine.)
    const achLines = CORPUS.split('\n')
      .filter((l) => /\bACH\b|manual[- ]payment fee/i.test(l))
      .filter((l) => !/declin\w*[- ]payment fee/i.test(l))
    expect(achLines.length).toBeGreaterThan(0)
    for (const line of achLines) {
      // Any "flat $N" on an ACH/manual line must be the real fee — EXCEPT the
      // declined-payment fee, which is its own constant and legitimately $1,
      // and which shares a sentence with the bank/card wording.
      for (const m of line.matchAll(/flat \$\s?(\d+(?:\.\d\d)?)/gi)) {
        expect(Number(m[1]), `"${line.trim().slice(0, 90)}"`).toBe(PROCESSING_FEES.ACH_FLAT)
      }
    }
  })

  it('states the card decline fee as the constant', () => {
    for (const line of CORPUS.split('\n').filter((l) => /declin\w+[- ]payment fee/i.test(l))) {
      for (const m of line.matchAll(/\$\s?([\d.]+)/g)) {
        expect(Number(m[1]), `"${line.trim().slice(0, 90)}"`).toBe(CARD_DECLINE_FEE)
      }
    }
  })
})

/**
 * Figures the platform USED to charge. Each one reached a customer at some
 * point, and each is now wrong. A repricing that leaves one of these behind is
 * exactly how an agent ends up quoting a price GAM does not charge.
 */
describe('retired figures never reappear', () => {
  it.each([
    ['2.9% — the old Stripe card rate', /\b2\.9\s?%/],
    ['$0.30 — the old card flat', /\$\s?0\.30\b/],
    ['a $3 ACH fee', /flat \$\s?3\b/i],
    ['$15 per unit — the retired landlord tier', /\$\s?15\s*(?:per|\/)\s*(?:occupied\s*)?unit/i],
    ['$20 FlexPay monthly — was stale in the code too', /\$\s?20\s*(?:a|per|\/)\s*month.{0,30}flexpay/i],
  ])('%s is gone from the knowledge base', (_label, pattern) => {
    const offenders = ARTICLES.filter((a) => pattern.test(a.text)).map((a) => a.path)
    expect(offenders).toEqual([])
  })
})

/**
 * Claims the articles must not make, because the platform does the opposite.
 * These are the ones that produced a "fabricating" verdict in the review.
 */
describe('the knowledge base does not deny what shipped', () => {
  it('does not deny pay-ahead — it shipped in S609 (lease_prepaid_credits)', () => {
    const offenders = ARTICLES
      .filter((a) => /can'?t pay ahead|cannot pay ahead|no pay.?ahead credit/i.test(a.text))
      .map((a) => a.path)
    expect(offenders).toEqual([])
  })

  it('still states the rent rule that IS true — pay in full, platform-wide', () => {
    // The inverse risk: over-correcting the article until it stops saying the
    // thing that is actually a standing directive.
    expect(/all-or-nothing|paid \*\*in full\*\*|paid in full/i.test(CORPUS)).toBe(true)
  })

  it('does not promise GAM advances funds — standing directive, never true', () => {
    const offenders = ARTICLES
      .filter((a) => /GAM (advances|fronts|lends you)|we advance the (rent|money|funds)/i.test(a.text))
      .map((a) => a.path)
    expect(offenders).toEqual([])
  })
})
