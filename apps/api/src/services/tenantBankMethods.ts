/**
 * S655 money plan, Step 5 (item L) — KEEP THE OLD BANK.
 *
 * Nic (10/2): "adding never removes; new verified bank becomes default; old
 * stays until the tenant deletes it; delete blocked while it is their only
 * verified bank, EXCEPT when nothing is owed and autopay is off (moved out);
 * cards not affected."
 *
 * What was wrong. Adding a bank (routes/stripe.ts confirm-setup) DETACHED every
 * other bank on the tenant's Stripe customer and wrote ach_verified = FALSE
 * while the new one waited 1–3 days on its microdeposits. A tenant who switched
 * banks the week rent was due lost the only account that could pay it, and
 * autopay had nothing to charge. One bank per tenant also meant the portal
 * read "verified" off the TENANT (tenants.ach_verified) instead of off each
 * bank.
 *
 * This module is the one place that knows, per saved method:
 *   - verified   Stripe confirmed the account. A microdeposit bank is attached
 *                to the customer only once its deposits are confirmed (S637),
 *                and any bank still named by a SetupIntent waiting on
 *                microdeposits — or whose entered deposits Stripe is still
 *                checking (processing) — is counted as verifying even if
 *                attached.
 *   - verifying  waiting on that step; never chargeable.
 *   - chargeable verified, and bank payments are not suspended for this tenant
 *                (tenants.ach_suspended_at, the NACHA zero-tolerance block).
 *   - whether it can be removed now, and if not, why — in plain words with the
 *     next step, so the screen shows the same sentence the refusal would.
 *
 * tenants.ach_verified keeps one meaning: "has a verified bank". It is turned
 * on where a bank is verified (recordVerifiedTenantBank) and off only when the
 * last verified bank is removed. tenants.bank_pending_since says "a bank is
 * waiting on microdeposits" (the verification nudge selects by it), and
 * tenants.bank_last4 names the bank GAM shows as the one on file: the default
 * verified bank, else any verified bank, else the newest bank still verifying.
 *
 * Every write for a tenant's saved methods takes the advisory lock
 * `tenant_bank:<tenantId>` and re-reads Stripe under it, so two removals at
 * once cannot both pass "another verified bank is still there".
 *
 * A verified bank is also kept — even beside another verified bank — while a
 * pull made from it is still clearing or is set to be tried again: a retry
 * confirms the same payment on the same bank (achRetry.retryConfirmParams),
 * and Stripe refuses it once that bank is detached, so the retry the tenant was
 * told about would never run (pullBlockFor).
 */
import type Stripe from 'stripe'
import type { PoolClient } from 'pg'
import { query, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { payableRowSql } from './moneyPredicates'

// ─── What the portal, the agent and the remove route see ────────────────────

export interface SavedBankMethod {
  id: string
  type: 'ach'
  bankName: string | null
  last4: string | null
  /** Stripe has verified this account (its microdeposits were confirmed). */
  verified: boolean
  /** Waiting on the microdeposit step; it cannot be charged yet. */
  verifying: boolean
  /**
   * Where a bank still verifying stands: 'deposits' while Stripe waits on the
   * tenant to confirm the microdeposits, 'checking' while Stripe checks what
   * they entered (nothing left for them to do). Null once verified.
   */
  verificationStep: 'deposits' | 'checking' | null
  /** Can be charged now: verified, and bank payments are not suspended. */
  chargeable: boolean
  isDefault: boolean
  /** An autopay schedule names this method. */
  autopayPinned: boolean
  canRemove: boolean
  /** Why it cannot be removed right now, with the next step. Null when it can. */
  removeBlockedReason: string | null
}

export interface SavedCardMethod {
  id: string
  type: 'card'
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  country: string | null
  /** Cards are chargeable the moment they are saved. */
  verified: true
  verifying: false
  verificationStep: null
  chargeable: true
  isDefault: boolean
  autopayPinned: boolean
  canRemove: boolean
  removeBlockedReason: string | null
}

export type SavedMethod = SavedBankMethod | SavedCardMethod

export interface TenantPaymentMethods {
  /** False when the tenant has never started a payment setup (no Stripe customer). */
  hasCustomer: boolean
  methods: SavedMethod[]
  /** Bank payments are suspended for this tenant (NACHA zero tolerance). */
  achSuspended: boolean
  /**
   * Stripe could not be asked which banks are still verifying. The attached
   * banks are listed (an attached bank is a verified one), but a bank still
   * waiting on its deposits may be missing. Removals refuse to run on this.
   */
  pendingLookupFailed: boolean
}

// ─── Stripe's view, with what the wire does not carry ───────────────────────

export interface StripeBankFacts {
  id: string
  bankName: string | null
  last4: string | null
  routingLast4: string | null
  /** Attached to the customer (paymentMethods.list returns it). */
  attached: boolean
  verified: boolean
  verifying: boolean
  /**
   * Stripe is checking the deposits the tenant entered for this bank
   * (its SetupIntent is processing). It is still verifying, and the setup
   * cannot be canceled until the check ends.
   */
  checking: boolean
  /** The SetupIntent still verifying this bank, if any. */
  setupIntentId: string | null
  /** When that SetupIntent was created. */
  waitingSince: Date | null
}

export interface StripeCardFacts {
  id: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  country: string | null
}

export interface StripeMethodFacts {
  banks: StripeBankFacts[]
  cards: StripeCardFacts[]
  defaultId: string | null
  pendingLookupFailed: boolean
}

export interface WaitingBankSetup {
  setupIntentId: string
  paymentMethodId: string
  bankName: string | null
  last4: string | null
  routingLast4: string | null
  createdAt: Date | null
  /**
   * True while Stripe waits on the TENANT to confirm the deposits
   * (requires_action + verify_with_microdeposits). False while Stripe is
   * checking what they entered (processing): nothing to chase them about, and
   * the setup cannot be canceled until that check ends.
   */
  awaitingTenant: boolean
  /** Stripe's microdeposit details, present only while it waits on the tenant. */
  microdeposits: {
    /** Unix seconds: when the deposit reaches the tenant's bank. */
    arrivalDate: number | null
    type: string | null
    verifyUrl: string | null
  } | null
}

/**
 * The bank SetupIntents on this customer still verifying: waiting on the
 * tenant's microdeposits, or with Stripe checking the ones they entered
 * (processing). Both are banks that are on their way and cannot be charged
 * yet, so the portal, the agent, the nudge and confirm-setup all count the
 * same set (services/tenantBankMethods.bankSetupState calls both 'waiting').
 * Up to 20 setups are read, newest first, the payment method expanded so a
 * bank can be told from a card.
 */
export async function listWaitingBankSetups(stripe: Stripe, customerId: string): Promise<WaitingBankSetup[]> {
  const list = await stripe.setupIntents.list({
    customer: customerId,
    limit: 20,
    expand: ['data.payment_method'],
  })
  const out: WaitingBankSetup[] = []
  for (const si of list.data) {
    const na = si.next_action as { type?: string; verify_with_microdeposits?: any } | null | undefined
    const awaitingTenant = si.status === 'requires_action' && na?.type === 'verify_with_microdeposits'
    if (!awaitingTenant && si.status !== 'processing') continue
    const pm = si.payment_method as any
    const pmId: string | null = typeof pm === 'string' ? pm : pm?.id ?? null
    if (!pmId) continue
    const expanded = pm && typeof pm !== 'string'
    if (expanded && pm.type && pm.type !== 'us_bank_account') continue
    // A setup being processed is only a bank when Stripe says so (a card setup
    // can sit in processing too); one waiting on microdeposits is always a bank.
    if (!awaitingTenant && !(expanded && pm.type === 'us_bank_account')) continue
    const bank = expanded ? pm.us_bank_account : null
    const md = awaitingTenant ? na?.verify_with_microdeposits ?? {} : null
    out.push({
      setupIntentId: si.id,
      paymentMethodId: pmId,
      bankName: bank?.bank_name ?? null,
      last4: bank?.last4 ?? null,
      routingLast4: bank?.routing_number ? String(bank.routing_number).slice(-4) : null,
      createdAt: typeof si.created === 'number' ? new Date(si.created * 1000) : null,
      awaitingTenant,
      microdeposits: md
        ? {
            arrivalDate: typeof md.arrival_date === 'number' ? md.arrival_date : null,
            type: md.microdeposit_type ?? null,
            verifyUrl: md.hosted_verification_url ?? null,
          }
        : null,
    })
  }
  return out
}

async function customerDefaultId(stripe: Stripe, customerId: string): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId)
  if (!customer || ('deleted' in customer && customer.deleted)) return null
  const d = (customer as any).invoice_settings?.default_payment_method
  return typeof d === 'string' ? d : d?.id ?? null
}

/**
 * Every saved method on the customer as Stripe sees it. The two method lists
 * must succeed (a failure here throws: never answer "no bank" on a lookup
 * error). The waiting-setup list and the default are best-effort — `strict`
 * makes them throw too, for the callers that decide something on them.
 */
export async function readStripeMethodFacts(
  customerId: string,
  opts: { strict?: boolean } = {},
): Promise<StripeMethodFacts> {
  const stripe = getStripe()
  // ACH first, then cards: the order the callers (and their tests) rely on.
  const [achList, cardList] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: 'us_bank_account', limit: 20 }),
    stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 }),
  ])
  let waiting: WaitingBankSetup[] = []
  let pendingLookupFailed = false
  let defaultId: string | null = null
  const [w, d] = await Promise.allSettled([
    listWaitingBankSetups(stripe, customerId),
    customerDefaultId(stripe, customerId),
  ])
  if (w.status === 'fulfilled') waiting = w.value
  else {
    if (opts.strict) throw w.reason
    pendingLookupFailed = true
    logger.warn({ err: w.reason, customerId }, '[tenant-banks] could not list waiting bank setups')
  }
  if (d.status === 'fulfilled') defaultId = d.value
  else {
    if (opts.strict) throw d.reason
    logger.warn({ err: d.reason, customerId }, '[tenant-banks] could not read the default payment method')
  }

  const waitingByPm = new Map(waiting.map((x) => [x.paymentMethodId, x]))
  const attachedIds = new Set<string>()
  const banks: StripeBankFacts[] = achList.data.map((pm) => {
    attachedIds.add(pm.id)
    const wait = waitingByPm.get(pm.id) ?? null
    const routing = pm.us_bank_account?.routing_number ?? null
    return {
      id: pm.id,
      bankName: pm.us_bank_account?.bank_name ?? null,
      last4: pm.us_bank_account?.last4 ?? null,
      routingLast4: routing ? String(routing).slice(-4) : null,
      attached: true,
      verified: !wait,
      verifying: !!wait,
      checking: !!wait && !wait.awaitingTenant,
      setupIntentId: wait?.setupIntentId ?? null,
      waitingSince: wait?.createdAt ?? null,
    }
  })
  // A microdeposit bank is not attached until it is confirmed (S637). It is
  // still the tenant's bank, and the one line that tells them they have NOT
  // paid yet hangs off it, so it is listed — unverified.
  for (const wait of waiting) {
    if (attachedIds.has(wait.paymentMethodId)) continue
    attachedIds.add(wait.paymentMethodId)
    banks.push({
      id: wait.paymentMethodId,
      bankName: wait.bankName,
      last4: wait.last4,
      routingLast4: wait.routingLast4,
      attached: false,
      verified: false,
      verifying: true,
      checking: !wait.awaitingTenant,
      setupIntentId: wait.setupIntentId,
      waitingSince: wait.createdAt,
    })
  }
  const cards: StripeCardFacts[] = cardList.data.map((pm) => ({
    id: pm.id,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
    country: pm.card?.country ?? null,
  }))
  return { banks, cards, defaultId, pendingLookupFailed }
}

// ─── What the account owes and has switched on ──────────────────────────────

export interface RemovalFacts {
  /** A charge on the tenant (or their household's current lease) can be paid now. */
  owes: boolean
  /**
   * Autopay would charge this tenant: an enabled schedule on a lease that is
   * still active — the rule jobs/autopayRunner.ts itself charges by. A
   * schedule left switched on when the lease ended never fires again, and the
   * tenant can no longer see it to turn it off (GET /api/autopay lists active
   * leases only), so it must not keep them from removing the bank.
   */
  autopayOn: boolean
  flexpayOn: boolean
  /**
   * GAM paid a bill through FlexPay and still has to draw that money back from
   * the tenant's bank: an advance fronted and not yet drawn, a draw on its way,
   * or a draw that bounced and is waiting to retry. Enrollment alone does not
   * say this — cancelling FlexPay (DELETE /api/tenants/flexpay) only turns
   * enrollment off, and the draw still runs on its date (services/flexpay.ts
   * runFlexPayPulls selects 'fronted' advances whatever the enrollment). With
   * no bank on file that draw is refused, and after three tries the advance is
   * written off: GAM absorbs the rent it fronted. A written-off advance is not
   * counted here — nothing draws it from the bank (it is recovered from the
   * tenant's next payment to the landlord, supersedence.ts), so it never keeps
   * a bank on the account.
   */
  flexpayDrawOwed: boolean
  /** Methods an autopay schedule names. */
  pinnedIds: string[]
}

/** The tenant's own charges, plus every charge on a lease they are still on ($1 = tenant id). */
const HOUSEHOLD_ROWS_SQL = `(p.tenant_id = $1 OR p.lease_id IN (
                   SELECT lt.lease_id FROM lease_tenants lt
                    WHERE lt.tenant_id = $1 AND lt.removed_at IS NULL
                      AND lt.status NOT IN ('removed','void')))`

/** Run a read on the caller's transaction when one is given, else on the pool. */
function reader(client?: PoolClient) {
  return async <T>(sql: string, params: unknown[]): Promise<T[]> =>
    client ? (await client.query(sql, params as any[])).rows as T[] : query<T>(sql, params as any[])
}

/**
 * The tenant's own charges on any lease, plus every charge on a lease they are
 * still on (one household balance). "Owes" is the shared payable rule. A
 * payment already moving is not "owed": the bank it was made from is kept by
 * pullBlockFor (Stripe names that bank), and a payment from anywhere else — a
 * card, or a co-tenant's own bank — never needs this tenant's bank. The FlexPay
 * draw is the tenant's own (GAM's pull, never part of a household balance —
 * payableRowSql leaves it out on purpose), so it is read on its own. A removal
 * passes its transaction, so the read sees what it locked.
 */
export async function readRemovalFacts(tenantId: string, client?: PoolClient): Promise<RemovalFacts> {
  const scope = HOUSEHOLD_ROWS_SQL
  const rows = await reader(client)<any>(
    `SELECT EXISTS (SELECT 1 FROM payments p WHERE ${scope} AND ${payableRowSql('p')}) AS owes,
            EXISTS (SELECT 1 FROM tenant_autopay a JOIN leases l ON l.id = a.lease_id
                     WHERE a.tenant_id = $1 AND a.enabled AND l.status = 'active') AS autopay_on,
            COALESCE((SELECT t.flexpay_enrolled FROM tenants t WHERE t.id = $1), FALSE) AS flexpay_on,
            -- An advance not yet drawn back ('fronted'), drawn and not yet
            -- settled ('pulled' — a bounced draw waiting to retry stays here
            -- until the last retry fails), or a pre-S655 state ('pending',
            -- 'nsf'). Or a FlexPay draw row still moving or due to retry; a
            -- row that failed for good (next_retry_at NULL) is written off.
            (EXISTS (SELECT 1 FROM flexpay_advances fa
                      WHERE fa.tenant_id = $1 AND fa.status IN ('pending','fronted','pulled','nsf'))
             OR EXISTS (SELECT 1 FROM payments fp
                         WHERE fp.tenant_id = $1 AND fp.entry_description = 'FLEXPAY'
                           AND (fp.status IN ('pending','processing')
                                OR (fp.status = 'failed' AND fp.next_retry_at IS NOT NULL)))) AS flexpay_draw_owed,
            ARRAY(SELECT DISTINCT a.payment_method_id FROM tenant_autopay a
                   WHERE a.tenant_id = $1 AND a.payment_method_id IS NOT NULL) AS pinned_ids`,
    [tenantId])
  const r = rows[0] ?? {}
  return {
    owes: r.owes === true,
    autopayOn: r.autopay_on === true,
    flexpayOn: r.flexpay_on === true,
    flexpayDrawOwed: r.flexpay_draw_owed === true,
    pinnedIds: Array.isArray(r.pinned_ids) ? r.pinned_ids : [],
  }
}

/**
 * Why the tenant's ONLY verified bank cannot be removed now, or null when it
 * can (Nic: nothing owed and autopay off — they moved out). Plain words, with
 * the next step.
 *
 * FlexPay is read as part of the same rule: money GAM fronted through FlexPay
 * is owed until its draw clears, whether or not FlexPay is still on, and an
 * enrollment is an automatic pull from this bank the way autopay is (joining
 * FlexPay turns autopay off). Without them the draw would find no bank and GAM
 * would absorb the rent it fronted.
 *
 * "Autopay is on" is any switched-on schedule on a current lease, whichever
 * method it is pinned to — the rule is Nic's "autopay is off", not "autopay
 * uses this bank".
 */
export function onlyVerifiedBankBlock(f: Omit<RemovalFacts, 'pinnedIds'>): string | null {
  if (f.flexpayDrawOwed) {
    return 'This is your only verified bank, and FlexPay still has to draw what it paid on your bill from it. ' +
      'Add and verify another bank first, or wait until that draw has cleared, then you can remove this one.'
  }
  if (f.flexpayOn) {
    return 'This is your only verified bank, and FlexPay draws from it. ' +
      'Add and verify another bank first, then you can remove this one.'
  }
  if (!f.owes && !f.autopayOn) return null
  const why = f.owes && f.autopayOn ? 'you still owe a balance and autopay is on'
    : f.owes ? 'you still owe a balance'
    : 'autopay is on'
  const instead = f.owes && f.autopayOn ? 'pay what you owe and turn off autopay'
    : f.owes ? 'pay what you owe'
    : 'turn off autopay'
  return `This is your only verified bank, and ${why}. ` +
    `Add and verify another bank first, or ${instead}, then you can remove this one.`
}

// ─── Pulls still in flight, and the bank each was made from ─────────────────

/**
 * A pull from one of the household's saved methods that may still need that
 * method: clearing (processing, or sent and not back yet), or bounced with a
 * retry scheduled. A retry confirms the SAME payment on the SAME method
 * (achRetry.retryConfirmParams), so that method must still be on the customer
 * when the retry runs: once it is detached Stripe refuses the confirm, the
 * retry is never tried again, and a FlexPay draw is left 'pulled' with nothing
 * drawing it and nothing writing it off.
 */
export interface PullInFlight {
  intentId: string
  /** The day ('YYYY-MM-DD', the property's calendar) a bounced pull is tried again; null while it is clearing. */
  retryOn: string | null
  /**
   * The retry is already due (that day has started on the property's
   * calendar): the daily retry run tries it at its next run, which may be
   * tomorrow, so no day is named.
   */
  retryOverdue: boolean
}

export interface PullMethods {
  /** Each pull, with the method Stripe says it was made from (null: it can no longer charge anything). */
  pulls: (PullInFlight & { paymentMethodId: string | null })[]
  /** Stripe could not be asked about at least one pull, so which bank it is on is unknown. */
  lookupFailed: boolean
  /**
   * More pulls are in flight than one request asks Stripe about
   * (PULL_LOOKUP_CAP), so which bank the rest are on is unknown.
   */
  overflow: boolean
}

const NO_PULLS: PullMethods = { pulls: [], lookupFailed: false, overflow: false }

/**
 * The most pulls one request asks Stripe about. A household past it holds
 * back every verified bank (fails closed) rather than deciding on the first
 * ones only — a pull past the cap may be the one made from the bank being
 * removed. Production has a handful in flight platform-wide.
 */
export const PULL_LOOKUP_CAP = 25

/**
 * The household's pulls still in flight (the same household as the removal
 * rule), plus any pull this tenant paid on another lease (their remittance
 * names the intent). Rent, utilities and GAM's FlexPay draw alike — every one
 * is retried on the method it was made from.
 *
 * Returns at most PULL_LOOKUP_CAP + 1 pulls: one more than resolvePullMethods
 * asks Stripe about, so it can tell "exactly the cap" from "past the cap" and
 * hold every verified bank back in the second case.
 */
export async function readPullsInFlight(tenantId: string, client?: PoolClient): Promise<PullInFlight[]> {
  const rows = await reader(client)<{
    intent_id: string | null; clearing: boolean; retry_on: string | null; retry_overdue: boolean | null
  }>(
    `SELECT p.stripe_payment_intent_id AS intent_id,
            BOOL_OR(p.status <> 'failed') AS clearing,
            MIN(CASE WHEN p.status = 'failed'
                     THEN to_char((p.next_retry_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date,
                                  'YYYY-MM-DD') END) AS retry_on,
            -- The retry is already due (next_retry_at is the start of the
            -- property's day, and it has come): the daily retry run tries it at
            -- its next run, so the sentence says "shortly". A retry due today
            -- but read after that day's run is tried tomorrow, not "today".
            BOOL_OR(p.status = 'failed' AND p.next_retry_at <= NOW()) AS retry_overdue
       FROM payments p
       LEFT JOIN units un ON un.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE p.stripe_payment_intent_id IS NOT NULL
        AND (p.status IN ('processing','pending')
             OR (p.status = 'failed' AND p.next_retry_at IS NOT NULL))
        AND (${HOUSEHOLD_ROWS_SQL}
             OR p.stripe_payment_intent_id IN (
                  SELECT r.stripe_payment_intent_id FROM tenant_remittances r
                   WHERE r.tenant_id = $1 AND r.stripe_payment_intent_id IS NOT NULL))
      GROUP BY p.stripe_payment_intent_id
      ORDER BY p.stripe_payment_intent_id
      LIMIT $2`,
    [tenantId, PULL_LOOKUP_CAP + 1])
  return rows
    .filter((r) => typeof r.intent_id === 'string' && r.intent_id.length > 0)
    .map((r) => ({
      intentId: r.intent_id as string,
      retryOn: r.clearing ? null : r.retry_on ?? null,
      retryOverdue: !r.clearing && r.retry_overdue === true,
    }))
}

/**
 * The method a payment was made from, or null when it can no longer charge
 * anything: Stripe has finished it (succeeded or canceled), or it names no
 * method. After a bounce Stripe clears the method off the payment and carries
 * it on last_payment_error — where the retry reads it too.
 */
export function intentPaymentMethodId(pi: Pick<Stripe.PaymentIntent, 'status' | 'payment_method' | 'last_payment_error'>): string | null {
  if (pi.status === 'succeeded' || pi.status === 'canceled') return null
  const onIntent = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null
  const onError = (pi.last_payment_error as { payment_method?: string | { id?: string } | null } | null | undefined)
    ?.payment_method
  const fromError = typeof onError === 'string' ? onError : onError?.id ?? null
  return onIntent ?? fromError ?? null
}

/** Stripe has no such payment on this account, so it cannot be retried on anything. */
function isMissingIntent(e: unknown): boolean {
  const err = e as { code?: string; raw?: { code?: string } } | null
  return err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing'
}

/**
 * Asks Stripe which method each pull was made from. `strict` (a removal)
 * throws when Stripe cannot be asked; otherwise (a screen) the pull is marked
 * unknown and every verified bank is held back until Stripe answers.
 *
 * Past PULL_LOOKUP_CAP pulls (readPullsInFlight returns one more than the cap
 * to say so), only the first PULL_LOOKUP_CAP are asked about and the result is
 * marked `overflow`: every verified bank is then held back, strict or not,
 * because a pull not asked about may be the one made from it.
 */
export async function resolvePullMethods(
  inFlight: PullInFlight[],
  opts: { strict?: boolean } = {},
): Promise<PullMethods> {
  if (!inFlight.length) return NO_PULLS
  const overflow = inFlight.length > PULL_LOOKUP_CAP
  const pulls = overflow ? inFlight.slice(0, PULL_LOOKUP_CAP) : inFlight
  if (overflow) {
    logger.warn({ lookedUp: PULL_LOOKUP_CAP }, '[tenant-banks] more pulls in flight than are looked up — every verified bank is held back')
  }
  const stripe = getStripe()
  const answers = await Promise.allSettled(
    pulls.map(async (p) => stripe.paymentIntents.retrieve(p.intentId)))
  const out: PullMethods = { pulls: [], lookupFailed: false, overflow }
  answers.forEach((a, i) => {
    if (a.status === 'fulfilled') {
      out.pulls.push({ ...pulls[i], paymentMethodId: intentPaymentMethodId(a.value) })
    } else if (isMissingIntent(a.reason)) {
      out.pulls.push({ ...pulls[i], paymentMethodId: null })
    } else {
      if (opts.strict) throw a.reason
      out.lookupFailed = true
      logger.warn({ err: a.reason, intent: pulls[i].intentId }, '[tenant-banks] could not read a pull still in flight')
    }
  })
  return out
}

/** 'YYYY-MM-DD' → "Sunday, October 4" (a calendar date, so read in UTC). */
function calendarDayLabel(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * Why a verified bank must stay while a pull made from it is still clearing or
 * due to be tried again, or null. Applies even beside another verified bank.
 */
export function pullBlockFor(methodId: string, pulls: PullMethods): string | null {
  const fromIt = pulls.pulls.filter((p) => p.paymentMethodId === methodId)
  if (fromIt.some((p) => p.retryOn === null)) {
    return 'A payment from this bank is still clearing. ' +
      'You can remove it once that payment has cleared (a bank payment takes about 4 business days).'
  }
  if (fromIt.length) {
    // A retry already due (its day has started, today included) is tried at
    // the daily retry run's next run, which may be tomorrow, so the sentence
    // never names a day gone by or a today whose run already went.
    const retryOn = fromIt.map((p) => p.retryOn as string).sort()[0]
    const when = fromIt.some((p) => p.retryOverdue) || !retryOn ? 'shortly' : `on ${calendarDayLabel(retryOn)}`
    return `A payment from this bank didn't go through and is set to be tried again from it ${when}. ` +
      'You can remove it once that payment has cleared.'
  }
  if (pulls.overflow) {
    return 'Too many payments on your household\'s account are still clearing for us to tell whether one came from this bank. ' +
      'You can remove it once some of them have cleared.'
  }
  if (pulls.lookupFailed) {
    return 'We could not check with our payment processor whether a payment from this bank is still clearing. ' +
      'Try again in a minute.'
  }
  return null
}

const BANK_BEING_CHECKED =
  'We are checking the verification you entered for this bank with our payment processor right now. ' +
  'You can remove it once that check finishes — try again later.'

/** Removal rule for one saved method, given everything else on file. */
export function removalBlockFor(
  methodId: string,
  facts: StripeMethodFacts,
  account: RemovalFacts,
  pulls: PullMethods = NO_PULLS,
): string | null {
  const bank = facts.banks.find((b) => b.id === methodId)
  // Cards are not affected by the keep-the-bank rule.
  if (!bank) return null
  // Stripe will not cancel a setup while it checks the deposits the tenant
  // entered, so the removal would only fail. Say when it can be done instead.
  if (bank.checking) return BANK_BEING_CHECKED
  // A bank still verifying never paid anything.
  if (!bank.verified) return null
  // A pull from this very bank keeps it, whatever else is on file.
  const pull = pullBlockFor(methodId, pulls)
  if (pull) return pull
  const otherVerified = facts.banks.some((b) => b.verified && b.id !== methodId)
  if (otherVerified) return null
  return onlyVerifiedBankBlock(account)
}

// ─── The read every screen and the agent use ────────────────────────────────

function toWire(
  facts: StripeMethodFacts,
  account: RemovalFacts,
  achSuspended: boolean,
  pulls: PullMethods = NO_PULLS,
): SavedMethod[] {
  const pinned = new Set(account.pinnedIds)
  const banks: SavedBankMethod[] = facts.banks.map((b) => {
    const block = removalBlockFor(b.id, facts, account, pulls)
    return {
      id: b.id,
      type: 'ach',
      bankName: b.bankName,
      last4: b.last4,
      verified: b.verified,
      verifying: b.verifying,
      verificationStep: !b.verifying ? null : b.checking ? 'checking' : 'deposits',
      chargeable: b.verified && !achSuspended,
      isDefault: b.attached && b.id === facts.defaultId,
      autopayPinned: pinned.has(b.id),
      canRemove: block === null,
      removeBlockedReason: block,
    }
  })
  const cards: SavedCardMethod[] = facts.cards.map((c) => ({
    id: c.id,
    type: 'card',
    brand: c.brand,
    last4: c.last4,
    expMonth: c.expMonth,
    expYear: c.expYear,
    country: c.country,
    verified: true,
    verifying: false,
    verificationStep: null,
    chargeable: true,
    isDefault: c.id === facts.defaultId,
    autopayPinned: pinned.has(c.id),
    canRemove: true,
    removeBlockedReason: null,
  }))
  return [...banks, ...cards]
}

/**
 * The tenant's saved rent-payment methods, each with its own state. Null when
 * the tenant does not exist. Throws when Stripe cannot list the methods.
 */
export async function loadTenantPaymentMethods(tenantId: string): Promise<TenantPaymentMethods | null> {
  const rows = await query<{ stripe_customer_id: string | null; ach_suspended_at: string | Date | null }>(
    `SELECT stripe_customer_id, ach_suspended_at FROM tenants WHERE id = $1`,
    [tenantId])
  const tenant = rows[0]
  if (!tenant) return null
  const achSuspended = tenant.ach_suspended_at != null
  if (!tenant.stripe_customer_id) {
    return { hasCustomer: false, methods: [], achSuspended, pendingLookupFailed: false }
  }
  const [facts, account, pulls] = await Promise.all([
    readStripeMethodFacts(tenant.stripe_customer_id),
    readRemovalFacts(tenantId),
    readPullsInFlight(tenantId).then((p) => resolvePullMethods(p)),
  ])
  return {
    hasCustomer: true,
    methods: toWire(facts, account, achSuspended, pulls),
    achSuspended,
    pendingLookupFailed: facts.pendingLookupFailed,
  }
}

// ─── The summary on the tenants row ─────────────────────────────────────────

/** The bank the tenants row names today (bank_last4 / bank_routing_last4). */
export interface BankOnFile {
  last4: string | null
  routingLast4: string | null
}

/**
 * The bank GAM names as "on file": the default when it is a verified bank;
 * else the verified bank already on file (`onFile`), so a card made the
 * default, or another bank removed, never swaps the bank shown for one the
 * tenant did not pick; else any verified bank; else the newest still verifying.
 */
export function summaryBank(
  banks: StripeBankFacts[],
  defaultId: string | null,
  onFile: BankOnFile | null = null,
): StripeBankFacts | null {
  const verified = banks.filter((b) => b.verified)
  const def = verified.find((b) => b.id === defaultId)
  if (def) return def
  if (onFile?.last4) {
    const kept = verified.find((b) => b.last4 === onFile.last4
      && (!onFile.routingLast4 || !b.routingLast4 || b.routingLast4 === onFile.routingLast4))
    if (kept) return kept
  }
  if (verified.length) return verified[0]
  const verifying = banks
    .filter((b) => b.verifying)
    .sort((a, b) => (b.waitingSince?.getTime() ?? 0) - (a.waitingSince?.getTime() ?? 0))
  return verifying[0] ?? null
}

async function lockTenantBanks(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tenant_bank:${tenantId}`])
}

interface BankSummaryRow {
  ach_verified: boolean
  bank_last4: string | null
  bank_routing_last4: string | null
  bank_pending_since: Date | null
}

/** The bank a tenants row names now, for summaryBank to keep. */
function bankOnFile(row: Pick<BankSummaryRow, 'bank_last4' | 'bank_routing_last4'>): BankOnFile {
  return { last4: row.bank_last4 ?? null, routingLast4: row.bank_routing_last4 ?? null }
}

/**
 * Does the tenants row still name a bank Stripe no longer holds — a verified
 * flag with no verified bank behind it, or a bank on file that is not on the
 * customer at all? (A stale waiting flag is the nudge job's to clear.)
 */
function rowNamesMissingBank(row: BankSummaryRow, banks: StripeBankFacts[]): boolean {
  if (row.ach_verified && !banks.some((b) => b.verified)) return true
  if (row.bank_last4 && !banks.some((b) => b.last4 === row.bank_last4)) return true
  return false
}

/**
 * The tenants row's bank summary from Stripe's facts. ach_verified is only ever
 * turned OFF here (no verified bank left): turning it on is
 * recordVerifiedTenantBank's alone, because before the deploy an ACH return
 * blocked bank payments by writing ach_verified = FALSE, and lifting that block
 * is for a person (planBankBackfill). bank_pending_since keeps its start while
 * a bank still waits. The bank named on file follows a verified default, and
 * otherwise stays the one already named while it is still verified
 * (summaryBank).
 */
async function writeBankSummary(
  client: PoolClient,
  tenantId: string,
  banks: StripeBankFacts[],
  defaultId: string | null,
  /** The bank the row names now: kept when the default is not a verified bank and it still is one. */
  onFile: BankOnFile | null,
): Promise<void> {
  const shown = summaryBank(banks, defaultId, onFile)
  await client.query(
    `UPDATE tenants
        SET ach_verified       = CASE WHEN $2::boolean THEN ach_verified ELSE FALSE END,
            bank_last4         = $3,
            bank_routing_last4 = $4,
            bank_pending_since = CASE WHEN $5::boolean THEN COALESCE(bank_pending_since, NOW()) ELSE NULL END
      WHERE id = $1`,
    [tenantId, banks.some((b) => b.verified), shown?.last4 ?? null, shown?.routingLast4 ?? null,
     banks.some((b) => b.verifying)])
}

/** An autopay schedule pinned to a method no longer on the customer follows the default. */
async function clearStalePins(client: PoolClient, tenantId: string, facts: StripeMethodFacts): Promise<void> {
  const onFile = [...facts.banks.map((b) => b.id), ...facts.cards.map((c) => c.id)]
  await client.query(
    `UPDATE tenant_autopay SET payment_method_id = NULL, updated_at = NOW()
      WHERE tenant_id = $1 AND payment_method_id IS NOT NULL
        AND NOT (payment_method_id = ANY($2::text[]))`,
    [tenantId, onFile])
}

/**
 * Put the tenants row (ach_verified, bank_last4 / routing, bank_pending_since)
 * and the autopay pins back in line with Stripe, from fresh facts, under the
 * tenant's bank lock. For a removal whose database write failed after Stripe
 * had already removed the method: without it the row keeps ach_verified on
 * (the FlexPay / FlexDeposit gate) and keeps naming a bank that is gone, and a
 * retry only finds "not saved on your account". Returns the saved methods as
 * they are now, or null when the tenant has no Stripe customer. Throws when
 * Stripe or the database cannot be reached.
 */
export async function resyncTenantBankSummary(tenantId: string): Promise<{ methods: SavedMethod[] } | null> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await lockTenantBanks(client, tenantId)
    const t = (await client.query<{ stripe_customer_id: string | null; ach_suspended_at: Date | null }
                                  & Pick<BankSummaryRow, 'bank_last4' | 'bank_routing_last4'>>(
      `SELECT stripe_customer_id, ach_suspended_at, bank_last4, bank_routing_last4
         FROM tenants WHERE id = $1`, [tenantId])).rows[0]
    if (!t?.stripe_customer_id) {
      await client.query('ROLLBACK')
      return null
    }
    const facts = await readStripeMethodFacts(t.stripe_customer_id, { strict: true })
    await writeBankSummary(client, tenantId, facts.banks, facts.defaultId, bankOnFile(t))
    await clearStalePins(client, tenantId, facts)
    await client.query('COMMIT')
    const [account, pulls] = await Promise.all([
      readRemovalFacts(tenantId),
      readPullsInFlight(tenantId).then((p) => resolvePullMethods(p)),
    ])
    return { methods: toWire(facts, account, t.ach_suspended_at != null, pulls) }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ─── Remove a saved method ──────────────────────────────────────────────────

export interface RemoveResult {
  removedId: string
  /** The saved methods after the removal. */
  methods: SavedMethod[]
}

/**
 * DELETE /api/stripe/tenant/payment-methods/:id. The tenant removes one of
 * their own saved methods:
 *   - a card: detached (a card never blocks, and the one-card rule is unchanged);
 *   - a bank still verifying: its SetupIntent is canceled (it was never attached);
 *   - a verified bank: detached, unless a pull made from it is still clearing
 *     or due to be tried again (pullBlockFor), or it is the only verified bank
 *     and the account still needs it (onlyVerifiedBankBlock) — then 409 with
 *     the reason. Stripe must say which bank each pull came from; when it
 *     cannot, nothing is removed (503). A household with more pulls in flight
 *     than are looked up (PULL_LOOKUP_CAP) keeps every verified bank (409).
 * An autopay schedule pinned to it falls back to the default method. When the
 * default is removed, another verified bank becomes the default.
 *
 * Stripe is changed before the database write commits, so a database failure
 * after that point cannot be undone at Stripe. Instead the row is put back in
 * line with Stripe from fresh facts in a new transaction
 * (resyncTenantBankSummary), and the removal is reported as done. A method
 * that is already gone (the 404 path) does the same check, so a removal whose
 * write was lost is corrected the next time the tenant asks.
 */
export async function removeTenantPaymentMethod(tenantId: string, paymentMethodId: string): Promise<RemoveResult> {
  const client = await getClient()
  let clientReleased = false
  // A client whose write failed is destroyed rather than pooled, so its session
  // — and the bank lock it holds if the ROLLBACK did not get through — ends.
  const releaseClient = (destroy: boolean) => {
    if (clientReleased) return
    clientReleased = true
    client.release(destroy ? true : undefined)
  }
  try {
    await client.query('BEGIN')
    await lockTenantBanks(client, tenantId)

    const t = (await client.query<{ stripe_customer_id: string | null; ach_suspended_at: Date | null } & BankSummaryRow>(
      `SELECT stripe_customer_id, ach_suspended_at,
              ach_verified, bank_last4, bank_routing_last4, bank_pending_since
         FROM tenants WHERE id = $1`, [tenantId])).rows[0]
    if (!t) throw new AppError(404, 'Tenant not found')
    const notOnAccount = new AppError(404,
      'That payment method is not saved on your account. It may already have been removed.')
    if (!t.stripe_customer_id) throw notOnAccount
    const customerId = t.stripe_customer_id

    // Fresh, at the moment of the action, under the lock.
    const couldNotCheck = () => new AppError(503,
      'We could not check your saved accounts with our payment processor just now. Nothing was removed — try again in a minute.')
    let facts: StripeMethodFacts
    try {
      facts = await readStripeMethodFacts(customerId, { strict: true })
    } catch {
      throw couldNotCheck()
    }
    const bank = facts.banks.find((b) => b.id === paymentMethodId) ?? null
    const card = facts.cards.find((c) => c.id === paymentMethodId) ?? null
    if (!bank && !card) {
      // Not on the account. If the row still names a bank Stripe no longer
      // holds (a removal whose write was lost after Stripe detached it), bring
      // it back in line now — the tenant has no other way to.
      if (rowNamesMissingBank(t, facts.banks)) {
        logger.warn({ tenantId, paymentMethodId }, '[tenant-banks] bank summary out of line with Stripe — corrected')
        await writeBankSummary(client, tenantId, facts.banks, facts.defaultId, bankOnFile(t))
      }
      await clearStalePins(client, tenantId, facts)
      await client.query('COMMIT')
      throw notOnAccount
    }

    // The tenants row is locked before the account and the pulls in flight are
    // read, so what committed while this removal ran is seen here instead of
    // being read from before it:
    //   - a FlexPay enrollment (it keeps the only bank). This lock does NOT
    //     cover an enrollment that read its eligibility before this removal and
    //     writes after it commits: enrollFlexPay (services/flexpay.ts) checks
    //     ach_verified outside its transaction and its UPDATE re-checks
    //     nothing, so it can enroll a tenant whose only bank this removed.
    //     Closing that needs enrollFlexPay's UPDATE to require
    //     ach_verified AND ach_suspended_at IS NULL (or take this lock and read
    //     again) — a FlexPay change, not one this removal can make.
    //   - a payment the tenant started. Pay Now writes its receipt
    //     (tenant_remittances, which holds a share lock on this row) before it
    //     charges, so one that wrote its receipt first commits before this lock
    //     is granted and its pull is read below; one that starts after waits on
    //     its receipt until this removal commits, and Stripe then refuses the
    //     detached bank. Reading the pulls before the lock let a charge that
    //     committed while the removal waited go unseen, and its bank was
    //     detached under it — a bounce could then never be retried.
    await client.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId])
    const account = await readRemovalFacts(tenantId, client)

    // Which bank each pull still in flight was made from. Removing a verified
    // bank decides on it, so Stripe must answer; for anything else it only
    // fills in the list returned below.
    const inFlight = await readPullsInFlight(tenantId, client)
    let pulls: PullMethods
    if (bank?.verified) {
      try {
        pulls = await resolvePullMethods(inFlight, { strict: true })
      } catch {
        throw couldNotCheck()
      }
    } else {
      pulls = await resolvePullMethods(inFlight)
    }

    const block = removalBlockFor(paymentMethodId, facts, account, pulls)
    if (block) throw new AppError(409, block)

    const stripe = getStripe()
    const stripeFailed = (e: unknown) => {
      logger.error({ err: e, tenantId, paymentMethodId }, '[tenant-banks] remove failed at Stripe')
      return new AppError(502,
        'We could not remove that account just now. Nothing changed — try again in a minute.')
    }
    // Detach first: if that fails nothing has changed. A bank still verifying
    // is normally not attached, and canceling its setup is the whole removal.
    if (card || bank?.attached) {
      try { await stripe.paymentMethods.detach(paymentMethodId) } catch (e) { throw stripeFailed(e) }
    }
    if (bank?.setupIntentId) {
      try {
        await stripe.setupIntents.cancel(bank.setupIntentId)
      } catch (e) {
        if (!bank.attached) throw stripeFailed(e)
        // Already detached, so the removal stands; the open setup is logged
        // for a person to cancel by hand.
        logger.warn({ err: e, tenantId, setupIntent: bank.setupIntentId }, '[tenant-banks] setup left open after the bank was removed')
      }
    }

    const remainingBanks = facts.banks.filter((b) => b.id !== paymentMethodId)
    const remainingCards = facts.cards.filter((c) => c.id !== paymentMethodId)
    let defaultId = facts.defaultId
    if (facts.defaultId === paymentMethodId) {
      // The default went with it. A verified bank comes before any card; with
      // none left the default stays empty and autopay falls back on its own.
      defaultId = null
      const next = remainingBanks.find((b) => b.verified && b.attached)
      if (next) {
        try {
          await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: next.id } })
          defaultId = next.id
        } catch (e) {
          logger.error({ err: e, tenantId, next: next.id }, '[tenant-banks] could not make the remaining bank the default')
        }
      }
    }

    // Stripe has removed it. From here a database failure cannot say "nothing
    // changed": the row is brought back in line with Stripe instead.
    try {
      // An autopay schedule pinned to it follows the default from now on.
      await client.query(
        `UPDATE tenant_autopay SET payment_method_id = NULL, updated_at = NOW()
          WHERE tenant_id = $1 AND payment_method_id = $2`,
        [tenantId, paymentMethodId])
      if (bank) await writeBankSummary(client, tenantId, remainingBanks, defaultId, bankOnFile(t))
      await client.query('COMMIT')
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId, paymentMethodId },
        '[tenant-banks] removed at Stripe but the database write failed — resyncing from Stripe')
      await client.query('ROLLBACK').catch(() => {})
      releaseClient(true)
      let healed: { methods: SavedMethod[] } | null = null
      try {
        healed = await resyncTenantBankSummary(tenantId)
      } catch (e) {
        logger.error({ err: e, tenantId, paymentMethodId },
          '[tenant-banks] resync after a removal failed — the tenants row still names the removed bank; ' +
          'the next DELETE on the tenant corrects it')
      }
      if (!healed) {
        throw new AppError(500,
          'That account was removed, but we could not finish updating your account just now. ' +
          'Open your Payments page again in a minute to see what is on file.')
      }
      return { removedId: paymentMethodId, methods: healed.methods }
    }

    const after: StripeMethodFacts = {
      banks: remainingBanks,
      cards: remainingCards,
      defaultId,
      pendingLookupFailed: false,
    }
    const accountAfter: RemovalFacts = {
      ...account,
      pinnedIds: account.pinnedIds.filter((id) => id !== paymentMethodId),
    }
    return { removedId: paymentMethodId, methods: toWire(after, accountAfter, t.ach_suspended_at != null, pulls) }
  } catch (e) {
    if (!clientReleased) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    releaseClient(false)
  }
}

// ─── Choose the default ─────────────────────────────────────────────────────

/**
 * A tenant who has never saved a bank or card (no Stripe customer yet) asked
 * to change their default. Plain words with the next step — never "Stripe
 * customer not initialized".
 */
export const NO_SAVED_METHODS =
  'You have no saved payment methods yet. Add a bank or card on the Payments page first.'

/** A bank still waiting on the tenant's microdeposits cannot be the default yet. */
export const DEFAULT_BLOCKED_UNTIL_VERIFIED =
  'That bank account isn’t verified yet. Finish the verification Stripe sent you first, ' +
  'then you can make it your default.'

/**
 * confirm-setup for a bank whose deposits the tenant already entered and Stripe
 * is checking (its setup is processing): there is no deposit to look for and no
 * form to fill in, so the answer must not ask for either.
 */
export const BANK_CHECK_RECEIVED =
  'We received the verification you entered for this bank and are checking it now. ' +
  'There is nothing more you need to do — the bank can be used as soon as the check finishes.'

/** A bank whose entered deposits Stripe is checking: nothing left for the tenant to do. */
export const DEFAULT_BLOCKED_WHILE_CHECKING =
  'We are still checking the verification you entered for this bank. ' +
  'You can make it your default once that check finishes.'

/**
 * PATCH /api/stripe/tenant/default-payment-method. The tenant picks which saved
 * method is the default (autopay charges it). A card or a VERIFIED bank can be
 * chosen; a bank still verifying cannot — attached or not, it cannot be
 * charged yet, and autopay would charge a bank that refuses. Read from Stripe
 * under the tenant's bank lock, like a removal, so the choice and a removal
 * cannot cross. The tenants row then names the bank on file from the new
 * default when it is a bank; a card made the default leaves the bank on file
 * as it was (summaryBank), the same as after a removal.
 */
export async function setTenantDefaultPaymentMethod(
  tenantId: string,
  paymentMethodId: string,
): Promise<{ defaultPaymentMethodId: string }> {
  const client = await getClient()
  let destroy = false
  try {
    await client.query('BEGIN')
    await lockTenantBanks(client, tenantId)
    const t = (await client.query<{ stripe_customer_id: string | null }
                                  & Pick<BankSummaryRow, 'bank_last4' | 'bank_routing_last4'>>(
      `SELECT stripe_customer_id, bank_last4, bank_routing_last4 FROM tenants WHERE id = $1`, [tenantId])).rows[0]
    if (!t) throw new AppError(404, 'Tenant not found')
    if (!t.stripe_customer_id) throw new AppError(409, NO_SAVED_METHODS)
    const customerId = t.stripe_customer_id

    let facts: StripeMethodFacts
    try {
      facts = await readStripeMethodFacts(customerId, { strict: true })
    } catch {
      throw new AppError(503,
        'We could not check your saved accounts with our payment processor just now. Nothing changed — try again in a minute.')
    }
    const bank = facts.banks.find((b) => b.id === paymentMethodId) ?? null
    const card = facts.cards.find((c) => c.id === paymentMethodId) ?? null
    if (!bank && !card) {
      throw new AppError(403, 'That payment method is not saved on your account.')
    }
    if (bank && !bank.verified) {
      // A bank whose deposits Stripe is checking needs nothing more from the
      // tenant — telling them to finish a step they already took sends them
      // looking for one that is not there.
      throw new AppError(409, bank.checking ? DEFAULT_BLOCKED_WHILE_CHECKING : DEFAULT_BLOCKED_UNTIL_VERIFIED)
    }

    try {
      await getStripe().customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      })
    } catch (e) {
      logger.error({ err: e, tenantId, paymentMethodId }, '[tenant-banks] could not change the default')
      throw new AppError(502,
        'We could not change your default just now. Nothing changed — try again in a minute.')
    }

    // Stripe has the new default. The bank named on file follows a bank; a card
    // made the default keeps the bank already on file (the old default when it
    // was a verified bank, else the one the row names) — never whichever bank
    // Stripe happens to list first. A failure here does not undo the choice
    // (the next removal or resync corrects it).
    try {
      await writeBankSummary(client, tenantId, facts.banks, bank ? paymentMethodId : facts.defaultId, bankOnFile(t))
      await client.query('COMMIT')
    } catch (e) {
      logger.error({ err: e, tenantId, paymentMethodId },
        '[tenant-banks] default changed at Stripe but the bank on file was not updated')
      await client.query('ROLLBACK').catch(() => {})
      // Destroyed rather than pooled, so the bank lock ends with its session.
      destroy = true
    }
    return { defaultPaymentMethodId: paymentMethodId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release(destroy ? true : undefined)
  }
}

// ─── A bank was verified ────────────────────────────────────────────────────

export interface VerifiedBankResult {
  tenantId: string | null
  /**
   * Why nothing was recorded, or null when the bank was recorded:
   *   no_tenant       no tenant has this id / Stripe customer
   *   not_on_account  the bank is not attached to the tenant's own Stripe
   *                   customer — the tenant removed it (a replayed confirm or a
   *                   redelivered setup_intent.succeeded), or it was never theirs
   *   not_a_bank      the payment method is not a bank account (a card, or any
   *                   other kind Stripe holds)
   */
  refused: 'no_tenant' | 'not_on_account' | 'not_a_bank' | null
  /** First time this bank (routing + account last 4) was verified for this tenant. */
  firstTime: boolean
  madeDefault: boolean
}

/**
 * Stripe metadata on a bank's payment method: when GAM made it the default
 * because it was verified. It tells a redelivered verification of the SAME
 * payment method (the tenant's choice of default since then stands) from a new
 * one. A bank the tenant removed and added again is a new payment method with
 * no mark, even though the bank itself — and its NACHA first-time-sender row —
 * is the same. Written only once the default really changed, so a verification
 * whose default Stripe refused is made the default on the next delivery.
 */
export const VERIFIED_BANK_MARK = 'gam_made_default_at'

/** Is the customer's default one of the methods it holds right now? Null when unknown. */
function defaultStillOnFile(facts: StripeMethodFacts | null): boolean | null {
  if (!facts) return null
  const d = facts.defaultId
  if (!d) return false
  return facts.banks.some((b) => b.id === d && b.attached) || facts.cards.some((c) => c.id === d)
}

/** Did GAM already make THIS payment method the default once it was verified? */
function madeDefaultBefore(pm: Pick<Stripe.PaymentMethod, 'metadata'>): boolean {
  return !!pm.metadata?.[VERIFIED_BANK_MARK]
}

/**
 * A bank on the tenant's customer is verified: at confirm time (the SetupIntent
 * had already succeeded) or from setup_intent.succeeded once the microdeposits
 * are confirmed. For the webhook (Step 10) this replaces the old FALSE→TRUE
 * flip, which never fired for a tenant who already had a verified bank — so
 * the new bank was never made the default.
 *
 *   - Default, decided per payment method (Nic: a new verified bank becomes the
 *     default): 'always' when the tenant just added it; 'first_time' from the
 *     webhook makes it the default unless GAM already made THIS payment method
 *     the default (VERIFIED_BANK_MARK) and the customer still has a default — a
 *     redelivered event, where the tenant's choice since then stands. A bank
 *     removed and added again is a new payment method, so it is made the
 *     default once it verifies, whatever the bank's NACHA history.
 *   - tenants: ach_verified on; bank_last4 / routing name the bank on file as
 *     summaryBank picks it with the resulting default (this bank when it became
 *     the default, else the verified bank already on file); bank_pending_since
 *     kept only while another bank is still verifying; the reminder count
 *     starts over once no other bank is waiting. When Stripe cannot say whether
 *     another bank is waiting (its setup list failed), the flag and the
 *     reminder count are left exactly as they were — the nudge job asks Stripe
 *     again and clears them itself if nothing waits.
 *   - NACHA first-time-sender row once per bank (routing + last 4).
 *
 * Nothing is recorded unless, under the tenant's bank lock, Stripe still shows
 * a BANK ACCOUNT attached to the tenant's OWN customer. Without that, a tenant
 * could remove their only bank (DELETE /tenant/payment-methods/:id) and replay
 * the old, succeeded SetupIntent through confirm-setup — or Stripe could
 * redeliver setup_intent.succeeded — and come out ach_verified with no bank on
 * file. ach_verified is the FlexPay / FlexDeposit gate, which is why the
 * typed-in verify-ach mock was deleted. Everything here is decided and written
 * under the lock, so a removal, a confirm-setup, the nudge and a verification
 * for the same tenant cannot cross. Stripe's answers about the default, the
 * mark and the other methods are best effort: the bank IS verified.
 */
export async function recordVerifiedTenantBank(opts: {
  tenantId?: string | null
  customerId?: string | null
  paymentMethodId: string
  bank: { last4?: string | null; routing_number?: string | null } | null | undefined
  makeDefault: 'always' | 'first_time'
  note?: string
}): Promise<VerifiedBankResult> {
  const key = opts.tenantId ?? opts.customerId ?? null
  if (!key) return { tenantId: null, refused: 'no_tenant', firstTime: false, madeDefault: false }
  const last4 = opts.bank?.last4 ?? null
  const routing = opts.bank?.routing_number ?? null
  const routingLast4 = routing ? String(routing).slice(-4) : null
  const fingerprint = routing || last4 ? `${routing}_${last4}` : `pm:${opts.paymentMethodId}`

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const found = (await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE ${opts.tenantId ? 'id' : 'stripe_customer_id'} = $1 LIMIT 1`,
      [key])).rows[0]
    if (!found) {
      await client.query('ROLLBACK')
      return { tenantId: null, refused: 'no_tenant', firstTime: false, madeDefault: false }
    }
    const tenantId = found.id
    await lockTenantBanks(client, tenantId)
    // Read under the lock: the bank the row names now is the one to keep.
    const t = (await client.query<{ stripe_customer_id: string | null } & BankSummaryRow>(
      `SELECT stripe_customer_id, ach_verified, bank_last4, bank_routing_last4, bank_pending_since
         FROM tenants WHERE id = $1`, [tenantId])).rows[0]

    // The bank must be on THIS tenant's customer right now. A tenant with no
    // customer has no bank on file; an event naming another customer than the
    // tenant's is not theirs to record.
    const owner = t?.stripe_customer_id ?? null
    const refuse = async (refused: 'not_on_account' | 'not_a_bank'): Promise<VerifiedBankResult> => {
      await client.query('ROLLBACK')
      logger.warn({ tenantId, pm: opts.paymentMethodId, refused }, '[tenant-banks] verified bank not recorded')
      return { tenantId, refused, firstTime: false, madeDefault: false }
    }
    if (!owner || (opts.customerId && opts.customerId !== owner)) return await refuse('not_on_account')
    const stripe = getStripe()
    let pm: Stripe.PaymentMethod
    try {
      pm = await stripe.paymentMethods.retrieve(opts.paymentMethodId)
    } catch (e) {
      logger.error({ err: e, tenantId, pm: opts.paymentMethodId }, '[tenant-banks] could not read the verified bank at Stripe')
      throw new AppError(502,
        'We could not confirm that bank with our payment processor just now. Nothing changed — try again in a minute.')
    }
    // Only a bank account is a bank. A card is saved through confirm-card, and
    // any other kind Stripe holds is not a bank either: recording one would
    // mark the tenant bank-verified with no bank behind it.
    if (pm.type !== 'us_bank_account') return await refuse('not_a_bank')
    const pmCustomer = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id ?? null
    if (pmCustomer !== owner) return await refuse('not_on_account')

    const firstTime = !(await client.query(
      `SELECT 1 FROM ach_monitoring_log
        WHERE tenant_id = $1 AND event_type = 'first_sender' AND bank_fingerprint = $2 LIMIT 1`,
      [tenantId, fingerprint])).rowCount

    // What else the customer holds, for the default and the bank on file.
    let facts: StripeMethodFacts | null = null
    try {
      facts = await readStripeMethodFacts(owner)
    } catch (e) {
      logger.warn({ err: e, tenantId }, '[tenant-banks] could not read the other saved methods while recording a verified bank')
    }

    const keepChoice = opts.makeDefault === 'first_time'
      && madeDefaultBefore(pm)
      && defaultStillOnFile(facts) !== false
    let madeDefault = false
    if (!keepChoice) {
      try {
        await stripe.customers.update(owner, { invoice_settings: { default_payment_method: opts.paymentMethodId } })
        madeDefault = true
      } catch (e) {
        logger.error({ err: e, tenantId, pm: opts.paymentMethodId }, '[tenant-banks] could not make the verified bank the default')
      }
    }
    if (madeDefault && !madeDefaultBefore(pm)) {
      try {
        await stripe.paymentMethods.update(opts.paymentMethodId, {
          metadata: { [VERIFIED_BANK_MARK]: new Date().toISOString() },
        })
      } catch (e) {
        logger.warn({ err: e, tenantId, pm: opts.paymentMethodId },
          '[tenant-banks] could not mark the verified bank — a redelivered verification may make it the default again')
      }
    }

    // The bank named on file and the waiting flag, from what the customer
    // holds with this bank verified.
    let shown: BankOnFile
    let stillWaiting: boolean | null = null
    if (facts) {
      const verifiedSelf = {
        attached: true, verified: true, verifying: false, checking: false, setupIntentId: null, waitingSince: null,
      } as const
      const banks: StripeBankFacts[] = facts.banks.some((b) => b.id === opts.paymentMethodId)
        ? facts.banks.map((b) => (b.id === opts.paymentMethodId ? { ...b, ...verifiedSelf } : b))
        : [...facts.banks, {
            id: opts.paymentMethodId,
            bankName: pm.us_bank_account?.bank_name ?? null,
            last4: last4 ?? pm.us_bank_account?.last4 ?? null,
            routingLast4: routingLast4
              ?? (pm.us_bank_account?.routing_number ? String(pm.us_bank_account.routing_number).slice(-4) : null),
            ...verifiedSelf,
          }]
      const pick = summaryBank(banks, madeDefault ? opts.paymentMethodId : facts.defaultId, bankOnFile(t))
      shown = { last4: pick?.last4 ?? last4, routingLast4: pick?.routingLast4 ?? routingLast4 }
      // Only Stripe's list of setups says whether another bank still waits. When
      // it could not be read, the banks above carry none of them, and "nothing
      // waits" would clear the flag and the reminders of a bank still waiting on
      // its deposits — so the answer stays unknown and nothing about it changes.
      stillWaiting = facts.pendingLookupFailed ? null : banks.some((b) => b.verifying)
    } else {
      // What else is on file is unknown: name this bank when it became the
      // default or no verified bank is named yet; otherwise keep the row's.
      shown = madeDefault || !t.ach_verified || !t.bank_last4 ? { last4, routingLast4 } : bankOnFile(t)
    }

    await client.query(
      // S641: verified means we stop chasing them about finishing it — unless
      // another bank is still waiting, which keeps its own reminder count.
      // $4 NULL (Stripe could not say whether another bank waits) changes none
      // of the three: only a known "nothing waits" (FALSE) ends the chase.
      `UPDATE tenants
          SET ach_verified            = TRUE,
              bank_last4              = $2,
              bank_routing_last4      = $3,
              -- 10/3: when the setup list cannot be read, keep the tenant on the
              -- reminder list (refreshBankPendingFlag settles it next run) —
              -- leaving a NULL flag dropped them off it for good.
              bank_pending_since      = CASE WHEN $4::boolean IS NULL THEN COALESCE(bank_pending_since, NOW())
                                             WHEN $4::boolean THEN COALESCE(bank_pending_since, NOW())
                                             ELSE NULL END,
              bank_verify_nudge_count = CASE WHEN $4::boolean IS FALSE THEN 0 ELSE bank_verify_nudge_count END,
              bank_verify_nudge_at    = CASE WHEN $4::boolean IS FALSE THEN NULL ELSE bank_verify_nudge_at END
        WHERE id = $1`,
      [tenantId, shown.last4, shown.routingLast4, stillWaiting])
    if (firstTime) {
      await client.query(
        `INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
         VALUES ('first_sender', $1, $2, $3)`,
        [tenantId, fingerprint, opts.note ?? 'Bank verified — first-time sender tracking initiated'])
    }
    await client.query('COMMIT')
    return { tenantId, refused: null, firstTime, madeDefault }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ─── A bank is waiting on its microdeposits ─────────────────────────────────

/**
 * What a bank SetupIntent says about the bank behind it:
 *   verified    succeeded
 *   waiting     Stripe is waiting on the tenant's microdeposits
 *               (requires_action + verify_with_microdeposits), or checking the
 *               ones they entered (processing)
 *   removed     canceled — DELETE /tenant/payment-methods/:id cancels the setup
 *               of a bank still verifying
 *   not_set_up  anything else: requires_payment_method (the bank failed or was
 *               never entered), requires_confirmation, or another next step
 */
export type BankSetupState = 'verified' | 'waiting' | 'removed' | 'not_set_up'

export function bankSetupState(si: { status: string; next_action?: unknown }): BankSetupState {
  if (si.status === 'succeeded') return 'verified'
  if (si.status === 'processing') return 'waiting'
  if (si.status === 'requires_action'
      && (si.next_action as { type?: string } | null | undefined)?.type === 'verify_with_microdeposits') return 'waiting'
  if (si.status === 'canceled') return 'removed'
  return 'not_set_up'
}

export interface WaitingBankResult {
  /** The SetupIntent's state, read again under the tenant's bank lock. */
  state: BankSetupState
  /** That fresh SetupIntent (its next_action carries the deposit details). */
  setupIntent: Stripe.SetupIntent | null
}

/**
 * confirm-setup for a bank still waiting on its microdeposits: records that a
 * bank is waiting (bank_pending_since = NOW(), reminders reset; bank_last4
 * names it only while there is no verified bank). Nothing is recorded unless,
 * under the tenant's bank lock, Stripe still shows this tenant's own setup
 * waiting. A removal takes the same lock and cancels the setup before it
 * commits, so a replayed confirm-setup for a bank the tenant removed reads
 * 'removed' here and writes nothing (it used to stamp the removed bank's last 4
 * on file and restart the reminders), and the two writes cannot cross (a
 * removal's write could drop the waiting flag this one had just set).
 * Throws 502 when Stripe cannot be asked.
 */
export async function recordWaitingTenantBank(opts: {
  tenantId: string
  setupIntentId: string
  paymentMethodId: string
  bank: { last4?: string | null; routing_number?: string | null } | null | undefined
}): Promise<WaitingBankResult> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await lockTenantBanks(client, opts.tenantId)
    const t = (await client.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [opts.tenantId])).rows[0]
    let si: Stripe.SetupIntent
    try {
      si = await getStripe().setupIntents.retrieve(opts.setupIntentId)
    } catch (e) {
      logger.error({ err: e, tenantId: opts.tenantId, setupIntent: opts.setupIntentId },
        '[tenant-banks] could not read the bank setup at Stripe')
      throw new AppError(502,
        'We could not check that bank with our payment processor just now. Nothing changed — try again in a minute.')
    }
    const siCustomer = typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null
    const siPm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id ?? null
    const state: BankSetupState = !t?.stripe_customer_id || siCustomer !== t.stripe_customer_id
        || siPm !== opts.paymentMethodId
      ? 'not_set_up'
      : bankSetupState(si)
    if (state !== 'waiting') {
      await client.query('ROLLBACK')
      return { state, setupIntent: si }
    }
    const routing = opts.bank?.routing_number ?? null
    await client.query(
      // S641: a fresh attempt resets the nudge counter, so somebody who
      // abandons one setup and starts another is chased about the NEW one
      // rather than being silently out of reminders.
      `UPDATE tenants
          SET bank_pending_since      = NOW(),
              bank_last4              = CASE WHEN ach_verified THEN bank_last4 ELSE $2 END,
              bank_routing_last4      = CASE WHEN ach_verified THEN bank_routing_last4 ELSE $3 END,
              bank_verify_nudge_count = 0,
              bank_verify_nudge_at    = NULL
        WHERE id = $1`,
      [opts.tenantId, opts.bank?.last4 || null, routing ? String(routing).slice(-4) : null])
    await client.query('COMMIT')
    return { state, setupIntent: si }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ─── The nudge: is a bank still verifying? ──────────────────────────────────

/**
 * jobs/bankVerificationNudge.ts: asks Stripe which banks are still verifying
 * (the same list the portal reads, listWaitingBankSetups — up to 20 setups,
 * the payment method expanded, banks being checked included) and brings
 * tenants.bank_pending_since in line: set from the oldest waiting setup when
 * it is missing, cleared — with the reminder count — when nothing waits. Read and written under the
 * tenant's bank lock, so a confirm-setup or a verification for the same tenant
 * lands before or after it, never between Stripe's answer and the write (the
 * job used to clear the flag a confirm-setup had just set). Returns the banks
 * still verifying, newest first; throws when Stripe cannot be asked (nothing
 * is written then).
 */
export async function refreshBankPendingFlag(tenantId: string): Promise<WaitingBankSetup[]> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await lockTenantBanks(client, tenantId)
    const t = (await client.query<{ stripe_customer_id: string | null; bank_pending_since: Date | null }>(
      `SELECT stripe_customer_id, bank_pending_since FROM tenants WHERE id = $1`, [tenantId])).rows[0]
    if (!t?.stripe_customer_id) {
      await client.query('ROLLBACK')
      return []
    }
    const waiting = await listWaitingBankSetups(getStripe(), t.stripe_customer_id)
    if (waiting.length && !t.bank_pending_since) {
      const oldest = Math.min(...waiting.map((w) => w.createdAt?.getTime() ?? Date.now()))
      await client.query(`UPDATE tenants SET bank_pending_since = $2 WHERE id = $1`, [tenantId, new Date(oldest)])
    } else if (!waiting.length && t.bank_pending_since) {
      // Nothing waits any more, so the chase is over and its count starts over
      // with the next bank (a verification recorded while Stripe could not say
      // whether another bank waited leaves both for this run to settle).
      await client.query(
        `UPDATE tenants SET bank_pending_since = NULL, bank_verify_nudge_count = 0, bank_verify_nudge_at = NULL
          WHERE id = $1`, [tenantId])
    }
    await client.query('COMMIT')
    return waiting
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ─── P5 backfill planner ────────────────────────────────────────────────────

export interface BankBackfillRow {
  id: string
  ach_verified: boolean
  bank_pending_since: Date | null
  bank_last4: string | null
  /** tenants.ach_suspended_at: the NACHA block, carried in its own column. */
  ach_suspended_at?: Date | null
  /**
   * The latest NACHA zero-tolerance block in ach_monitoring_log (or its
   * archive). Until the deploy, handle-return wrote that block as
   * ach_verified = FALSE and nothing else.
   */
  zero_tolerance_blocked_at?: Date | null
}

export interface BankBackfillPlan {
  /** New bank_pending_since: the oldest waiting setup's creation, or null. Undefined = unchanged. */
  pendingSince?: Date | null
  /** Turn ach_verified on (Stripe has a verified bank the row does not know about). */
  markVerified?: { last4: string | null; routingLast4: string | null }
  /** Stripe shows no verified bank but the row says verified: reported, never changed here. */
  warnVerifiedWithoutBank?: boolean
  /**
   * 10/3: an ACH return blocked bank payments (NACHA zero tolerance) before the
   * deploy, when the block lived only in ach_verified = FALSE. After the deploy
   * every charge path reads ach_suspended_at, so the block is carried into that
   * column (COALESCE — an existing suspension wins). Lifting a block is for a
   * person to decide, never for a script.
   */
  carrySuspension?: Date
}

/**
 * What scripts/oct3_bank_pending_since_backfill.ts changes for one tenant, from
 * Stripe's facts. bank_pending_since is set only for a bank Stripe is really
 * waiting on (the plan's "everyone unverified, the nudge clears the rest" made
 * exact), and a row that says "no verified bank" while Stripe holds one is
 * corrected to the one meaning ach_verified now has. An ACH return block that
 * lives only in ach_verified = FALSE (the pre-deploy handle-return) is first
 * carried into ach_suspended_at, so correcting ach_verified never lifts it.
 */
export function planBankBackfill(row: BankBackfillRow, facts: StripeMethodFacts): BankBackfillPlan {
  const plan: BankBackfillPlan = {}
  const waitingTimes = facts.banks
    .filter((b) => b.verifying)
    .map((b) => b.waitingSince?.getTime() ?? Date.now())
  const pendingSince = waitingTimes.length ? new Date(Math.min(...waitingTimes)) : null
  if ((row.bank_pending_since === null) !== (pendingSince === null)) {
    plan.pendingSince = pendingSince
  }
  const verified = facts.banks.filter((b) => b.verified)
  if (row.zero_tolerance_blocked_at && !row.ach_suspended_at) {
    plan.carrySuspension = row.zero_tolerance_blocked_at
  }
  if (!row.ach_verified && verified.length) {
    // Safe once the block (if any) is in its own column: ach_verified now only
    // says whether a verified bank is on file.
    const shown = summaryBank(facts.banks, facts.defaultId, { last4: row.bank_last4, routingLast4: null })
    plan.markVerified = { last4: shown?.last4 ?? null, routingLast4: shown?.routingLast4 ?? null }
  }
  if (row.ach_verified && !verified.length) plan.warnVerifiedWithoutBank = true
  return plan
}
