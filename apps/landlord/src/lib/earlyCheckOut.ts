/**
 * 10/4 (decisions #37.B, #38) — the schedule's Check out window, display logic.
 *
 * The SERVER decides every figure and every choice (services/earlyCheckOut on
 * the API: what was booked, stayed and paid, which question, where a refund
 * goes back, what it costs the landlord). This file only turns that quote into
 * the lines and the one button the desk reads, so the window
 * (components/EarlyCheckOutModal) stays a thin shell. Pure; tested in
 * earlyCheckOut.test.ts.
 */

export type CheckoutChoice = 'keep_price' | 'nights_only' | 'no_refund' | 'refund_unused' | 'refund_other'

export interface CheckoutQuote {
  bookingId: string
  unitId: string
  unitNumber: string
  guest: string
  status: string
  today: string
  checkIn: string
  leftOn: string
  checkedOut: boolean
  early: boolean
  booked: { checkOut: string; nights: number; price: number }
  stayed: { checkOut: string; nights: number; worth: number }
  paid: number
  owedAsBooked: number
  lease: { id: string; endsOn: string; words: string } | null
  sources: Array<{ key: string; kind: string; label: string; paid: number; refundable: number }>
  question: 'none' | 'owes' | 'overpaid'
  unused: number
  maxRefund: number
  choices: Array<{
    choice: CheckoutChoice; label: string; result: string
    refund?: { amount: number; parts: Array<{ kind: string; label: string; amount: number; words: string }>; cost: string | null }
  }>
  canRefund: boolean
  canCheckOut?: boolean
  waitsForRefund: string | null
  /** For staff without "Check guests out" on a guest who still owes. */
  waitsForCheckOut?: string | null
  decision: null | {
    id: string; status: 'pending' | 'decided'; choice: CheckoutChoice | null; choiceLabel: string | null
    leftOn: string; decidedBy: string | null; decidedAt: string | null; refundTotal: number; priceAfter: number | null
    parts: Array<{ id: string; kind: string; label: string; amount: number; status: string; words: string; failure: string | null }>
  }
  quoteToken: string
}

export const money = (n: number): string =>
  `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 'YYYY-MM-DD' → "Oct 5" (no clock, no zone). */
export function dayWord(ymd: string): string {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const nights = (n: number) => `${n} night${n === 1 ? '' : 's'}`

/** The three plain lines: what was booked, what was stayed, what was paid. */
export function summaryLines(q: CheckoutQuote): { booked: string; stayed: string; paid: string } {
  const paidHow = q.sources.filter((s) => s.paid > 0.005).map((s) => s.label)
  return {
    booked: `Booked: to ${dayWord(q.booked.checkOut)} · ${nights(q.booked.nights)} · ${money(q.booked.price)}`,
    stayed: q.lease
      ? `Leaving ${dayWord(q.leftOn)} · the lease ends that day`
      : q.early
        ? `Stayed: ${nights(q.stayed.nights)} (left ${dayWord(q.leftOn)}) · worth ${money(q.stayed.worth)}`
        : `Leaving ${dayWord(q.leftOn)} · on or after the booked day`,
    paid: `Paid: ${money(q.paid)}${paidHow.length ? ` (${paidHow.join('; ')})` : ''}`,
  }
}

/** Typed money → a number with cents, or null for anything that is not one. */
export function parseMoney(raw: string): number | null {
  const s = String(raw ?? '').replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null
  const n = Math.round(Number(s) * 100) / 100
  return Number.isFinite(n) ? n : null
}

/** Whether the one button can be pressed yet. */
export function canConfirm(q: CheckoutQuote, choice: CheckoutChoice | null, typed: string): boolean {
  if (q.decision?.status === 'decided') return false
  // Only someone with "Check guests out" checks a guest out (fix round 2: a link reached this with "Issue refunds" alone).
  if (!q.checkedOut && q.canCheckOut === false) return false
  if (q.question === 'none') return !q.checkedOut
  if (q.question === 'overpaid' && !q.canRefund) return !q.checkedOut
  if (q.question === 'owes' && q.canCheckOut === false) return false
  if (!choice || !q.choices.some((c) => c.choice === choice)) return false
  if (choice === 'refund_other') {
    const n = parseMoney(typed)
    return n != null && n > 0 && n <= q.maxRefund + 0.005
  }
  return true
}

/** The amount a refund choice sends back, or null for a choice that sends none. */
export function refundAmountFor(q: CheckoutQuote, choice: CheckoutChoice | null, typed: string): number | null {
  if (choice === 'refund_unused') return q.choices.find((c) => c.choice === 'refund_unused')?.refund?.amount ?? null
  if (choice === 'refund_other') return parseMoney(typed)
  return null
}

/** The one gold button's words: it names the action. */
export function confirmLabel(q: CheckoutQuote, choice: CheckoutChoice | null, typed: string): string {
  const out = !q.checkedOut
  const amt = refundAmountFor(q, choice, typed)
  if (q.question === 'none' || (q.question === 'overpaid' && !q.canRefund) || !choice) {
    return out ? `Check out ${q.guest}` : 'Close'
  }
  const what = choice === 'keep_price' ? 'keep the price as booked'
    : choice === 'nights_only' ? `charge ${money(q.stayed.worth)}`
    : choice === 'no_refund' ? 'no refund'
    : `refund ${amt != null && amt > 0 ? money(amt) : 'the amount'}`
  if (out) return choice === 'no_refund' ? 'Check out — no refund' : `Check out and ${what}`
  return what.charAt(0).toUpperCase() + what.slice(1)
}

/** What the window says under the question when the money waits for someone else (who can refund, or who can check guests out). */
export function waitLine(q: CheckoutQuote): string | null {
  if (!q.checkedOut && q.canCheckOut === false) return q.waitsForCheckOut ?? null
  if (q.question === 'overpaid' && !q.canRefund) return q.waitsForRefund
  if (q.question === 'owes' && q.canCheckOut === false) return q.waitsForCheckOut ?? null
  return null
}

/** The done screen's lines: cash to hand back first and plain, then the rest (the server orders them). */
export function doneLines(words: string[]): { first: string | null; rest: string[] } {
  const cash = words.find((w) => /^Hand back .* in cash now\.?$/.test(w)) ?? null
  return { first: cash, rest: words.filter((w) => w !== cash) }
}

/** A refund part that failed — the one the window offers Try again on. */
export function failedPart(q: Pick<CheckoutQuote, 'decision'> | null): { id: string; words: string } | null {
  const p = q?.decision?.parts.find((x) => x.status === 'failed')
  return p ? { id: p.id, words: p.failure || p.words } : null
}

/**
 * Every refund part of an already-decided check-out that still has to go out
 * (failed at Stripe) — each gets its own Try again when the window is opened
 * later (from the schedule's Try again or the owner's to-do), for someone who
 * can issue refunds.
 */
export function retryParts(q: Pick<CheckoutQuote, 'decision' | 'canRefund'> | null): Array<{ id: string; words: string }> {
  if (!q?.canRefund || q.decision?.status !== 'decided') return []
  return q.decision.parts.filter((x) => x.status === 'failed').map((x) => ({ id: x.id, words: x.failure || x.words }))
}

/** The window's title: what it is for. */
export function windowTitle(q: Pick<CheckoutQuote, 'checkedOut' | 'decision'> | null): string {
  if (!q?.checkedOut) return 'Check out'
  return q.decision?.status === 'decided' ? 'Early check-out refund' : 'Decide the money'
}

/** A new key for one press of the window (a double click, or two windows, decide once). */
export function newKey(): string {
  const c: any = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
