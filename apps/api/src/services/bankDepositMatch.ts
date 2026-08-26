// S624 — match an inbound BANK DEPOSIT to the tenant charges it paid.
//
// WHY THIS EXISTS (Nic, S624). A landlord running a property remotely takes
// cash and checks, and the tenant deposits them straight into the landlord's
// bank. Today GAM makes the landlord transcribe every one of those by hand:
// look up when the deposit hit, waive the late fee that accrued in the
// meantime, credit it back down, mark the charges paid — and unwind all of it
// when a check bounces. That is the work the manual-payment fee is charging
// for, and it is work GAM can simply delete: the bank feed is already required
// and already syncing these very rows.
//
// The important by-product is not the clicks saved. It is that the DEPOSIT'S
// OWN BANK DATE becomes the payment date, so the late fee is decided by a fact
// instead of by the landlord's judgment about when someone probably paid.
//
// WHY THIS SUGGESTS RATHER THAN DECIDES
//
// The park that prompted this is ~25 lots that ALL pay $250. A $250 deposit is
// therefore consistent with 25 different tenants, and no amount of cleverness
// can tell them apart — a cash deposit carries no payer. So the matcher RANKS
// and the landlord CONFIRMS. That is still most of the work removed: picking a
// name off a shortlist instead of transcribing an amount, a date, a method and
// a set of charges.
//
// A CHECK is different from CASH here, and the difference is worth exploiting:
// the payer's name is usually in the bank memo. When a name lands, confidence
// is high enough to pre-select. When it doesn't, we say so rather than guess.
//
// RENT IS PAY-IN-FULL (standing directive), so a deposit SHORTER than a rent
// charge is never proposed as settling it — the platform would refuse the
// payment anyway, and offering it would teach the landlord to expect something
// that cannot happen. Carried balances are the documented exception and are the
// one thing a short deposit may be offered against.

import { round2 } from './workTradeCredit'

export interface OpenCharge {
  id: string
  leaseId: string
  tenantId: string
  /** For name-matching against the bank memo, and for the landlord's shortlist. */
  tenantName: string
  unitNumber: string
  amount: number
  dueDate: string
  /** `payments.type`. 'carried_balance' is the only partially-payable kind. */
  type: string
}

/**
 * A deposit the TENANT told us about — "I paid $250 at the bank on the 3rd".
 *
 * S624 (Nic): in the normal case the amounts already identify the payer, because
 * every unit is submetered and the water line makes each invoice total distinct.
 * The hard case is a property where utilities are included and every rent is the
 * same figure. Nic asked for "an option that gives the landlord minimal work to
 * do" there — and the minimal amount of work is NONE, which is what this is.
 *
 * The tenant is the one person who knows they paid. They already hold the app;
 * they already see the invoice. Letting them declare the deposit means the
 * landlord never touches it: the tenant asserts, the BANK verifies, GAM
 * reconciles the two. It is strictly better evidence than the landlord guessing,
 * because the landlord was not at the bank either.
 *
 * It also puts the manual-payment fee in front of the person choosing to pay
 * that way, at the moment they choose it, instead of on a bill the landlord has
 * to hand them.
 */
export interface TenantDeclaredDeposit {
  id: string
  leaseId: string
  tenantId: string
  amount: number
  /** The date the TENANT says they made the deposit. */
  declaredDate: string
  /**
   * S624 (Nic): "they should also mark whether they paid cash or check or money
   * order just in case two dollar amounts happen to be exactly matching."
   *
   * It is a genuinely good discriminator, because a bank memo describes the
   * INSTRUMENT even when it names nobody — and a mobile deposit is a check by
   * definition, since you cannot photograph cash.
   */
  method: 'cash' | 'check' | 'money_order'
}

/**
 * What the bank memo suggests the deposit WAS, if anything.
 *
 * Returns null when the memo is silent, which is common and must not be read as
 * a contradiction — an unhelpful memo is not evidence against a tenant.
 */
export function memoMethodHint(
  description: string | null | undefined,
): 'cash' | 'check' | null {
  const d = String(description || '').toUpperCase()
  // A mobile or remote deposit is a photographed instrument. Checked first
  // because "MOBILE DEPOSIT" contains no other clue and is extremely common.
  if (/\bMOBILE\b|\bREMOTE\b|\bRDC\b|\bCHECK\b|\bCHK\b|\bCK\b/.test(d)) return 'check'
  if (/\bCASH\b|\bATM\b|\bTELLER\b|\bCURRENCY\b/.test(d)) return 'cash'
  return null
}

/**
 * Does the tenant's stated method contradict what the bank memo describes?
 *
 * A money order deposits like a check (it is a paper instrument), so it is NOT
 * treated as contradicting a check-shaped memo. Only a genuine cash/paper
 * mismatch counts — and even then it demotes rather than eliminates, because
 * memos lie by omission and a tenant may simply have misremembered.
 */
export function methodContradicts(
  declaredMethod: TenantDeclaredDeposit['method'],
  description: string | null | undefined,
): boolean {
  const hint = memoMethodHint(description)
  if (!hint) return false
  const declaredIsPaper = declaredMethod === 'check' || declaredMethod === 'money_order'
  return declaredIsPaper ? hint === 'cash' : hint === 'check'
}

export interface DepositToMatch {
  amount: number
  postedDate: string
  description: string | null
}

export type MatchConfidence =
  /** The tenant declared this deposit and the bank row confirms it. */
  | 'declared'
  /** The memo names a tenant and their open charges total the deposit exactly. */
  | 'named_exact'
  /** The memo names a tenant; the amount does not tie out on its own. */
  | 'named_partial'
  /** Exactly one way to make this amount out of open charges. */
  | 'amount_unique'
  /** The amount ties out, but several tenants could equally be the payer. */
  | 'amount_ambiguous'
  /** Short of any full charge; only offerable against a carried balance. */
  | 'carried_paydown'

export interface DepositMatch {
  chargeIds: string[]
  leaseId: string
  tenantId: string
  tenantName: string
  unitNumber: string
  /** What these charges total. Equals the deposit except on a carried paydown. */
  total: number
  confidence: MatchConfidence
  /** How many OTHER tenants the same amount would have fitted. 0 = unambiguous. */
  rivals: number
  /** Plain sentence for the landlord's screen. Never a raw enum. */
  reason: string
}

/**
 * Confidence high enough to pre-select the row for the landlord, rather than
 * merely offering it. Everything else still requires them to choose.
 *
 * Deliberately narrow: a wrong pre-selection that gets confirmed reflexively is
 * worse than no suggestion at all, because it books a stranger's money against
 * a tenant's ledger and then reports it to a credit bureau.
 */
export function isPreselectable(m: DepositMatch): boolean {
  return m.confidence === 'declared'
    || m.confidence === 'named_exact'
    || (m.confidence === 'amount_unique' && m.rivals === 0)
}

/**
 * How far a bank posting may sit from the date the tenant says they paid.
 *
 * A branch deposit posts same-day or next business day; a weekend or a holiday
 * stretches it. Four days covers a Friday afternoon deposit over a long weekend
 * without being so wide that two consecutive months could overlap.
 */
export const DECLARATION_DATE_WINDOW_DAYS = 4

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`))
  return Math.round(ms / 86400000)
}

/**
 * Tokens from a bank memo that could plausibly be a person's name.
 *
 * Bank descriptions for deposits are noisy and mostly boilerplate — "MOBILE
 * DEPOSIT", "ATM DEPOSIT 07/12", "REMOTE DEP CHK". Strip the boilerplate and
 * whatever is left is a candidate name.
 */
const MEMO_NOISE = new Set([
  'DEPOSIT', 'DEP', 'MOBILE', 'REMOTE', 'ATM', 'BRANCH', 'TELLER', 'CASH',
  'CHECK', 'CHK', 'CK', 'MONEY', 'ORDER', 'MO', 'TRANSFER', 'XFER', 'CREDIT',
  'ACH', 'PAYMENT', 'PMT', 'RENT', 'FROM', 'REF', 'ID', 'CO', 'THANK', 'YOU',
])

export function memoNameTokens(description: string | null | undefined): string[] {
  if (!description) return []
  return String(description)
    .toUpperCase()
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !MEMO_NOISE.has(w))
}

/**
 * Does this memo name this tenant? Matches on any name part of length ≥ 3, so
 * "MOBILE DEPOSIT R GARCIA" finds Rosa Garcia on the surname alone.
 *
 * Single-initial first names are why we do not require both parts: on a paper
 * check the endorsement rarely survives into the memo intact.
 */
export function memoNamesTenant(description: string | null | undefined, tenantName: string): boolean {
  const tokens = memoNameTokens(description)
  if (tokens.length === 0) return false
  const parts = String(tenantName || '')
    .toUpperCase()
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(p => p.length >= 3)
  if (parts.length === 0) return false
  return parts.some(p => tokens.includes(p))
}

/** Cents, so subset-sum can work in exact integers. */
const cents = (n: number) => Math.round(n * 100)

/**
 * Every subset of one lease's open charges that totals exactly `target`.
 *
 * Bounded deliberately: a lease with a pathological number of open charges is a
 * broken ledger, not a matching problem, and an unbounded search here would let
 * one bad row hang the landlord's bank screen. Beyond the cap we fall back to
 * the whole-balance check only, which is the case that actually occurs.
 */
const MAX_CHARGES_FOR_SUBSET = 14

function subsetsSummingTo(charges: OpenCharge[], target: number): OpenCharge[][] {
  const t = cents(target)
  if (t <= 0) return []
  if (charges.length > MAX_CHARGES_FOR_SUBSET) {
    const whole = cents(charges.reduce((s, c) => s + c.amount, 0))
    return whole === t ? [charges.slice()] : []
  }
  const found: OpenCharge[][] = []
  const n = charges.length
  // Oldest first, so the natural reading ("they paid the back rent") comes out
  // ahead of an equivalent combination made of newer charges.
  const sorted = [...charges].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0
    const pick: OpenCharge[] = []
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += cents(sorted[i].amount); pick.push(sorted[i]) }
      if (sum > t) break
    }
    if (sum === t) found.push(pick)
  }
  // Fewest charges wins: one rent payment is a likelier story than three fees
  // that happen to add up to the same figure.
  found.sort((a, b) => a.length - b.length || a[0].dueDate.localeCompare(b[0].dueDate))
  return found
}

/**
 * Rank the ways this deposit could have been paid.
 *
 * Returns at most `limit` matches, best first. An empty result means the
 * landlord files it as other income (or ignores it) exactly as they do today —
 * this feature never blocks that path.
 */
export function matchDeposit(
  deposit: DepositToMatch,
  openCharges: OpenCharge[],
  opts: { declarations?: TenantDeclaredDeposit[]; limit?: number } = {},
): DepositMatch[] {
  const limit = opts.limit ?? 8
  if (!(deposit.amount > 0) || openCharges.length === 0) return []

  // A TENANT DECLARATION OUTRANKS EVERYTHING. It is the only signal that comes
  // from someone who was actually at the bank; the amount and the memo are both
  // inferences about a person who left no name. When one lands, the landlord has
  // nothing to do at all.
  const declared = (opts.declarations ?? []).filter(d =>
    cents(d.amount) === cents(deposit.amount)
    && daysApart(d.declaredDate, deposit.postedDate) <= DECLARATION_DATE_WINDOW_DAYS)

  // Group by lease: a deposit pays one tenant's charges. A single deposit
  // covering TWO tenants (a landlord banking the day's cash in one go) is a
  // real case, but it is a SPLIT — the landlord allocates it across tenants —
  // not a match, and offering a speculative cross-tenant combination would be
  // guessing with someone's rent record.
  const byLease = new Map<string, OpenCharge[]>()
  for (const c of openCharges) {
    const list = byLease.get(c.leaseId)
    if (list) list.push(c); else byLease.set(c.leaseId, [c])
  }

  interface Cand { m: DepositMatch; rank: number }
  const cands: Cand[] = []

  // When two tenants declare the same figure, the one whose stated instrument
  // agrees with the bank memo is the better answer — this is the tiebreaker Nic
  // asked for. If it separates them cleanly, the ambiguity disappears entirely.
  const agreeing = declared.filter(d => !methodContradicts(d.method, deposit.description))
  const usable = agreeing.length > 0 ? agreeing : declared

  for (const d of usable) {
    const charges = byLease.get(d.leaseId) ?? []
    const head = charges[0]
    if (!head) continue
    // Settle exactly what the declaration covers where we can pin it; otherwise
    // offer the tenant's open charges and let the confirm step allocate.
    const subset = subsetsSummingTo(charges, deposit.amount)[0] ?? charges
    cands.push({
      rank: -1,
      m: {
        chargeIds: subset.map(c => c.id),
        leaseId: d.leaseId, tenantId: d.tenantId,
        tenantName: head.tenantName, unitNumber: head.unitNumber,
        total: round2(subset.reduce((s2, c) => s2 + c.amount, 0)),
        confidence: 'declared',
        rivals: 0,
        reason: `${head.tenantName} reported paying $${d.amount.toFixed(2)} at the bank on ${d.declaredDate}, and this deposit matches.`,
      },
    })
  }
  const declaredLeases = new Set(cands.map(c => c.m.leaseId))

  for (const [leaseId, charges] of byLease) {
    if (declaredLeases.has(leaseId)) continue
    const head = charges[0]
    const named = memoNamesTenant(deposit.description, head.tenantName)

    const subsets = subsetsSummingTo(charges, deposit.amount)
    if (subsets.length > 0) {
      const best = subsets[0]
      cands.push({
        // Named-and-exact is the only combination we will ever pre-select, so
        // it ranks alone at the top.
        rank: named ? 0 : 2,
        m: {
          chargeIds: best.map(c => c.id),
          leaseId, tenantId: head.tenantId,
          tenantName: head.tenantName, unitNumber: head.unitNumber,
          total: round2(best.reduce((s, c) => s + c.amount, 0)),
          confidence: named ? 'named_exact' : 'amount_unique',
          rivals: 0,
          reason: named
            ? `The deposit names ${head.tenantName} and matches ${best.length === 1 ? 'their open charge' : `${best.length} open charges`} exactly.`
            : `Matches ${best.length === 1 ? 'an open charge' : `${best.length} open charges`} on ${head.unitNumber} exactly.`,
        },
      })
      continue
    }

    // No exact tie-out. A named tenant is still worth surfacing — the landlord
    // may know the payer short-paid, or that it covers something not yet billed.
    if (named) {
      const outstanding = round2(charges.reduce((s, c) => s + c.amount, 0))
      cands.push({
        rank: 1,
        m: {
          chargeIds: [], leaseId, tenantId: head.tenantId,
          tenantName: head.tenantName, unitNumber: head.unitNumber,
          total: outstanding,
          confidence: 'named_partial',
          rivals: 0,
          reason: `The deposit names ${head.tenantName}, but $${deposit.amount.toFixed(2)} does not match their $${outstanding.toFixed(2)} outstanding.`,
        },
      })
      continue
    }

    // Short of everything — only a carried balance may be paid down in part
    // (S622). Rent stays all-or-nothing, so we do not offer it.
    const carried = charges.filter(c => c.type === 'carried_balance')
    const carriedTotal = round2(carried.reduce((s, c) => s + c.amount, 0))
    if (carried.length > 0 && deposit.amount < carriedTotal) {
      cands.push({
        rank: 3,
        m: {
          chargeIds: carried.map(c => c.id),
          leaseId, tenantId: head.tenantId,
          tenantName: head.tenantName, unitNumber: head.unitNumber,
          total: carriedTotal,
          confidence: 'carried_paydown',
          rivals: 0,
          reason: `Could be a partial payment against ${head.tenantName}'s $${carriedTotal.toFixed(2)} carried balance.`,
        },
      })
    }
  }

  // Two tenants declaring the same figure in the same window is possible in a
  // uniform-rent park. It is still a vastly smaller question than before — a
  // choice between the two who say they paid, not among everyone who owes.
  const declaredHits = cands.filter(c => c.m.confidence === 'declared')
  if (declaredHits.length > 1) {
    for (const c of declaredHits) {
      c.rank = 1
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = declaredHits.length - 1
      c.m.reason =
        `${c.m.tenantName} reported a deposit of this amount — but so did ` +
        `${declaredHits.length - 1} other ${declaredHits.length - 1 === 1 ? 'tenant' : 'tenants'}. Confirm who paid.`
    }
  }

  // A NAME THAT FITS SEVERAL TENANTS IS NOT AN IDENTIFICATION. Two tenants
  // called Garcia, or a memo whose only surviving token is a word they happen to
  // share, must not produce a confident pre-selected match — that is the exact
  // failure this whole file is built to avoid, arriving through the door we
  // trusted most. Demote every named match to the ambiguous shortlist when more
  // than one lease answers to the name.
  const namedHits = cands.filter(c =>
    c.m.confidence === 'named_exact' || c.m.confidence === 'named_partial')
  if (namedHits.length > 1) {
    for (const c of namedHits) {
      const others = namedHits.length - 1
      c.rank = 2
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = others
      c.m.reason =
        `The deposit's name matches ${c.m.tenantName} on ${c.m.unitNumber}, but it ` +
        `also matches ${others} other ${others === 1 ? 'tenant' : 'tenants'}. Confirm who paid.`
    }
  }

  // Ambiguity is a property of the WHOLE result, not of any one row: if four
  // tenants all owe $250, none of them is a unique match, and saying so is the
  // difference between a useful shortlist and a confident wrong answer.
  const exact = cands.filter(c => c.m.confidence === 'amount_unique')
  if (exact.length > 1) {
    for (const c of exact) {
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = exact.length - 1
      c.m.reason =
        `Matches ${c.m.unitNumber} exactly — but ${exact.length - 1} other ` +
        `${exact.length - 1 === 1 ? 'tenant owes' : 'tenants owe'} the same amount. Confirm who paid.`
    }
  }

  cands.sort((a, b) =>
    a.rank - b.rank ||
    a.m.tenantName.localeCompare(b.m.tenantName))
  return cands.slice(0, limit).map(c => c.m)
}
