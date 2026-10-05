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
 * S625's own handoff: "Tests guard behavior; nothing guards explanations."
 * This guards the explanations.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { PROCESSING_FEES, CARD_DECLINE_FEE, INCOME_BASIS_LABEL } from '@gam/shared'

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
    // Exclude lines about the DECLINED-payment fee: it is its own constant,
    // legitimately $1, and shares a sentence with the bank/card wording. (A
    // lookahead was the first attempt and it silently backtracked "$1.00" down
    // to "1" until the exclusion passed — filter the line, don't out-clever the
    // regex engine.)
    const achLines = CORPUS.split('\n')
      .filter((l) => /\bACH\b/i.test(l))
      .filter((l) => !/declin\w*[- ]payment fee/i.test(l))
    expect(achLines.length).toBeGreaterThan(0)
    for (const line of achLines) {
      // Any "flat $N" on an ACH line must be the real fee — EXCEPT the
      // declined-payment fee, which is its own constant and legitimately $1,
      // and which shares a sentence with the bank/card wording.
      for (const m of line.matchAll(/flat \$\s?(\d+(?:\.\d\d)?)/gi)) {
        expect(Number(m[1]), `"${line.trim().slice(0, 90)}"`).toBe(PROCESSING_FEES.ACH_FLAT)
      }
    }
  })

  // S654 DIRECTIVE (Nic): "No charge for cash or checks anywhere in the
  // platform... It's not a rule anymore. It's not a thing. There's no fee."
  // No article may price paying in person, name a manual-payment fee, or keep
  // the retired "first one free" rule alive.
  it('never prices cash, check or money order, and never revives the first-free rule', () => {
    const offenders = CORPUS.split('\n').filter((l) =>
      // (A background or credit check legitimately costs money — not this rule.)
      /manual[- ]payment fee|cash[- ](handling )?fee|(cash|(?<!background |credit )check|money order)[^.]{0,60}\bcosts?\b[^.]{0,30}\$\s?[1-9]/i.test(l)
      || /first (one|payment|cash payment|manual payment)[^.]{0,40}\bfree\b/i.test(l))
    expect(offenders, offenders.join('\n')).toHaveLength(0)
    // And at least one article says it plainly, so an agent can ground on it.
    expect(/(cash|check)[^.]{0,60}\bfree\b/i.test(CORPUS)).toBe(true)
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

/**
 * S655 review — "I paid at the bank" is matched, expired and flagged ONLY while
 * GAM is reading the landlord's bank (an active, synced link). Without one
 * (TruBlu and Country Acres today) nothing matches a report and nothing expires
 * it: the landlord checks their own bank and marks the bill paid. The screens,
 * the route and the agent action all say so; the articles told a TruBlu tenant
 * their deposit "will be applied automatically", and the agents repeated it.
 */
describe('a reported bank deposit is promised only what GAM can do', () => {
  // Every sentence in a section that offers "I paid at the bank".
  const sections = ARTICLES.flatMap((a) => a.text.split(/^## /m)
    .filter((s) => /paid at the bank/i.test(s))
    .map((s) => ({ path: a.path, text: s })))
  const sentences = sections.flatMap((s) => s.text.split(/(?<=[.!?])\s+/)
    .map((sentence) => ({ path: s.path, sentence: sentence.trim() })))

  it('has the sections to check (tenant and landlord)', () => {
    const paths = new Set(sections.map((s) => s.path.split('/')[0]))
    expect([...paths].sort()).toEqual(['landlord', 'tenant'])
  })

  it('never promises it is applied automatically, expires or is flagged without the bank being connected', () => {
    const PROMISE = /\bautomatic|\bexpires? after|you'll be told|they are told|flagged to you/i
    const offenders = sentences
      .filter((x) => PROMISE.test(x.sentence) && !/\bconnected\b/i.test(x.sentence))
      .map((x) => `${x.path}: ${x.sentence.slice(0, 110)}`)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('tells a tenant what happens when the bank is not connected: the landlord marks it paid, keep the slip', () => {
    for (const s of sections.filter((x) => x.path.startsWith('tenant/'))) {
      expect(s.text, s.path).toMatch(/isn't connected, your landlord checks their own bank and marks your bill paid/)
      expect(s.text, s.path).toMatch(/keep your deposit slip/)
    }
  })
})

/**
 * S655 (money plan, Step 11) — credit, balances and the two report bases, as
 * Nic decided them on 10/2. The articles said a prepaid credit "is applied
 * automatically to your next invoice" and a waiver credit "lands on their open
 * balance straight away"; the agents repeated both. Credit pays a bill by itself
 * only when it covers the whole bill; otherwise the payer chooses.
 */
describe('S655 credit is described the way it works', () => {
  const article = (path: string) => {
    const a = ARTICLES.find((x) => x.path === path)
    expect(a, path).toBeTruthy()
    return a!.text
  }

  it('never promises credit comes off the next bill by itself', () => {
    const BAD = /applied automatically to your next invoice|comes off your next bill automatically|released toward future rent as it comes due|lands on their open balance straight away/i
    const offenders = ARTICLES.filter((a) => BAD.test(a.text)).map((a) => a.path)
    expect(offenders).toEqual([])
  })

  it('states the whole-bill rule and the two choices where tenants and landlords read about credit', () => {
    for (const path of ['tenant/how-payments-are-applied.md', 'tenant/paying-rent.md', 'landlord/waiving-a-charge.md']) {
      expect(article(path), path).toMatch(/by itself only when it covers the whole bill/)
      expect(article(path), path).toMatch(/Use all \$X/)
      expect(article(path), path).toMatch(/Save it for later/)
    }
    // Autopay keeps the credit unless the tenant turned "use my credit first" on.
    expect(article('tenant/how-payments-are-applied.md')).toMatch(/Use my account credit first", that is off unless you turn it on/)
  })

  it('saved credit is never said to stop a late fee', () => {
    expect(article('landlord/waiving-a-charge.md')).toMatch(/Saved credit does not stop a late fee unless it covers the whole bill/)
    expect(article('tenant/how-payments-are-applied.md')).toMatch(/Saved credit doesn't stop a late fee unless it covers the whole bill/)
  })

  it('the profit-and-loss article names both bases in the screens\' own words and never counts a credit as income', () => {
    const text = article('landlord/expenses-and-your-profit-and-loss.md')
    expect(text).toContain(`**${INCOME_BASIS_LABEL.received}**`)
    expect(text).toContain(`**${INCOME_BASIS_LABEL.billed}**`)
    expect(text).toMatch(/a credit you give is never income/i)
    // Money received is the day the money arrived (owner correction, 10/2).
    expect(text).toMatch(/counts money on the day it arrived/)
  })

  it('a bank-deposit match never spends credit, and adding a bank never removes the old one', () => {
    expect(article('landlord/matching-cash-deposits-to-rent.md')).toMatch(/a match never spends the tenant's account credit/)
    expect(article('tenant/updating-your-payment-method.md')).toMatch(/Adding a bank account never removes the one you already have/)
  })

  it('names both deposits GAM settles by itself — a confirmed report and an unreported whole bill — and the Undo', () => {
    // bankFeed.decideDeposit: 'declared' (a report the bank confirms) and
    // 'auto_settle' (bankDepositMatch.isAutoSettleable: exactly one tenant's
    // whole bill, nothing rival). Both write bank_transactions.auto_settle_undo,
    // and bankDepositConfirm.undoDepositMatch undoes either from the Bank feed.
    const text = article('landlord/matching-cash-deposits-to-rent.md')
    expect(text).not.toMatch(/There is one case GAM settles without asking/)
    expect(text).toMatch(/There are two cases GAM settles without asking/)
    expect(text).toMatch(/The tenant reported the deposit themselves, the bank confirms it/)
    expect(text).toMatch(/A deposit equal to the cent to everything one tenant owes you/)
    expect(text).toMatch(/no other deposit of the same amount came in within a few days/)
    expect(text).toMatch(/A payout from a payment company that happens to match is never taken as rent/)
    expect(text).toMatch(/The tenant and you are both told/)
    expect(text).toMatch(/press \*\*Undo this match\*\* on the deposit under \*\*Bank → Bank feed\*\*/)
  })

  it('a bank a payment is still clearing from, or is set to be tried again from, is never said to be removable', () => {
    // tenantBankMethods.pullBlockFor: kept even beside another verified bank (decisions #34(c)).
    const text = article('tenant/updating-your-payment-method.md')
    expect(text).toMatch(/A bank can't be removed while a payment from it is still clearing \(about 4 business days\) or is set to be tried again from it — even if another bank is verified/)
    // onlyVerifiedBankBlock: FlexPay keeps the only verified bank too (decisions #34(a)(b)).
    expect(text).toMatch(/only verified bank[^.]*\. The same goes while you're on FlexPay or a FlexPay payment is still owed/)
  })
})
