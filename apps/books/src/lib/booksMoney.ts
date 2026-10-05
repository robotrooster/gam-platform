/**
 * S655 (money plan, Step 15): the small rules GAM Books' money screens share,
 * kept out of main.tsx (which renders on import) so each one is tested.
 */
import type { IncomeBasis } from '@gam/shared'

// ─── Rent roll ───────────────────────────────────────────────────────────────

export interface RentRollUnit {
  status: string
  rentAmount: number | string | null
  collectedMtd?: number | string | null
}

/**
 * Does this space owe this landlord rent? S604: an owner-use space is occupied
 * but pays no rent. S616: a utility service point is a neighbor's building this
 * landlord only supplies. A vacant space has nobody to pay. None of the three
 * is expected rent, so none of them can show a variance nobody owes.
 */
export function earnsRent(u: Pick<RentRollUnit, 'status'>): boolean {
  return u.status !== 'vacant' && u.status !== 'owner_use' && u.status !== 'utility_service'
}

/** A row's variance: what came in less the rent it owes; null for a space that owes none. */
export function rentRollVariance(u: RentRollUnit): number | null {
  if (!earnsRent(u)) return null
  return round2((Number(u.collectedMtd) || 0) - (Number(u.rentAmount) || 0))
}

/** The spaces that owe rent (the "payable across N" count). */
export function rentPayers<T extends RentRollUnit>(units: readonly T[]): T[] {
  return units.filter(earnsRent)
}

/** Expected rent across the roll: only spaces that owe it — what the API's total says. */
export function expectedRent(units: readonly RentRollUnit[]): number {
  return round2(rentPayers(units).reduce((s, u) => s + (Number(u.rentAmount) || 0), 0))
}

// ─── The GAM P&L's figures beside its total ─────────────────────────────────

export interface BesideFigure { key: string; label: string; amount: number }

/**
 * Money billed: collected so far, still clearing and still owed are what became
 * of the bills — they add up to the total, and still owed is INSIDE it — so
 * they are listed as that, never as "beside the total". Everything else is
 * beside the total.
 *
 * Money received (§0.0, Todd): paid-ahead money counted in full on the day it
 * arrived ("Paid ahead for later bills", inside the total) and $0 again when it
 * pays a bill. What is still on hand (`paidAheadUnused`) is therefore never
 * "beside the total" — that would tell the landlord they hold that much more
 * than the report counted — and comes back as `onHand`, to be shown on its own
 * line with PAID_AHEAD_COUNTED_NOTE. Every other figure is beside the total.
 */
export const BILLED_OUTCOME_KEYS = ['collectedSoFar', 'clearing', 'stillOwed'] as const
export const PAID_AHEAD_ON_HAND_KEY = 'paidAheadUnused'
export const PAID_AHEAD_COUNTED_NOTE = 'counted on the day it arrived; $0 again when it pays a bill'

export function splitBeside(
  items: readonly BesideFigure[] | null | undefined, basis: IncomeBasis,
): { outcome: BesideFigure[]; aside: BesideFigure[]; onHand: BesideFigure | null } {
  const list = [...(items ?? [])]
  if (basis !== 'billed') {
    const found = list.find(i => i.key === PAID_AHEAD_ON_HAND_KEY)
    return {
      outcome: [],
      aside: list.filter(i => i.key !== PAID_AHEAD_ON_HAND_KEY),
      onHand: found && Number(found.amount) ? found : null,
    }
  }
  const keys = BILLED_OUTCOME_KEYS as readonly string[]
  return {
    outcome: BILLED_OUTCOME_KEYS
      .map(k => list.find(i => i.key === k))
      .filter((i): i is BesideFigure => !!i),
    aside: list.filter(i => !keys.includes(i.key)),
    onHand: null,
  }
}

/**
 * Today on the viewer's own calendar, 'YYYY-MM-DD'. Never toISOString, the UTC
 * date: on an Arizona evening that is already tomorrow, so a new entry would
 * default to tomorrow's date and a report "through today" would end tomorrow.
 */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * A screen that could not load says why, once. "Try again in a moment" only
 * when trying again can help — the network, the server failing (5xx), or
 * too many requests (429). A refusal (403) or a request the server asks to be
 * changed (400 "choose which company") carries its own next step, and saying
 * "try again" there is wrong.
 */
export function loadErrorText(error: unknown, fallback: string): string {
  const e = error as any
  const status: number | undefined = e?.response?.status ?? e?.status
  const serverText: string | undefined = e?.response?.data?.error ?? e?.response?.data?.message
  // Too many requests (the API's rate limit answers 429 in plain text, so no
  // sentence here): waiting is the next step.
  if (status === 429) return `${serverText || fallback} Try again in a moment.`
  if (status && status >= 400 && status < 500) return serverText || fallback
  // A 500's message is an unexpected failure's own words (a database error) —
  // the server's insides, never plain words for the reader. Another 5xx (503,
  // "restarting") may carry a sentence meant for them.
  return `${(status !== 500 && serverText) || fallback} Try again in a moment.`
}

// ─── Which company's books ───────────────────────────────────────────────────

export interface CompanyChoice { landlordId: string; businessName?: string | null; propertyNames?: string | null }

/**
 * A landlord account with several companies opens one company's books at a
 * time and is ASKED which — never defaulted (S654: "None is the default").
 *  - mustChoose: several companies and none (or one not on the list) chosen.
 *  - staleChoice: a remembered choice that is no longer one of the account's
 *    companies (sold, or another person's on a shared computer) — forget it.
 * One company needs no choice: the server opens it.
 */
export function companyChoiceState(
  companies: readonly CompanyChoice[] | null | undefined, activeId: string | null | undefined,
): { mustChoose: boolean; staleChoice: boolean; showSwitcher: boolean } {
  const list = companies ?? []
  const chosen = !!activeId && list.some(c => c.landlordId === activeId)
  return {
    mustChoose: list.length >= 2 && !chosen,
    staleChoice: !!activeId && !chosen,
    showSwitcher: list.length >= 2,
  }
}

/** A company's name for the picker — its business name, else its parks' names; never a raw id. */
export function companyName(c: CompanyChoice, index: number): string {
  return (c.businessName && c.businessName.trim())
    || (c.propertyNames && c.propertyNames.trim())
    || `Company ${index + 1}`
}

const round2 = (n: number) => Math.round(n * 100) / 100
