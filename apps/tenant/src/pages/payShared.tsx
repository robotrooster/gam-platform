/**
 * Shared payment-method UI for the tenant portal — extracted in S171.
 *
 * S169 wired the rent Pay Now flow on /payments. S170 added the card
 * path. S171 extracts the shared pieces here so /utilities (utility
 * bills) and any future tenant-facing pay surfaces can reuse the same
 * picker + add-method modals without duplication.
 *
 * Surface:
 *   - useTenantPaymentMethods() — react-query hook over GET /stripe/tenant/payment-methods
 *   - <PayNowModal target={...} methods={...} ... /> — generic Pay flow
 *     parameterized by amount + endpoint + subheader + kind
 *   - <AddPaymentMethodModal method='ach'|'card' ... /> — Stripe
 *     Financial Connections (ACH) or card SetupIntent flow
 *   - <SavedMethodsCard methods={...} /> — every saved bank and card, with
 *     Make default and Remove (S655, keep the old bank)
 *   - Types: SavedPaymentMethod / SavedAch / SavedCard / PayTarget / LeaseBill
 *
 * Backend pricing math lives in services/stripeConnect.computePlatformCut.
 * Frontend never computes a fee and never types one: the fee shown before Pay
 * is the server's own quote (/payments/quote) for the way the tenant chose. No
 * list price is printed anywhere on these screens — a landlord who covers bank
 * fees, or a tenant-payer platform fee, makes any list price wrong for that
 * property.
 *
 * S655 (Nic, 10/2) — ACCOUNT CREDIT AT PAY TIME. The tenant sees the full
 * bill and, when credit could pay part of it, chooses: "Use all $X — pay $Y"
 * or "Save it for later — pay $Z". When the credit covers the whole bill there
 * is one button, "Pay with credit — nothing charged". The answer travels with
 * the credit figure the tenant was shown (expectedCredit); the server re-quotes
 * under its lock and answers 409 "Your credit changed — it's now $N" when it
 * moved. The screen then reads the bill again and asks again IN PLACE — the
 * modal never closes and never says "reload".
 */
import { useState, useEffect, useMemo } from 'react'
import { isValidRoutingNumber, microdepositInstruction, PROCESSING_FEES, type MicrodepositType } from '@gam/shared'
import { useQuery, useQueryClient } from 'react-query'
import { loadStripe, Stripe as StripeJs } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { formatCurrency } from '@gam/shared'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import {
  roundCents, owedOf, requiredOf, creditOffer, planCharges, creditSentence, creditWaitingSentence,
  creditRestSentence, creditOnFileOf, needsRunCreditWaiting, runOrder,
  type LeaseBill, type CreditMode, type ChargeLine, type RunCreditWaiting, type AwaitingCardConfirmation,
} from '../lib/payCredit'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise: Promise<StripeJs | null> | null = STRIPE_PK ? loadStripe(STRIPE_PK) : null

// ── TYPES ────────────────────────────────────────────────────────────────
// S655 (item L): each saved method carries ITS OWN state, read from Stripe
// (services/tenantBankMethods) — a tenant can now have more than one bank.
export interface SavedAch {
  id:       string
  type:     'ach'
  bankName: string | null
  last4:    string | null
  verified?: boolean   // S570: false = microdeposits still pending, not chargeable
  /** Waiting on the microdeposit step; it cannot be charged yet. */
  verifying?: boolean
  /** 'deposits' = waiting on the tenant to confirm; 'checking' = Stripe is checking what they entered. */
  verificationStep?: 'deposits' | 'checking' | null
  /** Verified, and bank payments are not paused on this account. */
  chargeable?: boolean
  isDefault?: boolean  // S571: the tenant's chosen default (ACH by default)
  autopayPinned?: boolean
  canRemove?: boolean
  /** Why it cannot be removed right now, with the next step — the same sentence the server refuses with. */
  removeBlockedReason?: string | null
}
export interface SavedCard {
  id:       string
  type:     'card'
  brand:    string | null
  last4:    string | null
  expMonth: number | null
  expYear:  number | null
  country:  string | null
  verified?: boolean
  verifying?: boolean
  verificationStep?: null
  chargeable?: boolean
  isDefault?: boolean
  autopayPinned?: boolean
  canRemove?: boolean
  removeBlockedReason?: string | null
}
export type SavedPaymentMethod = SavedAch | SavedCard

/** A card can be charged once saved; a bank only once verified and while bank payments are not paused. */
export function isChargeable(m: SavedPaymentMethod): boolean {
  if (m.type === 'card') return true
  if (m.chargeable != null) return m.chargeable
  return m.verified !== false && !m.verifying
}

export function methodLabel(m: SavedPaymentMethod): string {
  return m.type === 'ach'
    ? `${m.bankName ?? 'Bank'} ····${m.last4 ?? ''}`
    : `${(m.brand ?? 'Card').toUpperCase()} ····${m.last4 ?? ''}`
}

export interface PayTarget {
  amount:    number
  endpoint:  string  // e.g. '/payments/pay-balance'
  subheader: string  // displayed under the amount in the modal
  kind:      'rent' | 'utility'
  // S537: pay-balance sends the tenant-chosen amount in the body (FIFO
  // application server-side). Per-row endpoints ignore it.
  sendAmountInBody?: boolean
  /** S616: a payer with no lease settling their utility bill — every utility on
   *  the agreement, in one charge. */
  serviceAgreementId?: string
  // S581: pay-balance scopes the charge to one lease (each lease is its own
  // ACH/card charge + receipt). Sent when paying a specific lease's balance.
  leaseId?: string
  // S581 "Pay all": settle several leases with the ONE chosen method — each
  // entry becomes its own pay-balance charge (separate PI + receipt + capped
  // fee). When set, `amount` is the aggregate shown in the header; the per-lease
  // amounts come from the live bill (GET /payments/balance-context), falling
  // back to these while it loads. Overrides leaseId/sendAmountInBody.
  batch?: { leaseId: string; amount: number }[]
  // S609 pay-ahead (Nic): roughly what the balance plus the rest of the lease
  // term comes to — a SUGGESTION shown beside the box, never a limit. Present =
  // the amount box is offered. Absent = the old fixed-amount behavior, which is
  // what every non-rent target (a utility bill, a single charge) still wants.
  suggestedPayAhead?: number
  /** S622: the pay-in-full floor — the lease's own charges, excluding any
   *  carried-forward balance, which may be paid down in part. */
  requiredNow?: number
}

interface PayResponse {
  paymentIntentId: string
  status:          string
  /** decisions.md #48.4: with status 'requires_action' — what the bank's confirmation window needs. */
  clientSecret?:   string | null
  confirmBy?:      string | null
}

// The bill and the credit question — pure arithmetic over the server's quote,
// kept in lib/payCredit so the Payments page shows the same figures.
export type { LeaseBill, CreditOffer, CreditMode, ChargeLine } from '../lib/payCredit'

/** "Oct 20" from a date or 'YYYY-MM-DD', on the calendar day it names. */
function shortDay(v: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0]
  const d = ymd ? new Date(`${ymd}T12:00:00Z`) : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const errorText = (e: any, fallback: string): string =>
  e?.response?.data?.error?.message ||
  (typeof e?.response?.data?.error === 'string' ? e.response.data.error : null) ||
  e?.message ||
  fallback

/** A refusal that means the bill or the credit moved: read the bill again and ask again. */
const billMoved = (e: any): boolean => {
  const s = e?.response?.status
  return s === 409 || s === 422
}

/**
 * No answer, or the server broke after it was asked: the charge may have gone
 * through. Only a fresh read of the bill can say — never the figures on screen.
 */
const outcomeUnknown = (e: any): boolean => {
  const s = e?.response?.status
  return !s || s >= 500
}
export const OUTCOME_UNKNOWN_TEXT =
  'We couldn’t tell whether that payment went through, so we’re reading your bill again. Check it before you pay again.'

/**
 * After a payment whose answer was lost, how long to wait before the bill is
 * read again — and Pay stays off until a read STARTED after that lands.
 *
 * GET /payments/balance-context takes no household lock, so a read answered
 * while the lost charge is still being written (its bank or card charge is
 * created inside that write) shows the bill as it was before the charge. Pay
 * pressed on that bill would charge again: on a lease with an old balance the
 * server takes the second charge as the old balance plus paid-ahead credit, a
 * second fee. Waiting out the write closes that on this screen. The lasting
 * guard is one key per Pay press that the server answers once (Step 8,
 * services/rentCharge + /pay-balance); until then, this.
 *
 * An object so the tests can shorten it.
 */
export const LOST_ANSWER_WAIT = { ms: 10_000 }

/**
 * GET /payments/balance-context, stamped with the moment the read STARTED
 * (`readStartedAt`, ms). Every 'balance-context' query in the app reads through
 * this, so whichever screen's read lands, the pay screen can tell a read that
 * left before a lost charge could have been written from one that left after —
 * a read's arrival time cannot (one that started during the wait may land
 * after it).
 */
export function readBalanceContext<T = any>(): Promise<T> {
  const readStartedAt = Date.now()
  return apiGet<any>('/payments/balance-context')
    .then((d) => (d && typeof d === 'object' ? { ...d, readStartedAt } : d))
}

/**
 * What happens next when a card's bank wants the payment confirmed and the
 * screen could not show the bank's window (decisions.md #48.4: normally it is
 * shown on the spot, and a held payment's own Confirm button is shown with the
 * bill). Names no control: the bill is held for that payment only for a short
 * while, then opens again by itself.
 */
export const REQUIRES_ACTION_NEXT =
  'If it isn’t confirmed within 30 minutes, it’s canceled by itself and your bill opens again to pay.'

/** Said when the card's bank did not confirm the payment; the bill is open again. */
export const CARD_NOT_CONFIRMED_TEXT =
  'Your card’s bank didn’t confirm the payment, so nothing was charged and your bill is open again. Try again, or pay with your bank account.'

/** Said when the card's bank refused the payment itself after it was confirmed (a decline); the bill is open again. */
export const CARD_DECLINED_TEXT =
  'Your card was declined, so nothing was charged and your bill is open again. Try another card, or pay with your bank account.'

/** Said when the bank's window could not be shown here (Stripe.js did not load). */
export const CARD_CONFIRM_UNAVAILABLE_TEXT =
  'We couldn’t show your card’s bank’s confirmation here, so nothing was charged and your bill is open again. Pay with your bank account, or try again in a minute.'

/** Said when the payment could not be canceled just now; it is released by itself. */
export const CARD_RELEASE_LATER_TEXT =
  'Your card’s bank didn’t confirm the payment, so nothing was charged. We couldn’t open your bill again just now — it opens again by itself within 30 minutes.'

/** CARD_RELEASE_LATER_TEXT for a card its bank declined. */
export const CARD_DECLINED_LATER_TEXT =
  'Your card was declined, so nothing was charged. We couldn’t open your bill again just now — it opens again by itself within 30 minutes.'

/**
 * decisions.md #48.4: the card's bank wants the cardholder to confirm the
 * payment (3-D Secure). Stripe.js shows the bank's window right here. An
 * object so the tests can stand in for Stripe.js.
 */
export const CARD_CONFIRM = {
  handleNextAction: async (clientSecret: string): Promise<CardConfirmOutcome> => {
    const stripe = stripePromise ? await stripePromise : null
    if (!stripe) return { status: null, failed: true, unavailable: true }
    const r: any = await stripe.handleNextAction({ clientSecret })
    const pi = r?.paymentIntent ?? null
    if (r?.error || !pi) return { status: pi?.status ?? null, failed: true, declined: declinedByCardBankError(r?.error) }
    return { status: pi.status, failed: false }
  },
}

/** What the bank's window came back with. `declined`: the card's bank refused the payment itself. */
type CardConfirmOutcome = { status: string | null; failed: boolean; unavailable?: boolean; declined?: boolean }

/**
 * Stripe.js's error from the bank's window, read the way the server reads a
 * charge (jobs/paymentReconcile declinedByCardBank): a card error other than
 * a failed or abandoned confirmation ('payment_intent_authentication_failure')
 * is the card's bank declining the payment after the cardholder confirmed it.
 * Read here, as it happens — Stripe clears it once the charge is canceled.
 */
export function declinedByCardBankError(err: { type?: string; code?: string } | null | undefined): boolean {
  if (!err || err.type !== 'card_error') return false
  return !!err.code && err.code !== 'payment_intent_authentication_failure'
}

/** A card payment its bank did not confirm (the bill was opened again, or will be by itself). */
class CardNotConfirmed extends Error {}

/**
 * Show the bank's window for a card payment waiting on it. Confirmed: the
 * card's status ('succeeded' or 'processing'). Not confirmed: the payment is
 * canceled at once (POST /payments/pay-balance/release) so the bill is open
 * again, and CardNotConfirmed is thrown with what to say — unless it went
 * through after all, which counts as confirmed.
 */
async function confirmCardOnScreen(clientSecret: string, paymentIntentId: string): Promise<string> {
  let outcome: CardConfirmOutcome
  try {
    outcome = await CARD_CONFIRM.handleNextAction(clientSecret)
  } catch {
    outcome = { status: null, failed: true, unavailable: true }
  }
  if (!outcome.failed && (outcome.status === 'succeeded' || outcome.status === 'processing')) return outcome.status
  // The bank confirmed the cardholder, then refused the payment itself: as
  // the bank's window said it, or as the server recorded it.
  let declined = outcome.declined === true
  try {
    const res = await apiPost<any>('/payments/pay-balance/release', { paymentIntentId })
    const data = (res as any)?.data ?? res
    if (data?.outcome === 'went_through') return 'processing'
    declined = declined || data?.declined === true
  } catch {
    throw new CardNotConfirmed(declined ? CARD_DECLINED_LATER_TEXT : CARD_RELEASE_LATER_TEXT)
  }
  throw new CardNotConfirmed(declined ? CARD_DECLINED_TEXT
    : outcome.unavailable ? CARD_CONFIRM_UNAVAILABLE_TEXT : CARD_NOT_CONFIRMED_TEXT)
}

/** "3:45 PM" from an ISO moment, in the viewer's own time. */
function clockTime(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
}

/** Said when a charge's outcome is not one of the plain cases below. */
const PAYMENT_SENT_TEXT = 'Payment sent. Where it stands shows in your payment history.'

/**
 * What the screen says once the charges are sent — in plain words, never the
 * processor's status value. `statuses` are the money charges' (a charge that
 * credit paid in full is counted in `creditOnly`, not here).
 */
export function paidText(type: 'ach' | 'card' | null, statuses: (string | undefined)[], creditOnly = 0): string {
  const n = statuses.length
  if (n === 0) return 'Paid with your account credit — nothing was charged.'
  const tail = creditOnly > 0
    ? ` ${creditOnly === 1 ? 'One lease was' : `${creditOnly} leases were`} paid with your account credit — nothing charged on ${creditOnly === 1 ? 'it' : 'them'}.`
    : ''
  const has = (s: string) => statuses.includes(s)
  if (type === 'card') {
    // The card's bank wants the cardholder to confirm (3-D Secure). Nothing is
    // taken until it does. The screen normally shows the bank's window on the
    // spot (confirmCardOnScreen); this is said only when it could not (no
    // client secret came back, or the bank's window could not be opened), so
    // it says what happens next.
    if (has('requires_action')) {
      return `Your card’s bank wants to confirm ${n > 1 ? 'a payment' : 'this payment'} before it goes through — nothing has been charged for it yet.${tail} ${REQUIRES_ACTION_NEXT}`
    }
    if (has('processing')) {
      return n > 1
        ? `Your card payments are processing. We’ll email your receipts when they go through.${tail}`
        : `Your card payment is processing. We’ll email your receipt when it goes through.${tail}`
    }
    if (statuses.every((s) => !s || s === 'succeeded')) {
      return `${n > 1 ? `All ${n} leases charged. Receipts emailed.` : 'Card charged. Receipt emailed.'}${tail}`
    }
    return `${PAYMENT_SENT_TEXT}${tail}`
  }
  if (statuses.every((s) => !s || s === 'processing' || s === 'requires_action' || s === 'succeeded')) {
    return `${n > 1 ? `All ${n} payments submitted.` : 'Payment submitted.'} ACH typically settles in 3–5 business days.${tail}`
  }
  return `${PAYMENT_SENT_TEXT}${tail}`
}

// ── A card payment waiting on its bank (decisions.md #48.4) ───────────────

/**
 * How "Payments you've made" names a card payment's state where the plain
 * status would mislead: one still waiting on its card's bank ("Processing"
 * beside "nothing has been charged yet"), and one canceled before anything
 * was charged (a red "Failed" for a payment the tenant canceled on purpose).
 */
export const CARD_HISTORY_STATE_VALUES = ['waiting_on_bank', 'canceled_nothing_charged', 'declined_nothing_charged'] as const
export type CardHistoryState = typeof CARD_HISTORY_STATE_VALUES[number]
export const CARD_HISTORY_STATE_LABEL: Record<CardHistoryState, string> = {
  waiting_on_bank: 'Waiting on your bank',
  canceled_nothing_charged: 'Canceled — nothing charged',
  declined_nothing_charged: 'Declined — nothing charged',
}

/**
 * Everything on the page a released or confirmed card payment changes: the
 * bill, its history ("Payments you've made"), the charges list and the price
 * quotes — so no part still shows it as waiting or clearing.
 */
export async function rereadAfterCardPayment(qc: { invalidateQueries: (key: string, f?: any, o?: any) => Promise<unknown> | void }): Promise<void> {
  await Promise.all([
    qc.invalidateQueries('balance-context', undefined, { cancelRefetch: true }),
    qc.invalidateQueries('remittances', undefined, { cancelRefetch: true }),
    qc.invalidateQueries('payments', undefined, { cancelRefetch: true }),
    qc.invalidateQueries('charge-quote', undefined, { cancelRefetch: true }),
  ])
}

/** Said when a held card payment is already canceled (the sweep or another screen got there first). */
export const CARD_ALREADY_RELEASED_TEXT = 'That payment was already canceled — nothing was charged and your bill is open to pay.'

/** Said when Confirm comes after the time the screen showed: the server canceled it just now. */
export const CARD_EXPIRED_TEXT = 'That payment wasn’t confirmed in time, so it was canceled — nothing was charged and your bill is open to pay.'

/** Said when Cancel releases a payment its bank had not confirmed. */
export const CARD_CANCELED_TEXT = 'Canceled — nothing was charged. Your bill is open to pay.'

/**
 * Why a held card payment the payer picked up again (POST
 * /payments/pay-balance/resume) is already released — as the server says it,
 * never guessed from the clock: declined by the card's bank, canceled just
 * now because the time ran out, or already canceled (another tab, the sweep).
 */
export function releasedOnResumeText(data: { declined?: boolean; expired?: boolean } | null | undefined): string {
  if (data?.declined) return CARD_DECLINED_TEXT
  if (data?.expired) return CARD_EXPIRED_TEXT
  return CARD_ALREADY_RELEASED_TEXT
}

/**
 * What to say when Confirm or Cancel on a held card payment fails. The
 * server's own words for a refusal it explained (4xx with a message); a 404
 * means it is already canceled; anything else (no answer, a server error) the
 * written next step — never the browser's or the HTTP library's text.
 */
export function awaitingErrorText(e: any, fallback: string): string {
  const status = e?.response?.status
  if (status === 404) return CARD_ALREADY_RELEASED_TEXT
  if (status >= 400 && status < 500) {
    const m = e?.response?.data?.error?.message
      || (typeof e?.response?.data?.error === 'string' ? e.response.data.error : null)
    if (m) return m
  }
  return fallback
}

const CANCEL_LATER_TEXT =
  'That payment couldn’t be canceled just now. It is canceled by itself within 30 minutes, and your bill opens again.'

/**
 * Card payments held while their card's bank asks the cardholder to confirm
 * them (GET /payments/balance-context: leases[].awaitingConfirmation,
 * serviceAgreements[].awaitingConfirmation, or awaitingCardConfirmations for
 * the whole page). The payer gets "Confirm with your bank" (the bank's window,
 * again) and "Cancel it and pay another way"; the rest of the household is
 * told whose card's bank it waits on, and when the bill opens again by itself.
 * Every answer reads the bill again. `where` names the bill a payment holds
 * (the Payments page, which can list more than one); without it the payment is
 * "on this bill" (the pay window, which shows one bill).
 */
export function AwaitingCardPayments({ items, onBusy, where }: {
  items: AwaitingCardConfirmation[]; onBusy?: () => void
  where?: (a: AwaitingCardConfirmation) => string | null
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  // Which button is working: Confirm says "Waiting on your bank…", Cancel "Canceling…".
  const [canceling, setCanceling] = useState(false)
  const [note, setNote] = useState<{ text: string; tone: 'warn' | 'ok' } | null>(null)
  const done = async () => {
    setBusy(null); setCanceling(false)
    await rereadAfterCardPayment(qc)
  }
  const confirm = async (a: AwaitingCardConfirmation) => {
    setBusy(a.paymentIntentId); setNote(null); onBusy?.()
    try {
      const res = await apiPost<any>('/payments/pay-balance/resume', { paymentIntentId: a.paymentIntentId })
      const data = (res as any)?.data ?? res
      if (data?.outcome === 'went_through') {
        setNote({ text: 'That card payment went through after all — it isn’t owed again.', tone: 'ok' })
        return
      }
      if (data?.outcome === 'released') {
        setNote({ text: releasedOnResumeText(data), tone: data?.declined ? 'warn' : 'ok' })
        return
      }
      if (!data?.clientSecret) {
        setNote({ text: 'This payment can no longer be confirmed. Cancel it and pay another way.', tone: 'warn' })
        return
      }
      const status = await confirmCardOnScreen(data.clientSecret, a.paymentIntentId)
      setNote({ text: paidText('card', [status]), tone: 'ok' })
    } catch (e: any) {
      setNote(e instanceof CardNotConfirmed
        ? { text: e.message, tone: 'warn' }
        : { text: awaitingErrorText(e, 'We couldn’t reach your card’s bank just now. Nothing was charged — try Confirm again in a minute, or cancel it and pay another way.'), tone: 'warn' })
    } finally {
      await done()
    }
  }
  const cancel = async (a: AwaitingCardConfirmation) => {
    setBusy(a.paymentIntentId); setCanceling(true); setNote(null); onBusy?.()
    try {
      const res = await apiPost<any>('/payments/pay-balance/release', { paymentIntentId: a.paymentIntentId })
      const data = (res as any)?.data ?? res
      // The history row reads "Declined — nothing charged" for a payment its
      // card's bank refused; this note says the same.
      setNote(data?.outcome === 'went_through'
        ? { text: 'That card payment went through after all — it isn’t owed again.', tone: 'ok' }
        : data?.declined === true
          ? { text: CARD_DECLINED_TEXT, tone: 'warn' }
          : { text: CARD_CANCELED_TEXT, tone: 'ok' })
    } catch (e: any) {
      setNote({ text: awaitingErrorText(e, CANCEL_LATER_TEXT), tone: e?.response?.status === 404 ? 'ok' : 'warn' })
    } finally {
      await done()
    }
  }
  if (items.length === 0 && !note) return null
  return (
    <>
      {items.length > 0 && (
        <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
          {items.map((a) => {
            const mine = a.mine !== false
            const at = clockTime(a.confirmBy)
            // Whose card's bank it waits on, named once. A payer with no name
            // on file reads naturally too.
            const whoseBank = a.payerName ? `${a.payerName}'s card's bank` : "another household member's card's bank"
            const bill = where?.(a) ?? null
            return (
              <div key={a.paymentIntentId} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '.82rem', color: 'var(--t1)', lineHeight: 1.5, marginBottom: mine ? 8 : 0 }}>
                  {!mine
                    ? <>A card payment of {formatCurrency(a.amount)} {bill ? <>for {bill}</> : 'on this bill'} is waiting on {whoseBank} to confirm it. Nothing has been charged yet.{at ? <> If it isn&apos;t confirmed by {at}, it&apos;s canceled by itself and the bill opens again.</> : null}</>
                    : a.canConfirm
                      ? <>A card payment of {formatCurrency(a.amount)}{bill ? <> for {bill}</> : null} is waiting for your card&apos;s bank to confirm it. Nothing has been charged yet.{at ? <> If it isn&apos;t confirmed by {at}, it&apos;s canceled by itself and your bill opens again.</> : null}</>
                      : <>Your card&apos;s bank didn&apos;t confirm a card payment of {formatCurrency(a.amount)}{bill ? <> for {bill}</> : null}, so nothing was charged. Cancel it to pay another way{at ? <> — otherwise your bill opens again by itself at {at}</> : null}.</>}
                </div>
                {mine && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {a.canConfirm && (
                      <button className="btn btn-p" style={{ width: '100%' }} disabled={busy != null}
                        onClick={() => { void confirm(a) }}>
                        {busy === a.paymentIntentId && !canceling ? 'Waiting on your bank…' : 'Confirm with your bank'}
                      </button>
                    )}
                    <button className="btn btn-p" style={{ width: '100%' }} disabled={busy != null}
                      onClick={() => { void cancel(a) }}>
                      {busy === a.paymentIntentId && canceling ? 'Canceling…' : 'Cancel it and pay another way'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {note && (
        <div className={note.tone === 'warn' ? 'alert a-warn' : 'alert a-green'} style={{ marginBottom: 12, fontSize: '.8rem', lineHeight: 1.5 }}>
          {note.text}
        </div>
      )}
    </>
  )
}

// ── HOOK ─────────────────────────────────────────────────────────────────
export function useTenantPaymentMethods() {
  return useQuery<SavedPaymentMethod[]>(
    'tenant-payment-methods',
    () => apiGet<SavedPaymentMethod[]>('/stripe/tenant/payment-methods'),
  )
}

// ── SAVED METHODS CARD ───────────────────────────────────────────────────
// S655 (Nic, item L): "Adding never removes; new verified bank becomes
// default; old stays until the tenant deletes it; delete blocked while it is
// their only verified bank, EXCEPT when nothing is owed and autopay is off."
// Every bank is listed with where it stands. Remove asks once, in place; when
// the server would refuse, the screen says why before anything is sent (the
// same sentence the refusal carries), and a refusal that arrives anyway is
// shown once with the list read again.
export function SavedMethodsCard({
  methods,
  loading,
  emptyCopy,
}: {
  methods:    SavedPaymentMethod[]
  loading:    boolean
  emptyCopy?: React.ReactNode
}) {
  const qc = useQueryClient()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // One message at a time: under the method it is about, or ('') for the card.
  const [notice, setNotice] = useState<{ id: string; text: string; tone: 'warn' | 'ok' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () => {
    qc.invalidateQueries('tenant-payment-methods')
    // A removed bank an autopay schedule named falls back to the default.
    qc.invalidateQueries('autopay')
  }

  const makeDefault = async (m: SavedPaymentMethod) => {
    setBusyId(m.id); setNotice(null); setConfirmId(null)
    try {
      await apiPatch('/stripe/tenant/default-payment-method', { paymentMethodId: m.id })
    } catch (e: any) {
      setNotice({ id: m.id, text: errorText(e, 'That could not be made your default. Try again in a minute.'), tone: 'warn' })
    } finally {
      setBusyId(null)
      refresh()
    }
  }

  const askRemove = (m: SavedPaymentMethod) => {
    setNotice(null)
    if (m.canRemove === false) {
      setConfirmId(null)
      setNotice({ id: m.id, text: m.removeBlockedReason || 'This can’t be removed right now.', tone: 'warn' })
      return
    }
    setConfirmId(m.id)
  }

  const remove = async (m: SavedPaymentMethod) => {
    setBusyId(m.id); setNotice(null)
    try {
      const r = await apiDelete<{ removedId: string; methods: SavedPaymentMethod[] }>(
        `/stripe/tenant/payment-methods/${encodeURIComponent(m.id)}`)
      if (Array.isArray(r?.methods)) qc.setQueryData('tenant-payment-methods', r.methods)
      setConfirmId(null)
      setNotice({ id: '', text: `${methodLabel(m)} was removed.`, tone: 'ok' })
    } catch (e: any) {
      setConfirmId(null)
      setNotice({ id: m.id, text: errorText(e, 'That could not be removed just now. Nothing changed — try again in a minute.'), tone: 'warn' })
    } finally {
      setBusyId(null)
      refresh()
    }
  }

  if (loading) return null
  if (!methods.length) {
    // S570 (Nic): no redundant "add a method" banner — the header already has
    // + Add bank / + Add card, and signup prompts for a method. Show nothing
    // unless a caller passes explicit emptyCopy.
    if (notice?.id === '' ) {
      return <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--green)' }}>{notice.text}</div>
    }
    if (!emptyCopy) return null
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--t2)' }}>
        {emptyCopy}
      </div>
    )
  }
  return (
    <div className="card" style={{ padding: 14, marginTop: 16 }}>
      <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 8 }}>Saved payment methods</div>
      {notice?.id === '' && (
        <div style={{ fontSize: '.78rem', color: notice.tone === 'ok' ? 'var(--green)' : 'var(--amber)', marginBottom: 8 }}>
          {notice.text}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {methods.map((m) => {
          const deposits = m.type === 'ach' && (m.verificationStep === 'deposits' || (m.verifying && m.verificationStep == null) || (m.verified === false && !m.verifying && m.verificationStep == null))
          const checking = m.type === 'ach' && m.verificationStep === 'checking'
          const paused = m.type === 'ach' && !deposits && !checking && m.chargeable === false
          const canDefault = !m.isDefault && !deposits && !checking && (m.type === 'card' || m.verified !== false) && isChargeable(m)
          const busy = busyId === m.id
          return (
            <div key={m.id}>
              <div
                style={{
                  display:        'flex',
                  justifyContent: 'space-between',
                  alignItems:     'center',
                  flexWrap:       'wrap',
                  gap:            8,
                  fontSize:       '.85rem',
                  color:          'var(--t1)',
                }}
              >
                <span>{m.type === 'ach' ? `🏦 ${methodLabel(m)}` : `💳 ${methodLabel(m)}`}</span>
                <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  {deposits && (
                    <span className="badge b-amber" style={{ fontSize: '.7rem' }} title="Confirm the small deposit we sent to your bank to finish verifying it.">
                      Waiting on your deposits
                    </span>
                  )}
                  {checking && (
                    <span className="badge b-muted" style={{ fontSize: '.7rem' }} title="We received what you entered and are checking it. Nothing more to do.">
                      Being checked
                    </span>
                  )}
                  {paused && (
                    <span className="badge b-red" style={{ fontSize: '.7rem' }}>Bank payments paused</span>
                  )}
                  {m.autopayPinned && (
                    <span className="badge b-muted" style={{ fontSize: '.7rem' }}>Autopay uses this</span>
                  )}
                  {m.isDefault ? (
                    <span className="badge b-green" style={{ fontSize: '.7rem' }}>✓ Default</span>
                  ) : canDefault ? (
                    <button className="btn btn-p btn-sm" disabled={busy} onClick={() => makeDefault(m)} title="Use this method by default" aria-label={`Make ${methodLabel(m)} my default`}>
                      Make default
                    </button>
                  ) : null}
                  <span className="badge b-muted" style={{ fontSize: '.7rem' }}>
                    {m.type === 'ach' ? 'Bank' : 'Card'}
                  </span>
                  {confirmId !== m.id && (
                    <button className="btn btn-p btn-sm" disabled={busy} onClick={() => askRemove(m)} aria-label={`Remove ${methodLabel(m)}`}>
                      Remove
                    </button>
                  )}
                </span>
              </div>
              {confirmId === m.id && (
                <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--b1)', borderRadius: 8, fontSize: '.8rem', color: 'var(--t1)' }}>
                  <div style={{ marginBottom: 8 }}>
                    Remove {methodLabel(m)}? You can add it again later.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-p btn-sm" disabled={busy} onClick={() => remove(m)} aria-label={`Yes, remove ${methodLabel(m)}`}>
                      {busy ? 'Removing…' : 'Remove'}
                    </button>
                    <button className="btn btn-g btn-sm" disabled={busy} onClick={() => setConfirmId(null)}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}
              {notice && notice.id === m.id && (
                <div className="alert a-warn" style={{ marginTop: 8, fontSize: '.78rem', lineHeight: 1.5 }}>
                  {notice.text}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: '.68rem', color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
        Adding a bank keeps the ones you have until you remove them; a new bank becomes your default once
        it&apos;s verified. Adding a card replaces the card on file. Bank is used by default — switch to a card
        only if you want to (card fees apply).
      </div>
    </div>
  )
}

// ── PAY NOW MODAL ────────────────────────────────────────────────────────
export function PayNowModal({
  target,
  methods,
  onClose,
  onAddMethod,
  onPaid,
}: {
  target:      PayTarget
  methods:     SavedPaymentMethod[]
  onClose:     () => void
  onAddMethod: (m: 'ach' | 'card') => void
  onPaid:      () => void
}) {
  const qc = useQueryClient()
  const achMethods  = methods.filter((m): m is SavedAch  => m.type === 'ach')
  const cardMethods = methods.filter((m): m is SavedCard => m.type === 'card')
  // S570/S655: a bank still verifying — or with bank payments paused — can't be
  // charged: don't pre-select it, badge it, and block Pay if it's chosen.
  const payable    = methods.filter(isChargeable)
  // S571: pre-select the tenant's default method (ACH by default).
  const initialId  = payable.find((m) => m.isDefault)?.id ?? payable[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState<string>(initialId)
  useEffect(() => {
    // Methods that load (or change) after the modal opened: pick the default.
    if (!selectedId || !payable.some((m) => m.id === selectedId)) {
      const next = payable.find((m) => m.isDefault)?.id ?? payable[0]?.id ?? ''
      if (next !== selectedId) setSelectedId(next)
    }
  }, [payable.map((m) => m.id).join(','), selectedId])

  // ── The live bill (S655). The same cache the Payments page reads, so a
  // refusal that moved the bill updates both — and this modal re-offers in
  // place with the figures as they are now.
  const leaseIds = target.batch?.length ? target.batch.map((b) => b.leaseId)
    : target.leaseId ? [target.leaseId] : []
  const isLeaseBill = leaseIds.length > 0 && !target.serviceAgreementId
  const { data: ctx, isFetching: billFetching, refetch: readBillAgain } =
    useQuery<{
      leases?: LeaseBill[]; readStartedAt?: number
      serviceAgreements?: { serviceAgreementId: string; awaitingConfirmation?: AwaitingCardConfirmation[] }[]
    }>(
      'balance-context', () => readBalanceContext(), { enabled: isLeaseBill })
  // After a failed payment, Pay stays off until a read of the bill that
  // started at or after this moment has landed: a charge whose answer was lost
  // may have gone through, and only the server's bill can say what is still
  // owed (S655 review: a second press on the old figures charged twice).
  // Right away after a refusal (the server answered and wrote nothing);
  // LOST_ANSWER_WAIT later after a lost answer.
  const [readAfter, setReadAfter] = useState<number | null>(null)
  // Waiting out LOST_ANSWER_WAIT; the read that may unlock Pay starts when it ends.
  const [waitingOut, setWaitingOut] = useState(false)
  useEffect(() => {
    if (readAfter == null) { setWaitingOut(false); return }
    const ms = readAfter - Date.now()
    setWaitingOut(ms > 0)
    if (ms <= 0) return
    const t = setTimeout(() => {
      setWaitingOut(false)
      // Cancels any read still on its way (it started before readAfter), so the
      // bill that lands next is one read after the wait.
      void readBillAgain({ cancelRefetch: true })
    }, ms)
    return () => clearTimeout(t)
  }, [readAfter])
  // Unlocked only by a read that STARTED at or after readAfter — never by one
  // that merely landed after it (a read that left during the wait, say a
  // refetch on focus, shows the bill from before the lost charge was written).
  const billStale = isLeaseBill && readAfter != null && (waitingOut || !((ctx?.readStartedAt ?? -Infinity) >= readAfter))
  const bills: LeaseBill[] = useMemo(() => {
    if (!isLeaseBill) return []
    const live = ctx?.leases
    if (live) {
      return leaseIds
        .map((id) => live.find((l) => l.leaseId === id))
        .filter((l): l is LeaseBill => !!l && !l.paymentBlocked && (owedOf(l) > 0 || (l.usableCredit ?? 0) > 0))
    }
    // While the bill loads: the figures the page opened with.
    return target.batch?.length
      ? target.batch.map((b) => ({ leaseId: b.leaseId, outstanding: b.amount }))
      : [{ leaseId: target.leaseId!, outstanding: target.amount, requiredNow: target.requiredNow,
           carriedBalance: target.requiredNow != null ? roundCents(Math.max(0, target.amount - target.requiredNow)) : undefined,
           suggestedPayAhead: target.suggestedPayAhead }]
  }, [ctx, isLeaseBill, leaseIds.join(','), target.amount, target.requiredNow])
  // A lease asked for here whose payments are paused (eviction hold): it is
  // never charged, and the screen says so rather than "nothing is owed".
  const pausedHere: LeaseBill[] = isLeaseBill && ctx?.leases
    ? leaseIds.map((id) => ctx.leases!.find((l) => l.leaseId === id))
        .filter((l): l is LeaseBill => !!l && !!l.paymentBlocked && owedOf(l) > 0)
    : []
  // Money already paid on these bills and still clearing (a bank payment on its
  // way): not owed again. Read from every lease asked for here, including one
  // with nothing left to pay — after a lost answer it is how the tenant sees
  // that the charge went through.
  const clearingHere = isLeaseBill && ctx?.leases
    ? roundCents(leaseIds.reduce((s, id) =>
        s + Math.max(0, Number(ctx.leases!.find((l) => l.leaseId === id)?.clearing ?? 0)), 0))
    : 0
  // Nothing is offered until the live bill is in: a Pay pressed on the figures
  // the page opened with could answer a credit question nobody was asked.
  const loadingBill = isLeaseBill && !ctx?.leases
  const isBatch = !!target.batch?.length
  const single = !isBatch && bills.length === 1 ? bills[0] : null
  const offer = creditOffer(bills)
  const creditAsked = offer.usable > 0
  // One bill: its credit on file; "Pay all" the server sequenced: the run's.
  const onFile = isLeaseBill ? creditOnFileOf(bills) : null
  const several = bills.length > 1
  // Fix pass 3: bills that are not the run the server sequenced ask the server
  // for their own run's held-credit figure (one figure, never the bills' added
  // up, never just the largest).
  const askRun = isLeaseBill && needsRunCreditWaiting(bills)
  const runIds = askRun ? runOrder(bills) : []
  const { data: askedRun } = useQuery<RunCreditWaiting | null>(
    ['pay-run-credit-waiting', runIds.join(','), ctx?.readStartedAt ?? null],
    () => apiPost<any>('/payments/quote', { method: 'ach', runLeaseIds: runIds })
      .then((res: any) => (res?.data ?? null) as RunCreditWaiting | null),
    { enabled: askRun, staleTime: 0, retry: false })
  // 10/4: credit another bank payment still holds is left alone; say so.
  const waitingText = isLeaseBill ? creditWaitingSentence(bills, askRun ? askedRun ?? null : null) : null
  // Fix pass 3: where the rest of the credit on file goes (one bill, or the
  // run "Pay all" sends), so every dollar of "You have $X credit" is explained.
  const restText = isLeaseBill ? creditRestSentence(bills) : null

  const [mode, setMode] = useState<CreditMode | null>(null)
  // The credit figure the answer was given against: a bill re-read with another
  // figure asks again.
  const [answeredAt, setAnsweredAt] = useState<number | null>(null)
  const chosen: CreditMode | null = creditAsked && mode && answeredAt === offer.usable ? mode : null

  // S609: what the tenant is actually paying. Starts at their balance — the
  // common case is still "pay what I owe" and that must stay one click. Typing
  // a bigger number pays future months ahead. Only when the credit is saved
  // (or there is none): with credit used the money is exactly what is left.
  // `fullAmount` is everything owed, the old balance included ("Just what I
  // owe"); with the credit saved the box starts at the figure the "Save it for
  // later" button named — the bill — and the old balance is one press away.
  const fullAmount = isLeaseBill ? offer.balance : target.amount
  const startAmount = isLeaseBill && chosen === 'save' ? offer.payIfSaved : fullAmount
  const canPayAhead = !isBatch && (single?.suggestedPayAhead ?? target.suggestedPayAhead) != null
    && chosen !== 'use'
  const [amount, setAmount] = useState<number>(startAmount)
  const [amountText, setAmountText] = useState<string>(startAmount.toFixed(2))
  const [amountTouched, setAmountTouched] = useState(false)
  useEffect(() => {
    // The bill moved under the box (re-read after a refusal), or the credit was
    // answered: start it over unless the tenant typed their own figure.
    if (!amountTouched) { setAmount(startAmount); setAmountText(startAmount.toFixed(2)) }
  }, [startAmount])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  // A card its bank wants confirmed: nothing was charged, and the screen stays
  // open on what to do next rather than closing on its own.
  const [awaitingBank, setAwaitingBank] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const selectedMethod = methods.find((m) => m.id === selectedId)
  const selectedType   = selectedMethod?.type ?? null
  const selectedBlocked = selectedMethod ? !isChargeable(selectedMethod) : false
  // A bank still verifying stands at one of two steps: waiting on the tenant to
  // confirm the small deposit, or being checked by Stripe (nothing to do).
  const bankWaitingOnDeposits = achMethods.some((m) => !isChargeable(m) && m.verificationStep !== 'checking'
    && (m.verifying || m.verified === false))
  const bankBeingChecked = achMethods.some((m) => !isChargeable(m) && m.verificationStep === 'checking')

  // What each lease is charged for the answer given (or about to be).
  const lines: ChargeLine[] = !isLeaseBill ? []
    : planCharges(bills, creditAsked ? chosen : null,
        single && canPayAhead ? () => amount : undefined)
  const creditOnly = isLeaseBill && lines.length > 0 && lines.every((x) => x.creditOnly)
  const moneyTotal = isLeaseBill ? roundCents(lines.reduce((s, x) => s + x.amount, 0)) : amount

  // S601 (Nic): pre-charge fee disclosure. Fetch the EXACT total for the selected
  // method so the tenant sees "$rent + $fee = $total" before paying — never blindside
  // them with a card surcharge. "Pay all" quotes each lease's own charge and adds
  // them up (each is its own charge with its own fee). Re-fetches when the method,
  // the credit answer or the amount changes.
  //
  // Every quote carries the key it was asked for. Pay names and charges only a
  // quote for what is on screen NOW: the moment the method, the amount or the
  // answer changes, the old quote is dropped and Pay waits for the new one —
  // a bank figure is never shown (or charged against) under a selected card.
  const [quote, setQuote] = useState<
    { key: string; base: number; fee: number; total: number; method: 'ach' | 'card'; intlCardSurcharge: boolean
      /** With a card chosen: the server's fee for paying the same charges by bank (null = not known). */
      bankFee?: number | null } | null
  >(null)
  // The key whose quote could not be fetched (Try again asks again).
  const [quoteFailedKey, setQuoteFailedKey] = useState<string | null>(null)
  const [quoteTry, setQuoteTry] = useState(0)
  const quoteKey = JSON.stringify([selectedType, loadingBill, chosen, creditAsked, offer.coversWholeBill,
    lines.map((x) => [x.leaseId, x.amount, !!x.useCredit, x.creditOnly, (x.afterLeaseIds ?? []).join(',')]),
    isLeaseBill ? null : amount, target.serviceAgreementId ?? null])
  const quoteAskable = (() => {
    const askable = isLeaseBill ? lines.filter((x) => !x.creditOnly) : []
    const waitingOnAnswer = creditAsked && !chosen && !offer.coversWholeBill
    return !!selectedType && !loadingBill && !waitingOnAnswer && (isLeaseBill ? askable.length > 0 : amount > 0)
  })()
  const quoteReady = quote != null && quote.key === quoteKey
  const quoteFailed = !quoteReady && quoteFailedKey === quoteKey
  useEffect(() => {
    // A new key: the old quote no longer describes what Pay would send.
    setQuote(null)
    setQuoteFailedKey(null)
    if (!quoteAskable || !selectedType) return
    const key = quoteKey
    const askable = isLeaseBill ? lines.filter((x) => !x.creditOnly) : []
    let cancelled = false
    const ask = (body: any) => apiPost<any>('/payments/quote', { method: selectedType, ...body })
      .then((res: any) => res?.data ?? null)
    const bodies = isLeaseBill
      // "Pay all" with "Use all": each line is quoted as its charge will be
      // when its turn comes (the leases before it in the run), so the quote
      // and the charge are the same figures.
      ? askable.map((x) => ({ leaseId: x.leaseId, amount: x.amount, useCredit: x.useCredit === true,
          ...(x.afterLeaseIds?.length ? { afterLeaseIds: x.afterLeaseIds } : {}) }))
      : [{ amount, leaseId: target.leaseId, serviceAgreementId: target.serviceAgreementId }]
    const all = Promise.all(bodies.map((b) => ask(b)))
    // With a card chosen, the same charges by bank — priced by the server too
    // (the property's fee payer and any tenant-payer platform fee), so "Pay by
    // bank to lower the fee." compares two of the server's own figures.
    const byBank: Promise<number | null> = selectedType !== 'card' ? Promise.resolve(null)
      : Promise.all(bodies.map((b) => apiPost<any>('/payments/quote', { ...b, method: 'ach' })
          .then((res: any) => res?.data ?? null)))
          .then((qs: any[]) => (qs.some((q) => !q) ? null : roundCents(qs.reduce((s, q) => s + Number(q.fee), 0))))
          .catch(() => null)
    Promise.all([all, byBank]).then(([qs, bankFee]: [any[], number | null]) => {
      if (cancelled) return
      if (qs.some((q) => !q)) { setQuoteFailedKey(key); return }
      setQuote({
        key,
        base: roundCents(qs.reduce((s, q) => s + Number(q.base), 0)),
        fee: roundCents(qs.reduce((s, q) => s + Number(q.fee), 0)),
        total: roundCents(qs.reduce((s, q) => s + Number(q.total), 0)),
        method: selectedType,
        intlCardSurcharge: qs.some((q) => q.intlCardSurcharge),
        bankFee,
      })
    }).catch(() => { if (!cancelled) setQuoteFailedKey(key) })
    return () => { cancelled = true }
  }, [quoteKey, quoteTry])

  // Under a card quote: "Pay by bank to lower the fee." only when the server's
  // own figure for paying these same charges by bank is lower (a bank payment
  // is a flat fee, so on a small bill the card can be cheaper; a landlord who
  // covers bank fees makes it $0; a platform fee rides on both). Not known —
  // not said.
  const cardFeeNote: string | null = (() => {
    if (!quote || !quoteReady || quote.method !== 'card' || !(quote.fee > 0)) return null
    const bankFee = quote.bankFee
    const parts = [
      bankFee != null && quote.fee > bankFee + 0.005 ? 'Pay by bank to lower the fee.' : null,
      quote.intlCardSurcharge
        ? `Cards issued outside the US add ${(PROCESSING_FEES.CARD_INTL_PCT * 100).toFixed(1).replace(/\.0$/, '')}%.`
        : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' ') : null
  })()

  const choose = (m: CreditMode) => { setMode(m); setAnsweredAt(offer.usable); setError(null) }

  /**
   * Read the bill again after a failed payment and ask again, in place. After
   * a refusal the read starts now; after a lost answer it waits out
   * LOST_ANSWER_WAIT (the effect above starts it).
   */
  const reOffer = async (lostAnswer: boolean) => {
    setMode(null); setAnsweredAt(null); setAmountTouched(false)
    setReadAfter(Date.now() + (lostAnswer ? LOST_ANSWER_WAIT.ms : 0))
    if (lostAnswer) return
    // A read already on its way may have left before the payment landed: start
    // a new one.
    await qc.invalidateQueries('balance-context', undefined, { cancelRefetch: true })
  }

  // The method named on the request. "Pay with credit — nothing charged" needs
  // none (the server settles a bill the credit covers before it looks at the
  // method), so with nothing chosen none is sent: should the credit no longer
  // cover the bill, the refusal is the plain "Choose a saved bank account or
  // card to pay with." rather than one about a method the tenant never picked.
  const methodForRequest = (): { paymentMethodId?: string; paymentMethodType?: 'ach' | 'card' } => selectedMethod
    ? { paymentMethodId: selectedMethod.id, paymentMethodType: selectedMethod.type }
    : {}

  /**
   * S581: one pay-balance call per lease, one after another, so a failure on
   * one leaves the leases already paid paid (partial success beats
   * all-or-nothing). A refusal that moved the bill or the credit stops the
   * run: the rest were quoted against the same figures. What was paid drops
   * off and what is left is offered again here, in place.
   *
   * ANY failed run reads the bill again before Pay can be pressed again — not
   * only a refusal. A lost answer (no response, or the server broke) may hide
   * a charge that went through; pressing Pay on the old figures would then
   * send the whole bill again, and the server — finding only the old balance
   * still open — would take it as the old balance plus paid-ahead money: a
   * second charge with a second fee.
   */
  const runLines = async (run: ChargeLine[]) => {
    const method = methodForRequest()
    let paid = 0
    let firstErr: any = null
    // The money charges' outcomes; a lease the credit paid in full is counted apart.
    const statuses: (string | undefined)[] = []
    let creditPaid = 0
    for (const x of run) {
      try {
        const res = await apiPost<PayResponse>(target.endpoint, {
          ...method,
          amount:  x.amount,
          leaseId: x.leaseId,
          ...(x.useCredit != null ? { useCredit: x.useCredit, expectedCredit: x.expectedCredit ?? 0 } : {}),
          // decisions.md #48.4: this screen finishes a card's 3-D Secure confirmation.
          ...(method.paymentMethodType === 'card' ? { confirmOnScreen: true } : {}),
        })
        if (x.creditOnly) creditPaid++
        else statuses.push(await settleCardConfirmation(res))
        paid++
      } catch (e: any) {
        if (!firstErr) firstErr = e
        // The bank did not confirm a card payment: its bill is open again, so
        // the rest of the run (quoted with it paid) stops here.
        if (billMoved(e) || e instanceof CardNotConfirmed) break
      }
    }
    const n = run.length
    if (paid === n) {
      const type = method.paymentMethodType ?? selectedType
      setSuccess(paidText(type, statuses, creditPaid))
      if (type === 'card' && statuses.includes('requires_action')) setAwaitingBank(true)
      else setTimeout(onPaid, 1500)
      return
    }
    const lostAnswer = !(firstErr instanceof CardNotConfirmed) && outcomeUnknown(firstErr)
    const msg = lostAnswer
      ? OUTCOME_UNKNOWN_TEXT
      : errorText(firstErr, 'Payment failed. Try again or contact support.')
    setError(paid > 0 ? `${paid} of ${n} paid. ${msg}` : msg)
    await reOffer(lostAnswer)
  }

  const submit = async () => {
    if (billStale) return
    const charging = !creditOnly
    if (charging && !selectedMethod) {
      setError('Pick a payment method first')
      return
    }
    if (charging && selectedMethod && !isChargeable(selectedMethod)) {
      setError(selectedMethod.type === 'ach' && selectedMethod.verificationStep === 'checking'
        ? 'This bank is being checked — there is nothing more to do. Pay with a card, or use this bank once the check finishes.'
        : selectedMethod.type === 'ach' && (selectedMethod.verifying || selectedMethod.verified === false)
          ? 'This bank is still verifying. Confirm the small deposit we sent to your bank, or pay with a card.'
          : 'Bank payments are paused on this account. Pay by card, or contact your landlord.')
      return
    }
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    try {
      if (isLeaseBill) { await runLines(lines); return }

      const res = await apiPost<PayResponse>(target.endpoint, {
        ...methodForRequest(),
        ...(target.sendAmountInBody ? { amount } : {}),
        ...(target.leaseId ? { leaseId: target.leaseId } : {}),
        ...(target.serviceAgreementId ? { serviceAgreementId: target.serviceAgreementId } : {}),
        ...(selectedType === 'card' ? { confirmOnScreen: true } : {}),
      })
      // S534 (Nic): no propane-priority disclosure here — warning the
      // tenant mid-payment invites backing out and stranding failed ACH
      // pulls. The settle-time notification (webhooks.ts,
      // propane_priority_applied) informs them after the money moves.
      const status = await settleCardConfirmation(res)
      setSuccess(paidText(selectedType, [status]))
      if (selectedType === 'card' && status === 'requires_action') setAwaitingBank(true)
      else setTimeout(onPaid, 1500)
    } catch (e: any) {
      setError(errorText(e, 'Payment failed. Try again or contact support.'))
      if (e instanceof CardNotConfirmed) await rereadAfterCardPayment(qc)
      else if (billMoved(e)) await qc.invalidateQueries('balance-context')
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * decisions.md #48.4: a charge the card's bank wants the cardholder to
   * confirm is confirmed here, on the spot; its status once confirmed. Not
   * confirmed: canceled at once and CardNotConfirmed thrown (the bill is open
   * again). Any other answer: its status as sent.
   */
  const settleCardConfirmation = async (res: any): Promise<string | undefined> => {
    const data = res?.data ?? res
    const status: string | undefined = data?.status
    if (status !== 'requires_action' || !data?.clientSecret || !data?.paymentIntentId) return status
    return confirmCardOnScreen(data.clientSecret, data.paymentIntentId)
  }

  // ── A card payment still waiting on its bank (decisions.md #48.4) ────────
  // The payer left before confirming: the bill is held by it until it is
  // confirmed or released (by itself within 30 minutes, or Cancel here).
  const awaiting: AwaitingCardConfirmation[] = isLeaseBill && ctx?.leases
    ? leaseIds.flatMap((id) => ctx.leases!.find((l) => l.leaseId === id)?.awaitingConfirmation ?? [])
    : target.serviceAgreementId
      ? (ctx?.serviceAgreements ?? []).find((a) => a.serviceAgreementId === target.serviceAgreementId)?.awaitingConfirmation ?? []
      : []

  // "Pay with credit — nothing charged": the credit pays every bill; the
  // answer is "use", given against the figure on screen.
  const payWithCredit = async () => {
    if (billStale) return
    setMode('use'); setAnsweredAt(offer.usable)
    setSubmitting(true); setError(null); setSuccess(null)
    try { await runLines(planCharges(bills, 'use')) } finally { setSubmitting(false) }
  }

  // Batch ("pay all") keeps its fixed per-lease amounts — the box is not offered
  // there, so nothing to validate.
  // S622: the floor is what the LEASE billed, not the whole ledger. A carried
  // balance from the landlord's previous system may be paid down in any amount,
  // so demanding it in full would stop a tenant $1,000 behind from paying their
  // rent at all. Mirrors rentCharge's `requiredInFull` — the screen must never
  // be stricter than the server, or a payment the API would accept is one the
  // tenant cannot even attempt.
  const payFloor = single ? requiredOf(single) : (target.requiredNow ?? target.amount)
  const carriedHere = roundCents(fullAmount - payFloor)
  const amountInvalid = !isBatch && canPayAhead && (
    !(amount > 0) ||
    amount < payFloor - 0.005
  )

  const waitingOnAnswer = creditAsked && !chosen && !offer.coversWholeBill
  const noMethods = methods.length === 0
  const retries = bills.flatMap((l) => l.scheduledRetries ?? [])
  const retryDay = retries.map((r) => r.nextRetryAt).filter(Boolean).sort()[0] ?? null

  const title = creditAsked || loadingBill
    ? 'Pay your bill'
    : `Pay ${formatCurrency(isLeaseBill ? moneyTotal : isBatch ? target.amount : amount)}`

  // Where a space is named in a sentence: "MH 09", else its property.
  const spaceName = (leaseId: string): string => {
    const l = bills.find((b) => b.leaseId === leaseId) ?? pausedHere.find((b) => b.leaseId === leaseId)
    return l?.unitNumber || l?.propertyName || 'one of your spaces'
  }
  // S622: old balances held back so each space's current bill is claimed first.
  const heldBack = lines.filter((x) => (x.carriedLeft ?? 0) > 0.005)
  // The old balance is in no charge on this screen: said once, after the answer.
  const carriedOutOfPayment = isLeaseBill && offer.carried > 0.005 && !lines.some((x) => x.reachesCarried)
    && heldBack.length === 0
  const nothingOwedHere = isLeaseBill && !!ctx?.leases && bills.length === 0 && !success

  return (
    <ModalShell onClose={onClose} title={title}>
      <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
        {target.subheader}
      </div>

      {loadingBill && (
        <div style={{ fontSize: '.85rem', color: 'var(--t3)', marginBottom: 12 }}>Loading your bill…</div>
      )}

      {/* After a failed payment Pay waits for the bill to be read again: a
          charge whose answer was lost may have gone through (and may still be
          being written — so after a lost answer the read waits a few seconds). */}
      {billStale && !loadingBill && !success && (waitingOut || billFetching ? (
        <div style={{ fontSize: '.85rem', color: 'var(--t3)', marginBottom: 12 }}>
          {waitingOut ? 'Checking whether that payment went through…' : 'Reading your bill again…'}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12,
          fontSize: '.8rem', color: 'var(--t1)', lineHeight: 1.45 }}>
          <span>We couldn&apos;t read your bill just now. Check your connection, then press Check again.</span>
          <button className="btn btn-p btn-sm" onClick={() => { void readBillAgain({ cancelRefetch: true }) }}>
            Check again
          </button>
        </div>
      ))}

      {/* A refusal that re-read the bill and left nothing payable here: its
          reason is the one thing to show (every other place it would appear
          is gone with the bill). */}
      {nothingOwedHere && error && (
        <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>{error}</div>
      )}

      {pausedHere.length > 0 && !success && (
        <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 12, lineHeight: 1.5 }}>
          {leaseIds.length === 1
            ? 'Payments on this lease are paused. Contact your landlord.'
            : `Payments on ${pausedHere.map((l) => spaceName(l.leaseId)).join(', ')} are paused. Contact your landlord.`}
        </div>
      )}

      {nothingOwedHere && pausedHere.length === 0 && awaiting.length === 0 && (
        <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 12 }}>
          Nothing is owed on this bill right now.
        </div>
      )}

      {creditAsked && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <span style={{ fontSize: '.82rem', color: 'var(--t2)' }}>Your balance</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.15rem', color: 'var(--t0)' }}>
            {formatCurrency(offer.balance)}
          </span>
        </div>
      )}

      {/* Mounted while the bill is shown, so its answer stays once the held payment drops off the bill. */}
      {!success && <AwaitingCardPayments items={awaiting} onBusy={() => setError(null)} />}

      {clearingHere > 0 && !success && (
        <div style={{ fontSize: '.78rem', color: 'var(--t2)', marginBottom: 12, lineHeight: 1.5 }}>
          {formatCurrency(clearingHere)} already paid on {isBatch ? 'these bills' : 'this bill'} is still
          clearing — it isn&apos;t owed again.
        </div>
      )}

      {retries.length > 0 && !success && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          A bank payment on this bill didn&apos;t go through and is set to be tried again
          {retryDay ? ` on ${shortDay(retryDay)}` : ''}. Paying now takes its place — that retry is called off.
        </div>
      )}

      {waitingText && !success && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          {waitingText}
        </div>
      )}

      {/* No credit question (none of it can pay this bill): where it goes. */}
      {restText && !creditAsked && !success && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          {restText}
        </div>
      )}

      {/* ── S655: the credit question ─────────────────────────────────── */}
      {creditAsked && !success && offer.coversWholeBill && (
        <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
          <div style={{ fontSize: '.85rem', color: 'var(--t1)', marginBottom: 10, lineHeight: 1.5 }}>
            {creditSentence(offer.usable, onFile, several)} {several ? 'It covers all of these bills.' : 'It covers this whole bill.'}{restText ? ` ${restText}` : ''}
          </div>
          {offer.carried > 0 && (
            <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 10, lineHeight: 1.5 }}>
              Your earlier balance of {formatCurrency(offer.carried)} stays on your account — credit doesn&apos;t
              pay it. You can pay it down any time, a little at a time.
            </div>
          )}
          {error && (
            <div className="alert a-warn" style={{ marginBottom: 10, fontSize: '.78rem' }}>{error}</div>
          )}
          <button className="btn btn-p" style={{ width: '100%' }} disabled={submitting || billStale}
            onClick={() => { void payWithCredit() }}>
            {submitting ? 'Paying…' : 'Pay with credit — nothing charged'}
          </button>
        </div>
      )}

      {creditAsked && !success && !offer.coversWholeBill && !chosen && (
        <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
          <div style={{ fontSize: '.85rem', color: 'var(--t1)', marginBottom: 10, lineHeight: 1.5 }}>
            {creditSentence(offer.usable, onFile, several)}{restText ? ` ${restText}` : ''}
          </div>
          {/* Both figures are this bill (the server's own payIfUsed /
              payIfSaved); the old balance is in neither, so it is said here,
              before the choice, not after one. */}
          {offer.carried > 0 && (
            <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 10, lineHeight: 1.5 }}>
              Neither figure includes your earlier balance of {formatCurrency(offer.carried)} — credit doesn&apos;t
              pay it. You can pay it down any time, a little at a time.
            </div>
          )}
          {error && (
            <div className="alert a-warn" style={{ marginBottom: 10, fontSize: '.78rem' }}>{error}</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-p" style={{ width: '100%' }} onClick={() => choose('use')}>
              Use all {formatCurrency(offer.usable)} — pay {formatCurrency(offer.payIfUsed)}
            </button>
            <button className="btn btn-p" style={{ width: '100%' }} onClick={() => choose('save')}>
              Save it for later — pay {formatCurrency(offer.payIfSaved)}
            </button>
          </div>
        </div>
      )}

      {creditAsked && !success && chosen && !offer.coversWholeBill && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12,
          padding: '8px 12px', border: '1px solid var(--b1)', borderRadius: 8, fontSize: '.8rem', color: 'var(--t1)' }}>
          <span style={{ lineHeight: 1.45 }}>
            {chosen === 'use'
              ? <>Using your {formatCurrency(offer.usable)} credit — you pay {formatCurrency(offer.payIfUsed)}.</>
              : <>Saving your {formatCurrency(offer.usable)} credit for later — you pay the whole bill.</>}
          </span>
          <button className="btn btn-g btn-sm" disabled={submitting} onClick={() => { setMode(null); setAnsweredAt(null); setError(null) }}>
            Change
          </button>
        </div>
      )}

      {/* After the answer: the old balance is in no charge here. (With the
          amount box on screen, the box says it instead.) */}
      {creditAsked && !success && chosen && !offer.coversWholeBill && carriedOutOfPayment && !canPayAhead && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          Your earlier balance of {formatCurrency(offer.carried)} stays on your account — it isn&apos;t part of
          this payment. You can pay it down any time.
        </div>
      )}

      {/* S622: each space's current bill is paid before any earlier balance,
          so all but one earlier balance per landlord waits for after. */}
      {heldBack.length > 0 && !success && !waitingOnAnswer && !(creditAsked && offer.coversWholeBill) && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          This pays every space&apos;s current bill first. The earlier balance on{' '}
          {heldBack.map((x) => `${spaceName(x.leaseId)} (${formatCurrency(x.carriedLeft ?? 0)})`).join(', ')}{' '}
          isn&apos;t in this payment — you can pay it down once this one goes through.
        </div>
      )}

      {success && creditOnly && (
        <SuccessNote text={success} />
      )}

      {/* ── Paying with money ──────────────────────────────────────────── */}
      {!loadingBill && !waitingOnAnswer && !(creditAsked && offer.coversWholeBill) && !nothingOwedHere && (noMethods ? (
        <div>
          {error && !(creditAsked && !chosen) && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>{error}</div>
          )}
          <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.82rem' }}>
            You don&apos;t have a payment method on file yet. Paying by bank is usually cheapest;
            a card works when you need to pay right away. The fee for each way to pay is shown
            before you pay.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-p"
              style={{ flex: 1 }}
              onClick={() => onAddMethod('ach')}
            >
              Add bank →
            </button>
            <button
              className="btn btn-p"
              style={{ flex: 1 }}
              onClick={() => onAddMethod('card')}
            >
              Add card →
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* S609 pay-ahead (Nic): "if somebody prepays a full year ahead of
              time, that money sits on GAM's books, and we disburse to the
              landlord each month as invoice comes due."

              The box starts at the balance, so paying what you owe is still one
              click and nobody has to think about this. Typing MORE pays future
              months ahead. Typing LESS is refused — rent is paid in full, and a
              partial payment can restart an eviction clock. */}
          {canPayAhead && !success && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 6 }}>Amount</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--t3)', fontFamily: 'var(--font-mono)' }}>$</span>
                  <input
                    className="inp"
                    inputMode="decimal"
                    aria-label="Amount"
                    value={amountText}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9.]/g, '')
                      setAmountText(raw)
                      setAmountTouched(true)
                      const n = Number(raw)
                      setAmount(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0)
                    }}
                    onBlur={() => setAmountText(amount > 0 ? amount.toFixed(2) : '')}
                    style={{ width: '100%', paddingLeft: 24, fontFamily: 'var(--font-mono)', fontWeight: 700 }}
                  />
                </div>
                {Math.abs(amount - fullAmount) > 0.005 && (
                  <button
                    className="btn btn-g btn-sm"
                    onClick={() => { setAmount(fullAmount); setAmountText(fullAmount.toFixed(2)); setAmountTouched(false) }}
                  >
                    Just what I owe
                  </button>
                )}
              </div>
              {/* S609 (Nic): NO CEILING. The suggestion below is guidance, not a
                  limit — utilities aren't known until a meter is read, so any cap
                  lands wrong at the end of a lease and forces a refund. */}
              {amount < payFloor - 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--warn)', marginTop: 6, lineHeight: 1.5 }}>
                  Rent is paid in full — the least you can pay is {formatCurrency(payFloor)}.
                </div>
              ) : carriedHere > 0.005 && amount < fullAmount - 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                  This clears everything your lease has billed. The remaining{' '}
                  <strong>{formatCurrency(Math.round((fullAmount - amount) * 100) / 100)}</strong>{' '}
                  of your earlier balance stays on your account — you can pay it down
                  a little at a time, and it never has to be paid all at once.
                </div>
              ) : amount > fullAmount + 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--green)', marginTop: 6, lineHeight: 1.5 }}>
                  {formatCurrency(fullAmount)} clears your balance and the extra{' '}
                  <strong>{formatCurrency(Math.round((amount - fullAmount) * 100) / 100)}</strong> is kept
                  as credit on your account. You can use it when you pay a later bill, and it&apos;s applied by
                  itself only when it covers a whole bill. Anything left over comes back to you when you move out.
                </div>
              ) : (
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                  You can pay more than you owe to cover future months — there&apos;s no limit.
                  {((single?.suggestedPayAhead ?? target.suggestedPayAhead) ?? 0) > fullAmount + 0.005 && (
                    <> About {formatCurrency((single?.suggestedPayAhead ?? target.suggestedPayAhead) ?? 0)} covers the rest of your lease.</>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 6 }}>Pay from</div>

          {achMethods.length > 0 && (
            <MethodPickerSection
              label="Bank accounts"
              addLabel="+ Use a different bank"
              onAdd={() => onAddMethod('ach')}
            >
              {achMethods.map((m) => (
                <PickerRow
                  key={m.id}
                  selected={selectedId === m.id}
                  onSelect={() => { if (isChargeable(m)) setSelectedId(m.id) }}
                >
                  <span style={{ opacity: isChargeable(m) ? 1 : 0.55 }}>
                    🏦 {methodLabel(m)}
                  </span>
                  {!isChargeable(m) && (
                    <span className="badge b-amber" style={{ marginLeft: 8, fontSize: '.68rem' }}>
                      {m.verificationStep === 'checking' ? 'Being checked'
                        : m.verifying || m.verified === false ? 'Pending verification'
                        : 'Bank payments paused'}
                    </span>
                  )}
                </PickerRow>
              ))}
            </MethodPickerSection>
          )}

          {cardMethods.length > 0 && (
            <MethodPickerSection
              label="Cards"
              addLabel="+ Use a different card"
              onAdd={() => onAddMethod('card')}
            >
              {cardMethods.map((m) => (
                <PickerRow
                  key={m.id}
                  selected={selectedId === m.id}
                  onSelect={() => setSelectedId(m.id)}
                >
                  💳 {methodLabel(m)}
                  <span style={{ marginLeft: 8, fontSize: '.72rem', color: 'var(--t3)' }}>
                    {m.expMonth && m.expYear
                      ? `exp ${String(m.expMonth).padStart(2, '0')}/${String(m.expYear).slice(-2)}`
                      : ''}
                  </span>
                </PickerRow>
              ))}
            </MethodPickerSection>
          )}

          {achMethods.length === 0 && (
            <button
              className="btn-link"
              style={{ fontSize: '.78rem', color: 'var(--gold)', marginBottom: 12 }}
              onClick={() => onAddMethod('ach')}
            >
              + Add a bank account
            </button>
          )}
          {cardMethods.length === 0 && (
            <button
              className="btn-link"
              style={{ fontSize: '.78rem', color: 'var(--gold)', marginBottom: 12 }}
              onClick={() => onAddMethod('card')}
            >
              + Add a card
            </button>
          )}

          {/* S601 (Nic): no fee sprung on the tenant. Every figure is the
              server's own quote below, for the way they chose — a list price
              here could contradict it (a landlord who covers bank fees, a
              tenant-payer platform fee, a small bill a card pays for less). */}
          <div style={{ fontSize: '.75rem', color: 'var(--t3)', lineHeight: 1.5, margin: '2px 0 12px' }}>
            Bank and card fees are shown before you pay — completely your call.
          </div>

          {error && !(creditAsked && !chosen) && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
              {error}
            </div>
          )}
          {success && !awaitingBank && <SuccessNote text={success} />}
          {success && awaitingBank && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.8rem', lineHeight: 1.5 }}>
              <div>{success}</div>
              <button className="btn btn-p btn-sm" style={{ marginTop: 8 }} onClick={onPaid}>Close</button>
            </div>
          )}

          {bankWaitingOnDeposits && (
            <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginBottom: 10, lineHeight: 1.5 }}>
              A bank still shows <strong>Pending verification</strong> — confirm the small deposit we sent to it
              (1–3 business days) to use it. You can pay by card in the meantime.
            </div>
          )}
          {bankBeingChecked && (
            <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginBottom: 10, lineHeight: 1.5 }}>
              Your bank is being checked — nothing more to do; you can pay by card in the meantime.
            </div>
          )}

          {!success && !creditOnly && quoteAskable && !quoteReady && (quoteFailed ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10,
              fontSize: '.8rem', color: 'var(--t1)', lineHeight: 1.45 }}>
              <span>We couldn&apos;t work out the fee just now. Check your connection, then press Try again.</span>
              <button className="btn btn-p btn-sm" onClick={() => setQuoteTry((n) => n + 1)}>Try again</button>
            </div>
          ) : (
            <div style={{ fontSize: '.8rem', color: 'var(--t3)', marginBottom: 10 }}>Working out the fee…</div>
          ))}

          {quote && quoteReady && !success && (
            <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, fontSize: '.82rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t2)' }}>
                <span>{target.kind === 'utility' ? 'Utility bill' : chosen === 'use' ? 'Rent, after your credit' : 'Rent'}</span>
                <span>{formatCurrency(quote.base)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t2)', marginTop: 4 }}>
                <span>{quote.method === 'card' ? 'Card processing fee' : 'Bank (ACH) fee'}{quote.fee === 0 ? ' — covered by your landlord' : ''}</span>
                <span>{formatCurrency(quote.fee)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--t0)', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--b1)' }}>
                <span>You&apos;ll be charged</span>
                <span>{formatCurrency(quote.total)}</span>
              </div>
              {cardFeeNote && (
                <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.4 }}>
                  {cardFeeNote}
                </div>
              )}
            </div>
          )}

          <button
            className="btn btn-p"
            style={{ width: '100%' }}
            disabled={!selectedId || submitting || !!success || selectedBlocked || amountInvalid || billStale
              || (isLeaseBill && lines.length === 0)
              // A money charge waits for the server's quote for exactly what is on screen.
              || (!creditOnly && !quoteReady)}
            onClick={submit}
          >
            {submitting
              ? 'Submitting…'
              : success
                ? (awaitingBank ? 'Waiting on your card’s bank' : '✓ Submitted')
                : quote && quoteReady
                  ? `Pay ${formatCurrency(quote.total)}`
                  : creditOnly ? 'Pay with credit — nothing charged' : 'Pay'}
          </button>
          <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
            {authorizationCopy(selectedType, target.kind)}
          </div>
        </>
      ))}
    </ModalShell>
  )
}

function SuccessNote({ text }: { text: string }) {
  return (
    <div
      className="alert"
      style={{
        marginBottom: 12,
        fontSize:     '.82rem',
        background:   'rgba(34,197,94,.08)',
        border:       '1px solid rgba(34,197,94,.25)',
        color:        'var(--green)',
        padding:      '10px 14px',
        borderRadius: 8,
      }}
    >
      {text}
    </div>
  )
}

function authorizationCopy(
  selectedType: 'ach' | 'card' | null,
  kind: PayTarget['kind'],
): string {
  const subject = kind === 'utility' ? 'utility bill' : 'payment'
  if (selectedType === 'card') {
    return `By clicking Pay you authorize a one-time charge to the selected card for the total shown above (${subject} + card processing fee).`
  }
  return `By clicking Pay you authorize a one-time ACH debit from the selected account for the ${subject} above. ACH typically settles in 3–5 business days.`
}

// ── PICKER PRIMITIVES (internal) ─────────────────────────────────────────
function MethodPickerSection({
  label,
  addLabel,
  onAdd,
  children,
}: {
  label:    string
  addLabel: string
  onAdd:    () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display:        'flex',
          justifyContent: 'space-between',
          alignItems:     'center',
          fontSize:       '.72rem',
          color:          'var(--t3)',
          marginBottom:   6,
          textTransform:  'uppercase',
          letterSpacing:  '.06em',
        }}
      >
        <span>{label}</span>
        <button
          className="btn-link"
          style={{
            fontSize:    '.72rem',
            color:       'var(--gold)',
            background:  'transparent',
            border:      'none',
            cursor:      'pointer',
          }}
          onClick={onAdd}
        >
          {addLabel}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

function PickerRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <label
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          10,
        padding:      12,
        border:       selected ? '1px solid var(--gold)' : '1px solid var(--b1)',
        borderRadius: 8,
        background:   selected ? 'rgba(201,162,39,.07)' : 'var(--bg2)',
        cursor:       'pointer',
        fontSize:     '.85rem',
      }}
    >
      <input type="radio" name="pm" checked={selected} onChange={onSelect} />
      <span style={{ display: 'flex', alignItems: 'center' }}>{children}</span>
    </label>
  )
}

// ── ADD PAYMENT METHOD MODAL ─────────────────────────────────────────────
//
// Two-phase: first POST /stripe/tenant/setup with the requested method
// to obtain a SetupIntent client_secret, then mount Stripe Elements
// with that clientSecret and confirm setup.
//
// ACH path: SetupIntent has Financial Connections enabled. After the
//   client-side confirm succeeds we POST /stripe/tenant/confirm-setup
//   so the server can write ach_verified + bank_last4 + log first-sender.
//
// Card path: SetupIntent has payment_method_types:['card']. On
//   confirmSetup success Stripe automatically attaches the payment_method
//   to the customer; the next /payment-methods GET picks it up. No
//   server-side capture step required.
export function AddPaymentMethodModal({
  method,
  onClose,
  onAdded,
}: {
  method:  'ach' | 'card'
  onClose: () => void
  onAdded: () => void
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'collect' | 'done' | 'pending' | 'error'>('idle')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingMsg, setPendingMsg] = useState<string | null>(null)
  // S605: shown on the pending screen so the tenant sees WHICH bank the routing
  // number resolved to — the confirmation an institution picker would have given
  // them, except derived rather than typed, so it can't disagree with the number.
  const [pendingBank, setPendingBank] = useState<{ name: string | null; last4: string | null } | null>(null)
  // S605 (Nic): which verification Stripe actually sent — 'amounts' or the
  // six-digit 'descriptor_code'. Never assume; the screen must match the deposit.
  const [pendingType, setPendingType] = useState<MicrodepositType | null>(null)
  // S655: 'checking' = the tenant already entered the verification and Stripe
  // is checking it — nothing is on its way and nothing is left for them to do.
  const [pendingStep, setPendingStep] = useState<'deposits' | 'checking' | null>(null)

  const titleVerb  = method === 'ach' ? 'bank account' : 'card'
  const idleCopy   =
    method === 'ach'
      ? 'Enter your bank\'s routing and account numbers. Stripe then sends a small verification deposit — depending on your bank you\'ll confirm either the deposit amounts or a short code from your statement, usually within 1–3 business days. No fees. Any bank you already have stays on file until you remove it. Need to pay right now? Use a card instead.'
      : 'We\'ll collect your card securely through Stripe. Card details never touch GAM\'s servers; we only see the last 4 digits, brand, and expiration once Stripe attaches the card to your account.'
  const loadingCopy = method === 'ach' ? 'Preparing secure bank form…' : 'Preparing secure card form…'
  const doneCopy    = method === 'ach' ? '✓ Bank account verified' : '✓ Card saved'

  const elementsOptions = useMemo(
    () => (clientSecret ? { clientSecret } : undefined), [clientSecret])

  const start = async () => {
    setPhase('loading')
    setError(null)
    try {
      const res = await apiPost<{ clientSecret: string; customerId: string }>(
        '/stripe/tenant/setup',
        { method },
      )
      const cs = (res as any)?.data?.clientSecret ?? (res as any)?.clientSecret
      if (!cs) throw new Error('No client secret returned')
      setClientSecret(cs)
      setPhase('collect')
    } catch (e: any) {
      setError(
        e?.response?.data?.error?.message ||
          e?.response?.data?.error ||
          e?.message ||
          `Could not start ${method === 'ach' ? 'bank' : 'card'} setup`,
      )
      setPhase('error')
    }
  }

  return (
    <ModalShell onClose={onClose} title={`Add a ${titleVerb}`}>
      {phase === 'idle' && (
        <div>
          <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 14, lineHeight: 1.5 }}>
            {idleCopy}
          </div>
          {!stripePromise && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
              Stripe is not configured in this environment. Set
              <code> VITE_STRIPE_PUBLISHABLE_KEY</code> to enable verification.
            </div>
          )}
          <button
            className="btn btn-p"
            style={{ width: '100%' }}
            disabled={!stripePromise}
            onClick={start}
          >
            Continue →
          </button>
        </div>
      )}
      {phase === 'loading' && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)' }}>{loadingCopy}</div>
      )}
      {phase === 'collect' && clientSecret && stripePromise && (
        // Memoized: a fresh {clientSecret} object on every parent render makes
        // react-stripe-js treat the options as changed, which can tear down and
        // remount the element mid-flow — the other way to end up calling
        // confirmSetup with nothing mounted.
        <Elements stripe={stripePromise} options={elementsOptions!}>
          <PaymentMethodSetupForm
            method={method}
            clientSecret={clientSecret}
            onDone={(result) => {
              if (result?.pending) {
                setPendingMsg(result.message ?? null)
                setPendingBank({ name: result.bankName ?? null, last4: result.bankLast4 ?? null })
                setPendingType(result.microdepositType ?? null)
                setPendingStep(result.verificationStep ?? null)
                setPhase('pending')
              } else {
                setPhase('done')
                setTimeout(onAdded, 800)
              }
            }}
            onError={(msg) => {
              setError(msg)
              setPhase('error')
            }}
          />
        </Elements>
      )}
      {phase === 'done' && (
        <div
          style={{
            padding:    20,
            textAlign:  'center',
            color:      'var(--green)',
            fontSize:   '.9rem',
          }}
        >
          {doneCopy}
        </div>
      )}
      {phase === 'pending' && (
        <div>
          <div style={{ padding: '4px 0 14px', color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>
              {pendingStep === 'checking' ? 'Your bank is being checked'
                : pendingType === 'descriptor_code' ? 'A $0.01 deposit is on the way' : 'Verification is on the way'}
            </div>
            {pendingBank?.name && (
              <div style={{ marginBottom: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg1)', border: '1px solid var(--b1)', fontSize: '.82rem', color: 'var(--t1)' }}>
                <strong>{pendingBank.name}</strong>{pendingBank.last4 ? ` ••${pendingBank.last4}` : ''}
                <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 2 }}>
                  Not your bank? Add the account again with the correct routing number.
                </div>
              </div>
            )}
            {pendingStep === 'checking'
              ? (pendingMsg ?? 'We received the verification you entered for this bank and are checking it now. There is nothing more you need to do.')
              : <>{pendingMsg ?? microdepositInstruction(pendingType)}
                  {' '}It usually arrives in 1–3 business days. You can pay by card in the meantime.</>}
          </div>
          <button className="btn btn-p" style={{ width: '100%' }} onClick={onAdded}>Got it</button>
        </div>
      )}
      {phase === 'error' && (
        <div>
          <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.82rem' }}>
            {error ?? 'Something went wrong.'}
          </div>
          <button className="btn btn-p" style={{ width: '100%' }} onClick={start}>
            Try again
          </button>
        </div>
      )}
    </ModalShell>
  )
}

// How long to wait on Stripe's bank window before telling the tenant something
// is wrong. Long enough for a slow bank login, short enough that nobody sits on
// a frozen button wondering.
const CONFIRM_TIMEOUT_MS = 180_000

function PaymentMethodSetupForm({
  method,
  clientSecret,
  onDone,
  onError,
}: {
  method:       'ach' | 'card'
  // Needed by the ACH path, which confirms directly instead of going through
  // the Elements group.
  clientSecret: string
  onDone:  (result?: { pending?: boolean; message?: string; bankName?: string | null; bankLast4?: string | null; microdepositType?: MicrodepositType | null; verificationStep?: 'deposits' | 'checking' | null }) => void
  onError: (msg: string) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // S605 (Nic hit this): "invalid value for stripe.confirmSetup() — elements
  // should have a mounted Payment Element".
  //
  // `useElements()` returns the Elements GROUP, which exists the moment
  // <Elements> renders — it says nothing about whether the PaymentElement
  // inside it has mounted. The button was gated on `elements` alone, so it went
  // live before the payment form was actually there, and clicking it called
  // confirmSetup against an empty group. Gate on the element's own ready event
  // instead, which is the only signal that means what we need it to mean.
  const [elementReady, setElementReady] = useState(false)

  // S605: ACH is collected here rather than by Stripe's element — see the form
  // below for why. Card still uses the element, so `elementReady` only gates it.
  const [ach, setAch] = useState({
    name: '', routing: '', account: '', confirmAccount: '',
    accountType: 'checking' as 'checking' | 'savings',
    // S605 (Nic): "somebody on hard times may be getting their rent paid by
    // somebody else... the person living there may not be the person actually
    // paying for it." That payer can be a business — an employer, a housing
    // agency, a church or nonprofit — and Stripe needs the holder type to match
    // the real account. This was hardcoded to 'individual', which would have
    // failed every organization-funded tenancy.
    holderType: 'individual' as 'individual' | 'company',
  })
  const routingValid = isValidRoutingNumber(ach.routing)
  // S605 (Nic): the routing number has a checksum to catch a fat finger; the
  // account number has NOTHING — any digit string is structurally plausible, so
  // a typo sails through to Stripe and surfaces days later as a failed deposit
  // with no clue which digit was wrong. Double entry is the only check available.
  const accountsMatch = ach.account.length > 0 && ach.account === ach.confirmAccount
  const accountMismatch = ach.confirmAccount.length > 0 && ach.account !== ach.confirmAccount
  // Only complain once they've typed all 9 — flagging a half-entered number as
  // invalid would be wrong and would train them to ignore the message.
  const routingBad = ach.routing.length === 9 && !routingValid
  const achComplete = ach.name.trim().length > 1 && routingValid && ach.account.length >= 4 && accountsMatch

  const handleConfirm = async () => {
    if (!stripe) return
    if (method === 'card' && !elements) return
    setSubmitting(true)
    setLocalError(null)

    // S605 (Nic hit this): the button stuck on "Linking…" forever with no
    // message. `stripe.confirmSetup` was awaited bare — anything it THREW
    // (rather than returned as {error}) escaped this handler unhandled, so
    // setSubmitting(false) never ran and the tenant was left staring at a dead
    // button with no way to tell whether it was working or broken. Stripe's
    // bank flow opens a Financial Connections popup, which is exactly the kind
    // of thing that can reject or never settle (popup blocked, window closed).
    //
    // Two guards: catch anything thrown, and refuse to hang forever. A tenant
    // trying to pay rent must always end up somewhere they can act on.
    let result: any
    try {
      // ACH never touches confirmSetup/elements — that path is what pulls in
      // Stripe's instant-verification UI. confirmUsBankAccountSetup takes the
      // numbers directly and returns a SetupIntent awaiting microdeposits.
      const confirming = method === 'ach'
        ? (stripe as any).confirmUsBankAccountSetup(clientSecret, {
            payment_method: {
              us_bank_account: {
                routing_number:      ach.routing,
                account_number:      ach.account,
                account_holder_type: ach.holderType,
                account_type:        ach.accountType,
              },
              billing_details: { name: ach.name.trim() },
            },
          })
        // Non-null: the card branch is unreachable without `elements` — the
        // guard at the top of handleConfirm returns early for card without it.
        : stripe.confirmSetup({
            elements:      elements!,
            confirmParams: { return_url: window.location.href },
            redirect:      'if_required',
          })
      result = await Promise.race([
        confirming,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('TIMEOUT')), CONFIRM_TIMEOUT_MS)),
      ])
    } catch (err: any) {
      setSubmitting(false)
      setLocalError(err?.message === 'TIMEOUT'
        ? 'Your bank\'s window didn\'t finish. If a popup was blocked, allow popups for this site and try again — or use "Enter bank details manually" instead.'
        : err?.message || 'The bank window closed before finishing. Please try again.')
      return
    }

    if (result.error) {
      setSubmitting(false)
      setLocalError(
        result.error.message ||
          (method === 'ach' ? 'Bank verification failed' : 'Card setup failed'),
      )
      return
    }
    const setupIntent = result.setupIntent
    if (!setupIntent || !setupIntent.payment_method) {
      setSubmitting(false)
      setLocalError(`Setup status: ${setupIntent?.status ?? 'unknown'}`)
      return
    }
    if (method === 'card') {
      // Card auto-attaches on confirmSetup. S571: tell the server so it enforces
      // one card on file (a new card replaces the old) + sets default if none.
      try {
        await apiPost('/stripe/tenant/confirm-card', {
          paymentMethodId:
            typeof setupIntent.payment_method === 'string'
              ? setupIntent.payment_method
              : setupIntent.payment_method.id,
        })
      } catch { /* non-fatal — the card is attached; swap/default is best-effort */ }
      onDone()
      return
    }
    // ACH: server stamps the bank. With microdeposit verification the account
    // is NOT yet verified — the server returns verified:false + a pending
    // message until the tenant confirms the two deposits (setup_intent.succeeded
    // webhook flips ach_verified then).
    try {
      const resp: any = await apiPost('/stripe/tenant/confirm-setup', {
        setupIntentId:   setupIntent.id,
        paymentMethodId:
          typeof setupIntent.payment_method === 'string'
            ? setupIntent.payment_method
            : setupIntent.payment_method.id,
      })
      onDone(resp?.verified === false
        ? { pending: true, message: resp?.message, bankName: resp?.bankName, bankLast4: resp?.bankLast4, microdepositType: resp?.microdepositType, verificationStep: resp?.verificationStep ?? null }
        : undefined)
    } catch (e: any) {
      setSubmitting(false)
      onError(
        e?.response?.data?.error?.message ||
          e?.response?.data?.error ||
          'Server could not record the verified bank',
      )
    }
  }

  return (
    <div>
      <div
        style={{
          background:   'var(--bg1)',
          border:       '1px solid var(--b1)',
          borderRadius: 8,
          padding:      14,
          marginBottom: 12,
        }}
      >
        {method === 'ach' ? (
          // S605 (Nic, DIRECTIVE): "Instant verification will not be on this
          // platform at this time." Stripe's PaymentElement cannot do
          // microdeposit-only — given a us_bank_account SetupIntent it always
          // leads with "sign in to your bank" (Financial Connections, ~$1.50).
          // There is no option to hide it. So ACH collects the numbers here and
          // confirms directly, which never renders or references instant at all.
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Name on the account *</label>
              <input className="inp" style={{ width: '100%' }} value={ach.name} autoFocus
                onChange={e => setAch(a => ({ ...a, name: e.target.value }))} placeholder="Jane Q. Renter" />
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Routing number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={9} value={ach.routing}
                onChange={e => setAch(a => ({ ...a, routing: e.target.value.replace(/\D/g, '').slice(0, 9) }))} placeholder="9 digits" />
              {routingBad && (
                <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 4 }}>
                  That routing number isn't valid — check the 9 digits on your check or in your banking app.
                </div>
              )}
              {routingValid && (
                <div style={{ color: 'var(--green)', fontSize: '.7rem', marginTop: 4 }}>
                  ✓ Valid routing number — we'll confirm your bank's name on the next screen.
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Account number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={17} value={ach.account}
                onChange={e => setAch(a => ({ ...a, account: e.target.value.replace(/\D/g, '').slice(0, 17) }))} placeholder="Your account number" />
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Confirm account number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={17} value={ach.confirmAccount}
                onChange={e => setAch(a => ({ ...a, confirmAccount: e.target.value.replace(/\D/g, '').slice(0, 17) }))}
                // Pasting here would copy the first field's typo verbatim and
                // report a match, which is the one outcome this field exists to
                // prevent. It has to be typed.
                onPaste={e => e.preventDefault()}
                onDrop={e => e.preventDefault()}
                autoComplete="off"
                placeholder="Type it again" />
              {accountMismatch && (
                <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 4 }}>
                  The account numbers don't match.
                </div>
              )}
              {accountsMatch && (
                <div style={{ color: 'var(--green)', fontSize: '.7rem', marginTop: 4 }}>✓ Account numbers match</div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Account type *</label>
                <select className="inp" style={{ width: '100%' }} value={ach.accountType}
                  onChange={e => setAch(a => ({ ...a, accountType: e.target.value as 'checking' | 'savings' }))}>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Owned by *</label>
                <select className="inp" style={{ width: '100%' }} value={ach.holderType}
                  onChange={e => setAch(a => ({ ...a, holderType: e.target.value as 'individual' | 'company' }))}>
                  <option value="individual">A person</option>
                  <option value="company">A business or organization</option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: '.68rem', color: 'var(--t3)', lineHeight: 1.5 }}>
              These go straight to Stripe — GAM stores only the last 4 digits. The account
              doesn't have to be in your name; if someone else pays your rent, use their
              details with their permission. By continuing you confirm you're authorized to
              debit this account for amounts you approve.
            </div>
          </div>
        ) : (
          <PaymentElement
            onReady={() => setElementReady(true)}
            onLoadError={(e: any) => setLocalError(
              e?.error?.message || 'The payment form could not load. Please refresh and try again.')}
          />
        )}
      </div>
      {localError && (
        <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
          {localError}
        </div>
      )}
      <button
        className="btn btn-p"
        style={{ width: '100%' }}
        disabled={!stripe || submitting || (method === 'ach' ? !achComplete : (!elements || !elementReady))}
        onClick={handleConfirm}
      >
        {submitting
          ? method === 'ach'
            ? 'Linking…'
            : 'Saving…'
          : method === 'ach'
            ? 'Link bank →'
            : !elementReady
              ? 'Loading…'
              : 'Save card →'}
      </button>
    </div>
  )
}

// ── MODAL SHELL ──────────────────────────────────────────────────────────
function ModalShell({
  onClose,
  title,
  children,
}: {
  onClose:  () => void
  title:    string
  children: React.ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position:        'fixed',
        inset:           0,
        background:      'rgba(0,0,0,.6)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
        zIndex:          100,
        padding:         16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:   'var(--bg2)',
          border:       '1px solid var(--b1)',
          borderRadius: 12,
          padding:      22,
          width:        '100%',
          maxWidth:     460,
          maxHeight:    '90vh',
          overflowY:    'auto',
        }}
      >
        <div
          style={{
            display:        'flex',
            justifyContent: 'space-between',
            alignItems:     'center',
            marginBottom:   14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{title}</h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border:     'none',
              color:      'var(--t3)',
              fontSize:   '1.2rem',
              cursor:     'pointer',
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── VERIFY MICRODEPOSITS, IN HOUSE (S603, Nic) ────────────────────────────
// Previously the tenant left GAM: Stripe emailed them a link and they confirmed
// on a Stripe-hosted page. They still have to look in their own bank to READ the
// amounts — nothing can change that — but confirming them happens here now.
//
// Stripe uses one of two styles depending on the bank: two sub-$1 deposits, or a
// single 1¢ deposit whose statement descriptor carries a 6-digit code. The
// server reports which; this asks for the right thing rather than guessing.
export function VerifyMicrodepositsCard({ onVerified }: { onVerified?: () => void }) {
  const [state, setState] = useState<{
    pending: boolean; microdepositType?: string; arrivalDate?: number | null
  } | null>(null)
  const [a1, setA1] = useState('')
  const [a2, setA2] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // S655: what the server SAID — verified, still being checked, or received
  // with nothing decided. Only 'verified' may say the bank is verified and made
  // the default.
  const [done, setDone] = useState<null | { kind: 'verified' } | { kind: 'checking' | 'received'; message: string }>(null)

  useEffect(() => {
    apiGet<any>('/stripe/tenant/microdeposits')
      .then(r => setState((r as any)?.data ?? r))
      .catch(() => setState({ pending: false }))
  }, [])

  // S607 (Nic): "I thought inputting the code was completing the verification."
  // It does — but the card used to just VANISH on success, which reads as the
  // submission having gone nowhere, and the "Pending verification" badge beside
  // it stayed up for a moment longer (see the refetch schedule in submit()).
  // Confirm plainly instead of disappearing.
  if (done && done.kind !== 'verified') {
    return (
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--gold)' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {done.kind === 'checking' ? 'Your bank is being checked' : 'We received what you entered'}
        </div>
        <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.55 }}>
          {done.message} This can take a while — come back to this page later to see where it stands.
        </div>
      </div>
    )
  }
  if (done) {
    return (
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--green, #16a34a)' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>✓ Code accepted — your bank is verified</div>
        <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.55 }}>
          {/* S607 (Nic): the promotion is disclosed, never silent. Which account
              rent comes out of is a money setting, and the tenant should learn
              it from us rather than from a statement. The switch back is one tap
              on the payment-method list below. */}
          We've made this bank your <strong>default</strong> — the fee for each way to pay is
          shown before you pay. You can switch back to a card any time below. If it still shows
          as pending after a few seconds, reload this page.
        </div>
      </div>
    )
  }
  if (!state?.pending) return null
  // S605 (Nic): THREE states, not two. Stripe picks per bank, and when it
  // hasn't told us we must not guess — an unknown type shows BOTH inputs and
  // lets the tenant enter whichever their bank actually sent. Guessing strands
  // whoever got the other kind with no field to type it into.
  const byCode  = state.microdepositType === 'descriptor_code'
  const byAmts  = state.microdepositType === 'amounts'
  const unknown = !byCode && !byAmts

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      // With an unknown type, send whichever the tenant actually filled in.
      const hasCode = code.trim().length > 0
      const hasAmts = !!Number(a1) && !!Number(a2)
      let body: any
      if (byCode || (unknown && hasCode)) {
        if (!hasCode) { setError('Enter the code from your statement.'); setBusy(false); return }
        body = { descriptorCode: code.trim() }
      } else {
        if (!hasAmts) {
          setError(unknown
            ? 'Enter either the two deposit amounts, or the code from your statement.'
            : 'Enter both deposit amounts in cents.')
          setBusy(false); return
        }
        body = { amounts: [Math.round(Number(a1)), Math.round(Number(a2))] }
      }
      // apiPost returns the whole { success, data } envelope.
      const res: any = await apiPost('/stripe/tenant/microdeposits/verify', body)
      const d = res?.data ?? {}
      setDone(d.verified === true ? { kind: 'verified' }
        : d.verificationStep === 'checking'
          ? { kind: 'checking', message: d.message || 'We received the verification you entered for this bank and are checking it now. There is nothing more you need to do.' }
          : { kind: 'received', message: d.message || 'We received what you entered. Look at your saved payment methods to see where this bank stands.' })
      // S607 (Nic): the code is accepted here, but the tenant is not marked
      // verified until Stripe's setup_intent.succeeded webhook lands — which is
      // fast, but NOT instant (0.16s in the live WAFD test, and slower under
      // load). A single refetch fired now races that webhook and usually loses,
      // which is why the "Pending verification" badge survived a successful
      // verification with nothing scheduled to look again. Re-check on a short
      // schedule so the badge clears itself instead of needing a reload.
      onVerified?.()
      for (const ms of [1500, 4000, 9000]) setTimeout(() => onVerified?.(), ms)
    } catch (e: any) {
      // Stripe's own wording distinguishes "wrong, try again" from "locked, start
      // over" — surfacing it verbatim beats a generic message that strands them.
      setError(e?.response?.data?.error?.message || e?.response?.data?.error
        || e?.message || 'Those amounts did not match.')
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--gold)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Finish setting up your bank account</div>
      <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.55, marginBottom: 12 }}>
        {byCode
          ? 'We sent a $0.01 deposit to your bank. Find it on your statement — the description contains a code starting with SM. Enter that code below. Your bank may print its own reference number next to it; the one we need is the SM code.'
          : byAmts
            ? 'We sent two small deposits to your bank. Check your account, then enter both amounts below in cents (for example, 32 and 45).'
            : 'We sent a verification deposit to your bank. Banks handle this one of two ways — check your statement and use whichever you see: two small deposits (enter both amounts), or a single $0.01 deposit with a code starting with SM in its description (enter the code).'}
      </div>

      {error && <div className="alert a-warn" style={{ marginBottom: 10, fontSize: '.8rem' }}>{error}</div>}

      {(byCode || unknown) && (
        <div style={{ marginBottom: 10 }}>
          {unknown && (
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', marginBottom: 4 }}>
              If you see one $0.01 deposit with an SM code
            </div>
          )}
          <input
            className="input" value={code}
            // S607 (Nic): force upper case as they type, so what the tenant sees
            // is exactly what we send. The API upper-cases too, but a field that
            // silently transforms on submit is its own small betrayal — and a
            // wrong guess here is not free, Stripe locks the verification after
            // a few.
            onChange={e => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            placeholder="SM1234" maxLength={12}
            style={{ width: '100%', textTransform: 'uppercase' }}
          />
        </div>
      )}

      {unknown && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--b1)' }} />
          <span style={{ fontSize: '.7rem', color: 'var(--t3)' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'var(--b1)' }} />
        </div>
      )}

      {(byAmts || unknown) && (
        <div style={{ marginBottom: 10 }}>
          {unknown && (
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', marginBottom: 4 }}>
              If you see two small deposits
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <input className="input" inputMode="numeric" value={a1}
              onChange={e => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="First (¢)" style={{ flex: 1 }} />
            <input className="input" inputMode="numeric" value={a2}
              onChange={e => setA2(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="Second (¢)" style={{ flex: 1 }} />
          </div>
        </div>
      )}

      <button className="btn btn-p" style={{ width: '100%' }} disabled={busy} onClick={submit}>
        {busy ? 'Checking…' : 'Verify my bank account'}
      </button>
    </div>
  )
}
