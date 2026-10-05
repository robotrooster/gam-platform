// Bank feed (S570, Nic) — Stripe Financial Connections transactions feed.
//
// GAM sees money that flows THROUGH it (rent via `payments`, payouts via
// `disbursements`). It cannot see a landlord spending from their OWN operating
// bank. This links that bank read-only (FC `transactions` scope), syncs the
// transactions, AUTO-MATCHES inbound deposits to the GAM disbursements that
// produced them (hidden), and surfaces the rest for a 2-click categorize that
// writes a `landlord_expenses` row → straight into the shared landlord P&L.
//
// Design locks (Nic, S570):
//   * Landlord ALWAYS confirms and ALWAYS picks scope (a unit, or the property
//     split/common across units). Auto-suggest only PRE-FILLS from remembered
//     per-landlord merchant choices (`landlord_merchant_rules`).
//   * OUTFLOWS (amount < 0) categorize into `landlord_expenses`; INFLOWS
//     (amount > 0) that auto-matching did NOT tie to a GAM disbursement
//     categorize into `landlord_other_income` (S605). Matched inflows stay
//     hidden — that money already reaches the P&L via `payments`, and filing it
//     again would double-count the landlord's revenue.
//   * Provider-agnostic: Stripe FC today; a CSV import path can add rows to the
//     same `bank_transactions` table later.
//
// Stripe is used only at the lib/stripe boundary so tests can mock it; every
// pure-DB function below (sync-from-rows, auto-match, categorize, suggest) runs
// without touching Stripe.
import { db, query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { createLandlordExpense } from './landlordExpenses'
import { payoutCompositions } from './payoutComposition'
import type { PoolClient } from 'pg'
import type { MerchantRuleScope, BankTxnBankStatus } from '@gam/shared'
import { OTHER_INCOME_CATEGORIES, EXPENSE_CATEGORIES, BANK_TXN_HIDDEN_REASONS, isRentChannelPayer } from '@gam/shared'
import { payableRowSql, bankPayableRowSql } from './moneyPredicates'
import { BANK_BOILERPLATE_WORDS, memoSaysTransfer } from './bankDepositMatch'

const round2 = (n: number) => Math.round(n * 100) / 100
const cents = (n: number | string) => Math.round(Number(n) * 100)

// Auto-match tolerance: a settled disbursement counts as the source of an inbound
// bank deposit if the amounts match to the cent and the posted date is within this
// many days of the disbursement settling (ACH lands a few business days out).
const MATCH_DATE_WINDOW_DAYS = 6

/**
 * Normalize a raw bank memo into a stable merchant (payer) key. Uppercase, drop
 * every word with a digit in it, strip boilerplate and punctuation, keep the
 * leading words. "HOME DEPOT #1234 PHOENIX AZ 07/12" → "HOME DEPOT PHOENIX AZ".
 *
 * S655 (Step 12): a word with a digit in it is a reference, a store number or a
 * date, and it changes on every deposit — "Square Inc SQ261001 261001
 * T3H80F2ZQ67M", "ST-B9S6S4F0D0I0 DOORLOOP CORPORATE ACH". Kept, it made every
 * Square payout a different payer, so nothing learned from one could apply to
 * the next. It is dropped WHOLE, before punctuation splits it ("ST-B9S6…" must
 * not leave a stray "ST"): every Square payout is now "SQUARE INC", every
 * DoorLoop one "DOORLOOP CORPORATE". Existing rows are re-keyed once by
 * scripts/oct3_renormalize_merchants.ts.
 */
export function normalizeMerchant(description: string | null | undefined): string {
  if (!description) return ''
  let s = String(description).toUpperCase()
  s = s.split(/\s+/).filter(w => w && !/\d/.test(w)).join(' ')
  s = s.replace(/\b(DEBIT|CREDIT|CARD|PURCHASE|POS|ACH|PMT|PAYMENT|WWW\.?|HTTP\S*)\b/g, ' ')
  s = s.replace(/[^A-Z&' ]+/g, ' ')          // punctuation
  s = s.replace(/\s+/g, ' ').trim()
  // Keep it to the leading, most-recognizable token(s).
  const words = s.split(' ').filter(Boolean).slice(0, 4)
  return words.join(' ')
}

/**
 * Does this normalized memo name a payer (anything beyond the bank's
 * boilerplate)? A memo made only of boilerplate ("MOBILE DEPOSIT", "ATM CASH
 * DEPOSIT", "BRANCH DEP") names no payer: a tenant's rent check reads exactly
 * like a laundry check, so such a memo is never a payer GAM files income from
 * by itself. The word list is bankDepositMatch.BANK_BOILERPLATE_WORDS, shared
 * with the memo name reader.
 */
export function namesAPayer(normalized: string | null | undefined): boolean {
  const words = String(normalized ?? '').split(' ').filter(Boolean)
  return words.some(w => !BANK_BOILERPLATE_WORDS.has(w))
}

// ── Stripe FC account-holder customer (one per landlord, reused) ────────────
export async function getOrCreateFcCustomer(landlordId: string): Promise<string> {
  const row = await queryOne<{ stripe_fc_customer_id: string | null; email: string | null; business_name: string | null }>(
    `SELECT l.stripe_fc_customer_id, u.email, l.business_name
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])
  if (!row) throw new AppError(404, 'Landlord not found')
  if (row.stripe_fc_customer_id) return row.stripe_fc_customer_id

  const stripe = getStripe()
  const customer = await stripe.customers.create({
    email: row.email ?? undefined,
    name: row.business_name ?? undefined,
    metadata: { landlordId, purpose: 'bank_feed_fc' },
  })
  await query('UPDATE landlords SET stripe_fc_customer_id = $1 WHERE id = $2', [customer.id, landlordId])
  return customer.id
}

/** Create an FC session the frontend uses to collect the landlord's bank. */
export async function createLinkSession(landlordId: string): Promise<{ clientSecret: string; sessionId: string }> {
  const customer = await getOrCreateFcCustomer(landlordId)
  const stripe = getStripe()
  // S605 (Nic hit this): the `transactions` permission requires the Financial
  // Connections TRANSACTIONS product to be activated on the Stripe account —
  // a separate registration, not something code can switch on. Without it
  // Stripe 400s and the landlord saw a raw "request failed with status code
  // 400". Translate it into something that says what to actually do.
  let session
  try {
    session = await stripe.financialConnections.sessions.create({
      account_holder: { type: 'customer', customer },
      // S605: `balances` was left off the original FC application because
      // nothing read it. Nic then asked "how do we see what the bank account
      // balance is?" on a page already showing that bank's activity — a fair
      // ask. Stripe had approved it alongside `transactions`, so this needed no
      // new application. Links made BEFORE this change hold transactions-only
      // consent and must be re-linked once to grant it; nothing breaks in the
      // meantime, the balance just reads as unknown.
      // S651: `payment_method` joins the list so ONE bank link can serve both
      // jobs — reading the feed, and being the account GAM pulls its fees from
      // when a property is all-cash and there is no payout to net against.
      // Asking twice for the same bank is the kind of friction that makes a
      // landlord skip the feed entirely.
      //
      // Unlike `transactions`, this permission needs no Stripe approval (see
      // the catch below), so adding it cannot break linking.
      //
      // IT IS NOT AUTHORIZATION TO DEBIT. Stripe's modal grants the technical
      // capability; GAM still refuses to pull a cent until the landlord
      // separately authorizes it in the portal (landlords.gam_debit_authorized_at,
      // services/landlordGamDebit.ts). Nic: "never ACH-debit a landlord by
      // default." Links made before this change carry no payment_method consent
      // and must be re-linked once before a debit is even possible — which is
      // the safe direction for that to fail in.
      permissions: ['transactions', 'balances', 'payment_method'],
      prefetch: ['transactions', 'balances'],
    })
  } catch (err: any) {
    if (/activating this product|financial-connections\/application/i.test(err?.message ?? '')) {
      // Wording matters: a landlord reading this must not think their bank or
      // their account is broken, and must not be sent chasing a fix they can't
      // perform. Stripe gates READING transactions (and balances) behind a
      // one-time approval; `payment_method` — collecting a bank for payments —
      // works without it, which is why tenant ACH is unaffected.
      throw new AppError(503,
        'Bank feed isn’t available yet. Reading bank transactions needs a one-time approval from ' +
        'Stripe that’s still pending — it isn’t anything to do with your bank or your account, and ' +
        'it doesn’t affect rent payments or payouts. We’ll turn this on as soon as it clears.')
    }
    throw err
  }
  if (!session.client_secret) throw new AppError(502, 'Stripe did not return a session client secret')
  return { clientSecret: session.client_secret, sessionId: session.id }
}

/**
 * After the frontend finishes the FC modal, pull the linked accounts off the
 * session, subscribe each to the transactions feature, and upsert a connection
 * row per account. Then kick an initial sync. Idempotent on the FC account id.
 */
export async function finalizeConnection(landlordId: string, sessionId: string): Promise<any[]> {
  const stripe = getStripe()
  const session = await stripe.financialConnections.sessions.retrieve(sessionId)
  const accounts = (session.accounts?.data ?? []) as any[]
  if (!accounts.length) throw new AppError(400, 'No bank accounts were linked')

  const out: any[] = []
  for (const acct of accounts) {
    // Best-effort subscribe so Stripe starts refreshing transactions for us.
    try {
      await stripe.financialConnections.accounts.subscribe(acct.id, { features: ['transactions'] })
    } catch { /* subscription is best-effort; sync still works on demand */ }
    // S605: subscribed separately from transactions on purpose — a link that
    // predates balances consent rejects this one, and bundling them would take
    // the transaction subscription down with it.
    try {
      await stripe.financialConnections.accounts.subscribe(acct.id, { features: ['balance'] as any })
    } catch { /* older links have no balances consent; balance simply stays unknown */ }

    const inst = acct.institution_name ?? acct.display_name ?? 'Bank'
    const conn = await queryOne<any>(
      `INSERT INTO bank_connections
         (landlord_id, provider, stripe_fc_account_id, stripe_fc_session_id,
          institution_name, account_last4, account_type, display_name)
       VALUES ($1,'stripe_fc',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (stripe_fc_account_id) WHERE stripe_fc_account_id IS NOT NULL
       DO UPDATE SET status='active', stripe_fc_session_id=EXCLUDED.stripe_fc_session_id,
                     institution_name=EXCLUDED.institution_name, updated_at=now()
       RETURNING *`,
      [landlordId, acct.id, sessionId, inst, acct.last4 ?? null,
       acct.subcategory ?? acct.category ?? null, `${inst}${acct.last4 ? ' ••' + acct.last4 : ''}`])
    out.push(conn)
    // S652 (Nic, relinking PNC): "now it's showing my bank account twice."
    // Stripe issues a fresh account id per link, so a relink of the SAME bank
    // (same institution, same last four) lands as a second row. The new link is
    // the one with today's consent; the older one is retired so the page, the
    // debit and the sync all read the live link. Retired, not deleted — its
    // imported history stays attached to it.
    if (acct.last4) {
      await query(
        `UPDATE bank_connections SET status = 'disconnected', updated_at = now()
          WHERE landlord_id = $1 AND id <> $2 AND status = 'active'
            AND institution_name = $3 AND account_last4 = $4`,
        [landlordId, conn.id, inst, acct.last4])
    }
    try { await syncConnection(conn.id) } catch { /* initial sync best-effort */ }
    // S652 (Nic): "when they link a bank, they're authorizing debits and payouts."
    // Mint the debit method NOW, from this link, so the day GAM is owed there is
    // nothing left to ask. A link that cannot be debited from says so on the page.
    try {
      const pm = await createDebitPaymentMethod(landlordId, conn.id)
      if (pm) {
        await query(
          `UPDATE landlords SET gam_debit_payment_method_id = $2, gam_debit_bank_last4 = $3, gam_debit_bank_name = $4,
                  gam_debit_authorized_at = COALESCE(gam_debit_authorized_at, NOW()), gam_debit_revoked_at = NULL, updated_at = NOW()
            WHERE id = $1`, [landlordId, pm.paymentMethodId, pm.last4, pm.bankName])
      }
    } catch (e) { logger.warn({ err: e, landlordId, connectionId: conn.id }, '[bank-feed] link made, debit method not minted') }
  }
  return out
}

// ── Sync ────────────────────────────────────────────────────────────────────

/** One transaction as the bank reports it. `status` defaults to posted (CSV). */
export interface FeedRow {
  externalId: string
  postedDate: string
  amount: number
  currency?: string
  description?: string | null
  status?: BankTxnBankStatus
}

/**
 * S655: how far apart the two copies of one transaction can be dated across two
 * links to the same account. The bank's pending date and its posted date differ
 * by a day or so — Oak Park's DoorLoop deposit was 9/9 on the old link (pending)
 * and 9/10 on the new one (posted).
 */
export const RELINK_PAIR_WINDOW_DAYS = 3

const dayNumber = (iso: string) =>
  Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000)

/**
 * SQL: has the landlord (or GAM on their behalf) already DONE something with
 * this row? A filed row is never hidden in favor of a copy — the copy is.
 * Rows in review and rows hidden only for predating the books are untouched.
 */
const FILED_SQL = (t: string) => `(
  ${t}.status IN ('categorized', 'matched')
  OR (${t}.status = 'ignored' AND ${t}.ignored_reason IS DISTINCT FROM 'before_books')
  OR EXISTS (SELECT 1 FROM bank_deposit_allocations a WHERE a.bank_transaction_id = ${t}.id)
  OR EXISTS (SELECT 1 FROM tenant_declared_deposits dd WHERE dd.bank_transaction_id = ${t}.id))`

/**
 * SQL: nobody has acted on this row — in review, or hidden only for predating
 * the books, and nothing booked from it. The sync re-checks this on the row it
 * is about to change, so it can never overwrite a row someone filed.
 */
const UNTOUCHED_SQL = (t: string) => `(NOT ${FILED_SQL(t)}
  AND (${t}.status = 'needs_review' OR (${t}.status = 'ignored' AND ${t}.ignored_reason = 'before_books'))
  AND ${t}.expense_id IS NULL AND ${t}.landlord_other_income_id IS NULL)`

interface StoredRow {
  id: string; external_id: string; posted_date: string; amount: string; description: string | null
  status: string; ignored_reason: string | null; bank_status: string | null; filed: boolean
  duplicate_of_id: string | null
}
interface Sibling { id: string; posted_date: string; amount: string; description: string | null; filed: boolean; day: number }

/**
 * Upsert a batch of normalized transactions for a connection and auto-match.
 * Shared by the Stripe pull and any future CSV import — pure DB, no Stripe.
 * Returns how many genuinely NEW transactions arrived (a copy that replaced the
 * same transaction from an earlier link is not new to the landlord).
 *
 * S655 (Nic, Oak Park PNC relink) — three rules, each from a real failure:
 *
 *  1. ONLY POSTED TRANSACTIONS BECOME ROWS, AND A STORED ROW FOLLOWS ITS BANK.
 *     Stripe lists pending, posted and void transactions alike, and the feed
 *     stored whatever it saw and never looked again: the old PNC link froze the
 *     bank's short pending wording ('PIN POS MOUNTAINAI CARD#2971') and its
 *     pending dates, and a pending charge later voided would have stayed a real
 *     row forever. Now a pending transaction waits until it posts (a day or two
 *     later than before), a stored row nobody has filed takes the bank's posted
 *     wording/date/amount when they change, and a voided one is hidden as
 *     `bank_void` — or, if it was already filed, kept and flagged.
 *
 *  2. A RELINK PAIRS COPIES ONE FOR ONE. Stripe issues a fresh account id per
 *     link, so the same transaction arrives again under a new external id. The
 *     S605 guard matched only identical text on the identical day (91 of Oak
 *     Park's 104 copies), and as a plain set it would drop BOTH of two identical
 *     same-day charges if the old link had one. Each new row now pairs with at
 *     most one row on the account's other links: same amount to the cent,
 *     within RELINK_PAIR_WINDOW_DAYS, identical text first, then nearest date.
 *     Rows that are already copies are never paired against.
 *
 *  3. KEEP THE COPY THAT MATTERS, HIDE THE OTHER, LOSE NOTHING. If the old copy
 *     is untouched, the new link's copy is kept (it is the one the bank keeps
 *     updating) and the old one becomes `duplicate` pointing at it. If the old
 *     copy was already filed, it stays and the new copy lands as the duplicate.
 *     Nothing is deleted; every hidden copy points at the one kept, and a void
 *     the bank reports on a copy is carried to the one kept.
 *
 * Rows before the books start date land ignored as `before_books` on every
 * path, so pre-GAM history never enters review (S605/S654).
 *
 * Every stored row the sync may change — this link's own rows and the copies
 * on the account's other links — is locked before it is read, so a landlord
 * filing a row while the sync runs either finishes first (and the sync sees it
 * filed) or waits for the sync (and is refused if the row became a copy). The
 * changes themselves re-check that the row is still untouched.
 */
export async function upsertTransactions(
  connectionId: string,
  landlordId: string,
  rows: FeedRow[],
): Promise<number> {
  let inserted = 0, replacedOldCopy = 0, keptOldCopy = 0, followed = 0, notPostedYet = 0
  // S655 (Step 12): deposits already matched to a tenant's bills that the bank
  // has now voided — both sides are told once this sync commits.
  const voidedMatched: string[] = []
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const conn = (await client.query<{ institution_name: string | null; account_last4: string | null }>(
      `SELECT institution_name, account_last4 FROM bank_connections WHERE id = $1 AND landlord_id = $2`,
      [connectionId, landlordId])).rows[0]
    if (!conn) throw new AppError(404, 'Connection not found')
    // One import at a time per physical account: the hourly sync and a Sync
    // press on a fresh relink must not both pair the same old copy.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`bank_feed_account:${landlordId}:${conn.institution_name ?? ''}:${conn.account_last4 ?? connectionId}`])

    // S654: ::text — node-pg hands a DATE back as a JS Date, and a string < Date
    // comparison is always false, so the cutoff never applied.
    const cutoff = (await client.query<{ books_start_date: string | null }>(
      `SELECT books_start_date::text AS books_start_date FROM landlords WHERE id = $1`, [landlordId])).rows[0]?.books_start_date ?? null
    const reviewState = (postedDate: string) => cutoff != null && postedDate < cutoff
      ? { status: 'ignored', reason: 'before_books' as string | null }
      : { status: 'needs_review', reason: null as string | null }

    // Lock every row this sync may change before reading any of them: this
    // link's own rows, the rows on the account's other links within reach
    // of a pairing (a superset of the copies step 2 reads), and the originals
    // this link's own copies point at (a void follows a copy to its original).
    // One statement, in id order, so it can't deadlock with another ordered
    // locker (the books start date). A filing in progress finishes first and
    // is read as filed; a filing that starts now waits for this sync and then
    // sees its result.
    const postedDates = rows.filter(r => (r.status ?? 'posted') === 'posted').map(r => r.postedDate).sort()
    await client.query(
      `SELECT t.id FROM bank_transactions t
        WHERE (t.bank_connection_id = $1 AND t.external_id = ANY($2::text[]))
           OR t.id IN (SELECT d.duplicate_of_id FROM bank_transactions d
                        WHERE d.bank_connection_id = $1 AND d.external_id = ANY($2::text[])
                          AND d.duplicate_of_id IS NOT NULL)
           OR ($4::text IS NOT NULL AND $5::date IS NOT NULL
               AND t.landlord_id = $3
               AND t.bank_connection_id IN (
                     SELECT c.id FROM bank_connections c
                      WHERE c.landlord_id = $3 AND c.id <> $1
                        AND c.account_last4 = $4 AND c.institution_name IS NOT DISTINCT FROM $7)
               AND t.posted_date BETWEEN ($5::date - $8::int) AND ($6::date + $8::int))
        ORDER BY t.id FOR UPDATE OF t`,
      [connectionId, rows.map(r => r.externalId), landlordId, conn.account_last4,
       postedDates[0] ?? null, postedDates[postedDates.length - 1] ?? null, conn.institution_name,
       RELINK_PAIR_WINDOW_DAYS])

    // 1. What this link already holds: follow the bank.
    const stored = new Map<string, StoredRow>((await client.query<StoredRow>(
      `SELECT t.id, t.external_id, t.posted_date::text AS posted_date, t.amount::text AS amount,
              t.description, t.status, t.ignored_reason, t.bank_status, t.duplicate_of_id,
              ${FILED_SQL('t')} AS filed
         FROM bank_transactions t
        WHERE t.bank_connection_id = $1 AND t.external_id = ANY($2::text[])`,
      [connectionId, rows.map(r => r.externalId)])).rows.map(r => [r.external_id, r]))
    const fresh: FeedRow[] = []
    for (const r of rows) {
      const s = stored.get(r.externalId)
      if (s) { if (await followTheBank(client, s, r, reviewState, voidedMatched)) followed++; continue }
      if ((r.status ?? 'posted') !== 'posted') { notPostedYet++; continue }
      fresh.push(r)
    }

    // 2. Pair new rows with their copies on the account's other links.
    const partners = await pairAcrossLinks(client, connectionId, landlordId, conn, fresh)

    // 3. Store, keeping the copy that matters.
    for (const r of fresh) {
      const partner = partners.get(r)
      let state = reviewState(r.postedDate)
      let duplicateOf: string | null = null
      if (partner?.filed) { state = { status: 'ignored', reason: 'duplicate' }; duplicateOf = partner.id }
      const res = await client.query<{ id: string }>(
        `INSERT INTO bank_transactions
           (bank_connection_id, landlord_id, external_id, posted_date, amount, currency,
            description, normalized_merchant, status, ignored_reason, duplicate_of_id, bank_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'posted')
         ON CONFLICT (bank_connection_id, external_id) DO NOTHING
         RETURNING id`,
        [connectionId, landlordId, r.externalId, r.postedDate, round2(r.amount).toFixed(2),
         r.currency ?? 'usd', r.description ?? null, normalizeMerchant(r.description),
         state.status, state.reason, duplicateOf])
      const id = res.rows[0]?.id
      if (!id) continue
      if (!partner) { inserted++; continue }
      if (partner.filed) { keptOldCopy++; continue }
      // Keep this copy: hide the old one as a copy of this — only if it is
      // still untouched — then point anything that pointed at it here.
      const hid = await client.query(
        `UPDATE bank_transactions t
            SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of_id = $2, updated_at = now()
          WHERE t.id = $1 AND ${UNTOUCHED_SQL('t')}`, [partner.id, id])
      if (!hid.rowCount) {
        // Filed after it was read: the old copy stays, this one is its copy.
        await client.query(
          `UPDATE bank_transactions
              SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of_id = $2, updated_at = now()
            WHERE id = $1`, [id, partner.id])
        keptOldCopy++
        continue
      }
      await client.query(
        `UPDATE bank_transactions SET duplicate_of_id = $2, updated_at = now() WHERE duplicate_of_id = $1`,
        [partner.id, id])
      // S655 (Step 12): an old copy whose match a person undid carries that
      // undo with it, so the kept copy is never matched or filed by itself
      // either — the landlord already said no to that.
      await client.query(
        `UPDATE bank_transactions n SET auto_settle_undo = o.auto_settle_undo
           FROM bank_transactions o
          WHERE n.id = $1 AND o.id = $2 AND o.auto_settle_undo IS NOT NULL AND n.auto_settle_undo IS NULL`,
        [id, partner.id])
      replacedOldCopy++
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // S655 (Step 12): every automatic step, in the money plan's order — GAM's
  // payouts, deposit slips, the office's cash worked out, tenant reports, a
  // tenant's whole bill to the cent, then income filed by itself.
  await reconcileDeposits(landlordId)
  if (voidedMatched.length) {
    // A deposit that paid a TENANT's bills, and (Step 12 review) one matched
    // to a deposit slip or to the office's cash GAM worked out: each is told,
    // in its own words. A voided payout match is flagged on the feed itself.
    const voided = await query<{ id: string; kind: 'tenant' | 'slip' | null }>(
      `SELECT id,
              CASE WHEN matched_payment_id IS NOT NULL OR (auto_settle_undo ? 'receiptId') THEN 'tenant'
                   WHEN auto_settle_undo->>'kind' = 'deposit_slip' THEN 'slip' END AS kind
         FROM bank_transactions WHERE id = ANY($1::uuid[]) AND matched_disbursement_id IS NULL`, [voidedMatched])
    const { alertMatchedDepositVoided } = await import('./bankDepositConfirm')
    const { alertSlipDepositVoided } = await import('./depositSlips')
    for (const r of voided) {
      if (r.kind === 'tenant') await alertMatchedDepositVoided(r.id)
      else if (r.kind === 'slip') await alertSlipDepositVoided(r.id)
    }
  }
  if (replacedOldCopy || keptOldCopy || followed || notPostedYet) {
    logger.info({ connectionId, inserted, replacedOldCopy, keptOldCopy, followed, notPostedYet },
      '[bank-feed] sync: copies from an earlier link paired, bank changes followed, pending left for later')
  }
  return inserted
}

/**
 * A row this link already holds, reported again: take the bank's latest word.
 * Returns whether anything changed.
 */
async function followTheBank(
  client: PoolClient, s: StoredRow, r: FeedRow,
  reviewState: (postedDate: string) => { status: string; reason: string | null },
  voidedMatched: string[] = [],
): Promise<boolean> {
  const incoming = r.status ?? 'posted'
  if (s.bank_status === 'void') return false            // a void never comes back
  // In review, or hidden only for predating the books — nobody has acted on it.
  const untouched = !s.filed
    && (s.status === 'needs_review' || (s.status === 'ignored' && s.ignored_reason === 'before_books'))

  // Each change to an untouched row re-checks, on the row itself, that it is
  // still untouched; if not, it falls through to only recording the bank's state.
  if (incoming === 'void') {
    const hidden = untouched && (await client.query(
      `UPDATE bank_transactions t
          SET status = 'ignored', ignored_reason = 'bank_void', bank_status = 'void', updated_at = now()
        WHERE t.id = $1 AND ${UNTOUCHED_SQL('t')}`, [s.id])).rowCount
    if (!hidden) {
      // Filed, a copy, or the landlord's own call: keep it, flag it. The page
      // tells the landlord the bank voided something they already filed.
      await client.query(`UPDATE bank_transactions SET bank_status = 'void', updated_at = now() WHERE id = $1`, [s.id])
      if (s.status === 'categorized' || s.status === 'matched') {
        logger.warn({ transactionId: s.id, status: s.status }, '[bank-feed] the bank voided a transaction that was already filed')
      }
      if (s.status === 'matched') voidedMatched.push(s.id)
    }
    // S655 review: a copy voided means the transaction it copies was voided.
    // After a relink whose old copy was already filed, that filed original
    // stays on the retired link, which is never synced again — only its hidden
    // copy on the live link still hears from the bank. Carry the void over, or
    // the landlord is never told the money they filed never moved.
    if (s.ignored_reason === 'duplicate' && s.duplicate_of_id) await voidTheOriginal(client, s.duplicate_of_id, voidedMatched)
    return true
  }

  const changed = s.posted_date.slice(0, 10) !== r.postedDate
    || cents(s.amount) !== cents(r.amount)
    || (s.description ?? null) !== (r.description ?? null)
  if (untouched && changed) {
    const next = reviewState(r.postedDate)
    const res = await client.query(
      `UPDATE bank_transactions t
          SET posted_date = $2, amount = $3, description = $4, normalized_merchant = $5,
              bank_status = $6, status = $7, ignored_reason = $8, updated_at = now()
        WHERE t.id = $1 AND ${UNTOUCHED_SQL('t')}`,
      [s.id, r.postedDate, round2(r.amount).toFixed(2), r.description ?? null,
       normalizeMerchant(r.description), incoming, next.status, next.reason])
    if (res.rowCount) return true
  }
  if (s.bank_status !== incoming) {
    await client.query(`UPDATE bank_transactions SET bank_status = $2, updated_at = now() WHERE id = $1`, [s.id, incoming])
    return true
  }
  return false
}

/**
 * The bank voided a transaction whose kept copy (the original a hidden copy
 * points at) is this row. Untouched, it is hidden as voided — under the same
 * re-check every sync change makes. Filed, it stays in the books and is
 * flagged, so the page warns the landlord. The row is already locked by
 * upsertTransactions.
 */
async function voidTheOriginal(client: PoolClient, id: string, voidedMatched: string[] = []): Promise<void> {
  const hidden = (await client.query(
    `UPDATE bank_transactions t
        SET status = 'ignored', ignored_reason = 'bank_void', bank_status = 'void', updated_at = now()
      WHERE t.id = $1 AND t.bank_status IS DISTINCT FROM 'void' AND ${UNTOUCHED_SQL('t')}`, [id])).rowCount
  if (hidden) return
  const flagged = (await client.query<{ status: string }>(
    `UPDATE bank_transactions SET bank_status = 'void', updated_at = now()
      WHERE id = $1 AND bank_status IS DISTINCT FROM 'void' RETURNING status`, [id])).rows[0]
  if (flagged && (flagged.status === 'categorized' || flagged.status === 'matched')) {
    logger.warn({ transactionId: id, status: flagged.status }, '[bank-feed] the bank voided a transaction that was already filed (seen on its copy)')
  }
  if (flagged?.status === 'matched') voidedMatched.push(id)
}

/**
 * Pair each new row with at most one row on the same account's OTHER links —
 * same amount to the cent, posted within RELINK_PAIR_WINDOW_DAYS. Identical
 * bank text pairs first, then nearest date. Two identical charges on the new
 * link with one on the old pair once, and the second is stored as the real,
 * separate charge it is.
 */
async function pairAcrossLinks(
  client: PoolClient, connectionId: string, landlordId: string,
  conn: { institution_name: string | null; account_last4: string | null },
  fresh: FeedRow[],
): Promise<Map<FeedRow, Sibling>> {
  const pairs = new Map<FeedRow, Sibling>()
  // No last four, no way to know two links are the same account (a CSV import
  // has none) — never guess.
  if (!fresh.length || !conn.account_last4) return pairs
  const dates = fresh.map(r => r.postedDate).sort()
  // These rows are already locked by upsertTransactions, so `filed` is current
  // and stays so until the sync commits.
  const siblings = (await client.query<Omit<Sibling, 'day'>>(
    `SELECT t.id, t.posted_date::text AS posted_date, t.amount::text AS amount, t.description,
            ${FILED_SQL('t')} AS filed
       FROM bank_transactions t
       JOIN bank_connections c ON c.id = t.bank_connection_id
      WHERE t.landlord_id = $1
        AND t.bank_connection_id <> $2
        AND c.account_last4 = $3
        AND c.institution_name IS NOT DISTINCT FROM $4
        AND t.ignored_reason IS DISTINCT FROM 'duplicate'
        AND t.ignored_reason IS DISTINCT FROM 'bank_void'
        AND t.bank_status IS DISTINCT FROM 'void'
        -- already paired with a row on THIS link (which was kept as its copy)
        AND NOT EXISTS (SELECT 1 FROM bank_transactions d
                         WHERE d.duplicate_of_id = t.id AND d.bank_connection_id = $2)
        AND t.posted_date BETWEEN ($5::date - $7::int) AND ($6::date + $7::int)
      ORDER BY t.posted_date, t.created_at, t.id`,
    [landlordId, connectionId, conn.account_last4, conn.institution_name,
     dates[0], dates[dates.length - 1], RELINK_PAIR_WINDOW_DAYS])).rows
  if (!siblings.length) return pairs

  const byAmount = new Map<number, Sibling[]>()
  for (const s of siblings) {
    const k = cents(s.amount)
    const list = byAmount.get(k) ?? []
    list.push({ ...s, day: dayNumber(s.posted_date) })
    byAmount.set(k, list)
  }
  const taken = new Set<string>()
  const pass = (sameTextOnly: boolean) => {
    for (const r of fresh) {
      if (pairs.has(r)) continue
      const day = dayNumber(r.postedDate)
      let best: Sibling | null = null
      let bestGap = Infinity
      for (const s of byAmount.get(cents(r.amount)) ?? []) {
        if (taken.has(s.id)) continue
        const gap = Math.abs(s.day - day)
        if (gap > RELINK_PAIR_WINDOW_DAYS) continue
        if (sameTextOnly && (s.description ?? '') !== (r.description ?? '')) continue
        if (gap < bestGap) { best = s; bestGap = gap }
      }
      if (best) { pairs.set(r, best); taken.add(best.id) }
    }
  }
  pass(true)
  pass(false)
  return pairs
}

/** Pull transactions from Stripe FC for one connection and upsert them. */
export async function syncConnection(connectionId: string): Promise<{ inserted: number; pending?: boolean }> {
  const conn = await queryOne<any>('SELECT * FROM bank_connections WHERE id = $1', [connectionId])
  if (!conn) throw new AppError(404, 'Connection not found')
  if (conn.provider !== 'stripe_fc' || !conn.stripe_fc_account_id) {
    return { inserted: 0 } // CSV connections are populated via import, not sync.
  }
  const stripe = getStripe()
  const rows: FeedRow[] = []
  try {
    const list = stripe.financialConnections.transactions.list({ account: conn.stripe_fc_account_id, limit: 100 })
    let count = 0
    for await (const t of (list as any)) {
      const unix = t.transacted_at ?? t.status_transitions?.posted_at
      if (!unix) continue
      rows.push({
        externalId: t.id,
        postedDate: new Date(unix * 1000).toISOString().slice(0, 10),
        amount: (t.amount ?? 0) / 100,      // FC amount is in cents, +in / -out
        currency: t.currency ?? 'usd',
        description: t.description ?? null,
        // S655: pending / posted / void. Only posted becomes a new row; a stored
        // row follows the bank when it posts or is voided (upsertTransactions).
        status: t.status === 'pending' || t.status === 'void' ? t.status : 'posted',
      })
      if (++count >= 2000) break            // hard cap for a single sync pass
    }
    await query('UPDATE bank_connections SET last_synced_at=now(), last_sync_error=NULL, status=$2 WHERE id=$1',
      [connectionId, 'active'])
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // S605: right after linking, Stripe replies "A transaction refresh is still
    // pending for this account" while it backfills history. That is the NORMAL
    // first-sync path, not a failure — but it was being written as
    // status='error' with the raw message, so a landlord who had just connected
    // successfully saw their brand-new bank sitting in an error state.
    if (/refresh is still pending|still pending for this account/i.test(msg)) {
      await query(
        `UPDATE bank_connections
            SET status = 'active',
                last_sync_error = 'Stripe is still fetching your history — this can take a few minutes on a new connection.'
          WHERE id = $1`, [connectionId])
      return { inserted: 0, pending: true }
    }
    await query('UPDATE bank_connections SET last_sync_error=$2, status=$3 WHERE id=$1',
      [connectionId, msg.slice(0, 500), 'error'])
    throw new AppError(502, 'Could not sync transactions from the bank')
  }
  const inserted = await upsertTransactions(connectionId, conn.landlord_id, rows)
  // S642 (Nic): the balance is NO LONGER refreshed on every transaction sync.
  //
  // Every refresh is a billable Stripe Financial Connections call. Riding along
  // with a sync that runs four times a day cost $9.30 in August for a SINGLE
  // linked account — against $0.30 for the transaction subscription that is the
  // feature's actual point. The expensive half was the nicety.
  //
  // It now runs once a day on banking days only (see the scheduler), because a
  // real bank does not post on a weekend or a federal holiday either. Callers
  // who genuinely need it fresh — someone opening the page — call
  // refreshBalance() directly.
  return { inserted }
}

/**
 * S605: cache the account's current balance on the connection.
 *
 * Deliberately best-effort and swallowed by the caller. A balance is a
 * convenience read on a page whose actual job is categorizing transactions —
 * it must never be able to fail a sync or block the review queue. When it
 * can't be read (a link consented before S605, an institution that doesn't
 * report one, Stripe having a bad minute) the column stays NULL and the UI
 * says the balance isn't available rather than showing a stale or wrong one.
 *
 * `available` is preferred over `current` because it's the spendable figure a
 * landlord means when they ask what's in the account; `current` includes funds
 * still on hold.
 */
export async function refreshBalance(conn: any): Promise<void> {
  if (conn.provider !== 'stripe_fc' || !conn.stripe_fc_account_id) return
  const stripe = getStripe()

  // S652 (Nic): "it shows September 18th, four days behind, but the sync
  // button thinks it's current." The refresh call returns the account BEFORE
  // the bank has answered, so this wrote yesterday's figure every morning and
  // never looked again. Ask, then wait for Stripe to say the refresh finished
  // (a few seconds), then read the balance it actually got.
  let acct: any
  try {
    acct = await stripe.financialConnections.accounts.refresh(conn.stripe_fc_account_id, {
      features: ['balance'],
    })
    const startedAt = Number(acct?.balance?.as_of ?? 0)
    for (let i = 0; i < 8; i++) {
      const st = acct?.balance_refresh?.status
      const fresh = Number(acct?.balance?.as_of ?? 0) > startedAt
      if (st && st !== 'pending' && (fresh || i > 1)) break
      await new Promise(r => setTimeout(r, 1500))
      acct = await stripe.financialConnections.accounts.retrieve(conn.stripe_fc_account_id)
    }
  } catch {
    // Refresh is a nicety — an account Stripe already has a balance for still
    // reports it on a plain retrieve, so fall back rather than giving up.
    acct = await stripe.financialConnections.accounts.retrieve(conn.stripe_fc_account_id)
  }

  const bal = acct?.balance
  if (!bal) return
  // Both shapes are currency-keyed maps of minor units. The account balance
  // as the bank states it — what the landlord compares against their own
  // banking app — not the "available" subset.
  const pick = bal.current ?? bal.cash?.available ?? null
  if (!pick) return
  const currency = Object.keys(pick)[0]
  if (!currency) return
  const minorUnits = Number(pick[currency])
  if (!Number.isFinite(minorUnits)) return

  await query(
    `UPDATE bank_connections
        SET current_balance = $2, balance_currency = $3, balance_as_of = COALESCE(to_timestamp($4), now())
      WHERE id = $1`,
    [conn.id, round2(minorUnits / 100).toFixed(2), currency, bal.as_of ?? null])
}

/**
 * Auto-match INBOUND (amount > 0) needs_review transactions to the settled GAM
 * disbursement that produced them (same amount, posted date within the window).
 * Matched rows drop out of the review queue — the landlord never re-categorizes
 * money GAM already moved. Amounts GAM did NOT move stay needs_review.
 *
 * S655 review: the candidates are read without a lock, so by the time a match
 * is written the landlord may have filed the row as income, a tenant's deposit
 * may have been confirmed against it, or a sync may have hidden it as a copy.
 * The write re-checks, on the row itself, that it is still an untouched deposit
 * in review — and a match only counts when it landed. One matcher per company
 * at a time, so two syncs finishing together cannot hand one payout to two
 * deposits. (A NULL bank_status is a row stored before S655, read as posted.)
 */
const AUTO_MATCHABLE_SQL = (t: string) => `(${t}.status = 'needs_review' AND ${t}.amount > 0
  AND COALESCE(${t}.bank_status, 'posted') = 'posted'
  AND ${t}.expense_id IS NULL AND ${t}.landlord_other_income_id IS NULL
  AND ${t}.matched_payment_id IS NULL AND ${t}.matched_disbursement_id IS NULL)`

export async function autoMatchLandlord(landlordId: string): Promise<number> {
  const client = await getClient()
  let matched = 0
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`bank_feed_auto_match:${landlordId}`])
    const candidates = (await client.query<{ id: string; amount: string; posted_date: string }>(
      `SELECT t.id, t.amount::text AS amount, to_char(t.posted_date, 'YYYY-MM-DD') AS posted_date
         FROM bank_transactions t
        WHERE t.landlord_id = $1
          -- an untouched deposit in review, once the bank has posted it
          AND ${AUTO_MATCHABLE_SQL('t')}
        -- id order, the order every other bank-row locker takes (the sync, the
        -- books start date), so a match landing mid-save waits, never deadlocks
        ORDER BY t.id`, [landlordId])).rows
    for (const t of candidates) {
      const disb = (await client.query<{ id: string }>(
        `SELECT d.id FROM disbursements d
          WHERE d.landlord_id = $1 AND d.status = 'settled'
            AND d.amount = $2
            AND d.settled_at IS NOT NULL
            AND ABS(d.settled_at::date - $3::date) <= $4
            AND NOT EXISTS (SELECT 1 FROM bank_transactions bt
                             WHERE bt.matched_disbursement_id = d.id)
          ORDER BY ABS(d.settled_at::date - $3::date) ASC
          LIMIT 1`,
        [landlordId, Number(t.amount).toFixed(2), t.posted_date, MATCH_DATE_WINDOW_DAYS])).rows[0]
      if (!disb?.id) continue
      // Waits for a filing in progress on this row, then re-checks it — and
      // that it is still the deposit the payout was chosen for. The matcher
      // runs after the sync commits, outside its lock, so the next sync on the
      // link can follow the bank and change an untouched row's amount or date
      // in between; a payout picked for the old amount must not land on it.
      // That sync's own matcher looks again with the new figures.
      const res = await client.query(
        `UPDATE bank_transactions t SET status = 'matched', matched_disbursement_id = $2, updated_at = now()
          WHERE t.id = $1 AND ${AUTO_MATCHABLE_SQL('t')}
            AND t.amount = $3::numeric AND t.posted_date = $4::date`,
        [t.id, disb.id, t.amount, t.posted_date])
      if (res.rowCount) matched++
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return matched
}

/**
 * S624 — auto-settle a deposit the TENANT declared and the BANK confirms.
 *
 * It takes TWO INDEPENDENT SIGNALS that had to agree, neither of them the
 * landlord's guess: the tenant said they deposited $X on a date; a bank row for
 * exactly $X posted within the window; and the instrument they named does not
 * contradict what the memo describes.
 *
 * S655 (Step 12): one step of reconcileDeposits, kept callable on its own.
 * A deposit slip or a combination of the office's unbanked cash of the same
 * amount competes with the report, so the row waits for a person instead.
 *
 * Never throws. A deposit that cannot be auto-settled simply stays in the review
 * queue with its shortlist, which is exactly where it would have been anyway.
 */
export async function autoSettleDeclaredDeposits(landlordId: string): Promise<number> {
  return (await runDepositSteps(landlordId, new Set<DepositActionKind>(['declared']))).declared
}

/**
 * S655 (money plan §3, "Bank-deposit auto-settle by amount"; Step 12). A
 * deposit nobody reported settles a tenant's bills by itself only when it is
 * exactly one tenant's WHOLE bank-payable bill to the cent and nothing else
 * fits (bankDepositMatch.isAutoSettleable). Both sides are told; the landlord
 * can undo it (bankDepositConfirm.undoDepositMatch).
 */
export async function autoSettleByAmount(landlordId: string): Promise<number> {
  return (await runDepositSteps(landlordId, new Set<DepositActionKind>(['auto_settle']))).autoSettled
}

/**
 * S655 (Nic 10/2, K-D): money GAM never handled files itself once the landlord
 * has filed money in from the same payer — labeled, with one-click undo. Never
 * money out, a rent-channel payer, a payer ever matched to a tenant bill, a
 * memo that names no payer, or a deposit equal to any open bill.
 */
export async function autoFileIncome(landlordId: string): Promise<number> {
  return (await runDepositSteps(landlordId, new Set<DepositActionKind>(['auto_file']))).autoFiled
}

export interface ReconcileResult {
  payouts: number; slips: number; inferred: number; declared: number; autoSettled: number; autoFiled: number
}

/**
 * Every automatic step for a company's new money in, in the money plan's order
 * (§3): GAM's own payouts, then for each untouched deposit — a deposit slip,
 * the office's cash worked out (everything not banked, or the only combination),
 * a tenant's report, a tenant's whole bill to the cent, income from a payer the
 * landlord already filed. A deposit two of these could explain waits for a
 * person (decideDeposit). Never throws: a sync must never fail on this.
 */
export async function reconcileDeposits(landlordId: string): Promise<ReconcileResult> {
  let payouts = 0
  try { payouts = await autoMatchLandlord(landlordId) } catch (e) {
    logger.warn({ err: e, landlordId }, '[bank-feed] payout matching skipped')
  }
  const r = await runDepositSteps(landlordId, new Set<DepositActionKind>(
    ['slip', 'inferred', 'declared', 'auto_settle', 'auto_file']))
  return { ...r, payouts }
}

export type DepositActionKind = 'slip' | 'inferred' | 'declared' | 'auto_settle' | 'auto_file'

/** A money-in row nobody has acted on, the bank has posted, and no person has undone. */
const RECONCILABLE_SQL = (t: string) => `(${AUTO_MATCHABLE_SQL(t)} AND ${t}.auto_settle_undo IS NULL)`

interface DepositRow {
  id: string; landlord_id: string; amount: number; posted_date: string
  description: string | null; normalized_merchant: string | null
}

type DepositDecision =
  | { kind: 'slip'; slipId: string }
  | { kind: 'inferred'; items: import('./depositSlips').CashItem[] }
  | { kind: 'declared'; chargeIds: string[]; declarationId: string; method: string }
  | { kind: 'auto_settle'; chargeIds: string[]; method: 'cash' | 'check' | 'money_order' }
  | { kind: 'auto_file'; rule: AutoFileRule }
  | { kind: 'review'; why: string }

interface AutoFileRule {
  id: string; category: string; scope_kind: MerchantRuleScope; property_id: string | null; unit_id: string | null
}

async function runDepositSteps(landlordId: string, allowed: Set<DepositActionKind>): Promise<Omit<ReconcileResult, 'payouts'>> {
  const out = { slips: 0, inferred: 0, declared: 0, autoSettled: 0, autoFiled: 0 }
  let rows: DepositRow[]
  try {
    rows = await query<DepositRow>(
      `SELECT t.id, t.landlord_id, t.amount::float AS amount, to_char(t.posted_date, 'YYYY-MM-DD') AS posted_date,
              t.description, t.normalized_merchant
         FROM bank_transactions t
        WHERE t.landlord_id = $1 AND ${RECONCILABLE_SQL('t')}
        ORDER BY t.posted_date, t.id`, [landlordId])
  } catch (e) {
    logger.warn({ err: e, landlordId }, '[bank-feed] reconcile skipped')
    return out
  }
  for (const txn of rows) {
    try {
      const d = await decideDeposit(txn)
      if (d.kind === 'review' || !allowed.has(d.kind)) continue
      if (await actOnDeposit(txn, d)) {
        if (d.kind === 'slip') out.slips++
        else if (d.kind === 'inferred') out.inferred++
        else if (d.kind === 'declared') out.declared++
        else if (d.kind === 'auto_settle') out.autoSettled++
        else if (d.kind === 'auto_file') out.autoFiled++
      }
    } catch (e) {
      // One bad deposit must not stop the rest, and must not fail a bank sync.
      logger.warn({ err: e, transaction_id: txn.id }, '[bank-feed] automatic step skipped')
    }
  }
  return out
}

/**
 * What GAM may do by itself with one untouched deposit, if anything. The order
 * is the plan's; a deposit that two different things could explain waits.
 */
async function decideDeposit(txn: DepositRow): Promise<DepositDecision> {
  const { openSlipsFitting, cashProposalFor } = await import('./depositSlips')
  const { candidatesForDeposit } = await import('./bankDepositCandidates')
  const { isPreselectable, isAutoSettleable, memoMethodHint, memoSaysTransfer, DECLARATION_DATE_WINDOW_DAYS, AUTO_SETTLE_SAME_AMOUNT_DAYS } =
    await import('./bankDepositMatch')
  const slips = await openSlipsFitting(db, txn.landlord_id, txn)
  // Who the memo names, read fresh from the bank's own words (a row stored
  // before the payer key changed still carries the old key).
  const payerKey = normalizeMerchant(txn.description)
  // decisions.md #48.1: a transfer between accounts ("ONLINE TRANSFER FROM
  // CHK 1234") names nobody, yet it is most often the landlord's own money:
  // never the office's cash, never a slip, never a bill paid on amount alone.
  const transfer = memoSaysTransfer(txn.description) || memoSaysTransfer(payerKey)
  // GAM works out the office's own bag only for a deposit whose memo names
  // nobody ("DEPOSIT", "BRANCH DEP"): a Square or DoorLoop payout that happens
  // to equal a cash receipt is not the office's cash.
  const cash = transfer || namesAPayer(payerKey)
    ? { kind: 'none' as const, items: [], totalCents: 0, note: '' }
    : await cashProposalFor(db, txn.landlord_id, txn)
  const { candidates } = await candidatesForDeposit(txn)
  const reports = Number((await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tenant_declared_deposits
      WHERE landlord_id = $1 AND status = 'pending' AND amount = $2::numeric
        AND declared_date BETWEEN ($3::date - $4::int) AND ($3::date + $4::int)`,
    [txn.landlord_id, Number(txn.amount).toFixed(2), txn.posted_date, DECLARATION_DATE_WINDOW_DAYS]))?.n ?? 0)

  // A tenant's whole bill, to the cent, with nothing else fitting.
  const cashAny = cash.kind === 'everything' || cash.kind === 'one' || cash.kind === 'several'
  let autoSettle: { chargeIds: string[]; method: 'cash' | 'check' | 'money_order' } | null = null
  const sameAmount = Number((await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bank_transactions o
      WHERE o.landlord_id = $1 AND o.id <> $2 AND o.amount = $3::numeric AND o.amount > 0
        AND o.posted_date BETWEEN ($4::date - $5::int) AND ($4::date + $5::int)
        AND o.ignored_reason IS DISTINCT FROM 'duplicate' AND o.ignored_reason IS DISTINCT FROM 'bank_void'
        AND COALESCE(o.bank_status, 'posted') <> 'void'
        AND o.matched_disbursement_id IS NULL`,
    [txn.landlord_id, txn.id, Number(txn.amount).toFixed(2), txn.posted_date, AUTO_SETTLE_SAME_AMOUNT_DAYS]))?.n ?? 0)
  // Only a tenant's OWN deposit settles by itself: a memo that names nobody
  // (a branch or ATM deposit), or a check naming the tenant. A payout from a
  // rent channel (DoorLoop…) or any other named payer (Square…) that happens
  // to equal a bill is never a tenant's payment on amount alone.
  const anonymous = !transfer && !namesAPayer(payerKey)
  const rentChannel = isRentChannelPayer(payerKey) || isRentChannelPayer(txn.description)
  for (const m of candidates) {
    if (m.confidence !== 'amount_unique' && m.confidence !== 'named_exact') continue
    if (rentChannel || (m.confidence === 'amount_unique' && !anonymous)) continue
    const h = await queryOne<{ owed: string; reports: string; billed_before: boolean }>(
      `WITH hl AS (
         SELECT l.id FROM leases l
          WHERE l.landlord_id = $1
            AND (EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $2)
                 OR EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = l.id AND p.tenant_id = $2)))
       SELECT (SELECT COALESCE(SUM(vm.money_part), 0)::text
                 FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
                 JOIN units u ON u.id = p.unit_id
                WHERE p.landlord_id = $1 AND p.lease_id IN (SELECT id FROM hl)
                  AND ${bankPayableRowSql('p')} AND vm.money_part > 0 AND u.payment_block IS NOT TRUE) AS owed,
              (SELECT COUNT(*)::text FROM tenant_declared_deposits d
                WHERE d.landlord_id = $1 AND d.status = 'pending' AND d.lease_id IN (SELECT id FROM hl)) AS reports,
              -- Every line was billed by the day the money went in: a deposit
              -- made before a bill existed is not that bill's payment.
              (SELECT COALESCE(bool_and((p.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <= $3::date), FALSE)
                 FROM payments p LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
                WHERE p.id = ANY($4::uuid[])) AS billed_before`,
      [txn.landlord_id, m.tenantId, txn.posted_date, m.chargeIds])
    if (!h?.billed_before) continue
    // Judged first WITHOUT the office's cash: a tenant's whole bill that fits
    // is itself a reason a slip or the office's cash must not be assumed.
    if (isAutoSettleable(m, candidates, {
      householdOwed: Number(h?.owed ?? 0),
      pendingReports: reports + Number(h?.reports ?? 0),
      sameAmountDeposits: sameAmount,
      competingCash: false,
      description: txn.description,
    })) {
      // A named match settles only from a check-shaped memo (isTenantCheckMemo).
      const hint = memoMethodHint(txn.description)
      autoSettle = { chargeIds: m.chargeIds, method: m.confidence === 'named_exact' ? 'check' : (hint ?? 'cash') }
      break
    }
  }
  // Something says a tenant paid this — their report, or a whole bill that fits it.
  const tenantSignal = reports > 0 || autoSettle !== null

  // 1. A deposit slip staff made (a transfer is never the office's bag).
  if (slips.length > 0 && transfer) return { kind: 'review', why: 'a transfer between accounts' }
  if (slips.length > 0) {
    if (slips.length === 1 && !tenantSignal) return { kind: 'slip', slipId: slips[0].id }
    return { kind: 'review', why: slips.length > 1 ? 'several slips fit' : 'a tenant may have paid this' }
  }
  // 2. The office's cash, worked out: everything not banked, or the only combination.
  if (cashAny) {
    if ((cash.kind === 'everything' || cash.kind === 'one') && !tenantSignal) return { kind: 'inferred', items: cash.items }
    return { kind: 'review', why: 'the office’s cash may be this deposit' }
  }
  // 3. A tenant's report the bank confirms.
  const top = candidates[0]
  if (top && top.confidence === 'declared' && isPreselectable(top) && top.chargeIds.length > 0) {
    const decl = await queryOne<{ id: string; method: string }>(
      `SELECT id, method FROM tenant_declared_deposits
        WHERE lease_id = $1 AND status = 'pending' AND amount = $2
        ORDER BY declared_date DESC LIMIT 1`,
      [top.leaseId, Number(txn.amount).toFixed(2)])
    if (decl) return { kind: 'declared', chargeIds: top.chargeIds, declarationId: decl.id, method: decl.method }
  }
  // 4. A tenant's whole bill, to the cent, nothing else fitting (no slip and no
  //    combination of the office's cash competes — those returned above).
  if (autoSettle) return { kind: 'auto_settle', ...autoSettle }
  // 5. Income from a payer the landlord already filed — only when no tenant
  //    could have paid it at all.
  if (candidates.length === 0 && reports === 0) {
    const rule = await autoFileRuleFor(txn)
    if (rule) return { kind: 'auto_file', rule }
  }
  return { kind: 'review', why: 'nothing certain' }
}

async function actOnDeposit(txn: DepositRow, d: DepositDecision): Promise<boolean> {
  if (d.kind === 'declared' || d.kind === 'auto_settle') {
    const { confirmDepositMatch } = await import('./bankDepositConfirm')
    await confirmDepositMatch({
      bankTransactionId: txn.id,
      chargeIds: d.chargeIds,
      method: d.method as any,
      declarationId: d.kind === 'declared' ? d.declarationId : null,
      confirmedByUserId: null,
      auto: d.kind === 'auto_settle',
    })
    return true
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`bank_feed_reconcile:${txn.landlord_id}`])
    // Still untouched, under the lock (a person may have acted meanwhile).
    const still = (await client.query(
      `SELECT t.id FROM bank_transactions t WHERE t.id = $1 AND ${RECONCILABLE_SQL('t')} FOR UPDATE`, [txn.id])).rows[0]
    if (!still) { await client.query('ROLLBACK'); return false }
    if (d.kind === 'slip') {
      const { matchSlipToDeposit } = await import('./depositSlips')
      await matchSlipToDeposit(client, { slipId: d.slipId, transactionId: txn.id, landlordId: txn.landlord_id, matchedBy: null, inferred: false })
    } else if (d.kind === 'inferred') {
      const { matchInferredBatch } = await import('./depositSlips')
      await matchInferredBatch(client, { landlordId: txn.landlord_id, transactionId: txn.id, postedDate: txn.posted_date, items: d.items })
    } else if (d.kind === 'auto_file') {
      const row = (await client.query(
        `SELECT *, to_char(posted_date, 'YYYY-MM-DD') AS posted_date_str FROM bank_transactions WHERE id = $1`, [txn.id])).rows[0]
      await fileAsIncome(client, txn.landlord_id, row, {
        category: d.rule.category, scopeKind: d.rule.scope_kind,
        unitId: d.rule.unit_id, propertyId: d.rule.property_id,
        description: row.description ?? null, vendor: row.normalized_merchant ?? null,
      })
      await client.query(
        `UPDATE bank_transactions SET auto_filed_rule_id = $2, auto_filed_at = now(), updated_at = now() WHERE id = $1`,
        [txn.id, d.rule.id])
    }
    await client.query('COMMIT')
    return true
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    // A receipt put on another slip in the meantime, or a filing that raced:
    // the row stays for review.
    if (e?.code === '23505' || e instanceof AppError) {
      logger.info({ transactionId: txn.id, kind: d.kind, err: e?.message }, '[bank-feed] automatic step stood down')
      return false
    }
    throw e
  } finally {
    client.release()
  }
}

/**
 * Has this payer ever been matched to a tenant's bill at this company? A deposit
 * that once paid rent (matched, confirmed, auto-settled, a tenant's report —
 * undone or not) means that payer can carry rent, so its money is never filed
 * as income by itself.
 */
async function payerEverMatchedToTenantBill(landlordId: string, normalized: string): Promise<boolean> {
  const r = await queryOne<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bank_transactions bt
        WHERE bt.landlord_id = $1 AND bt.normalized_merchant = $2
          AND (bt.matched_payment_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM bank_deposit_allocations a WHERE a.bank_transaction_id = bt.id)
               OR EXISTS (SELECT 1 FROM tenant_declared_deposits d WHERE d.bank_transaction_id = bt.id)
               OR (bt.auto_settle_undo ? 'receiptId')
               OR (bt.auto_settle_undo -> 'was' ? 'receiptId'))) AS hit`, [landlordId, normalized])
  return !!r?.hit
}

/**
 * Does this amount equal any open bill at the company — one line, one
 * household's whole balance, or one invoice's open lines? Then it may be rent,
 * and it is never filed as income by itself.
 */
async function equalsAnyOpenBill(landlordId: string, amount: number): Promise<boolean> {
  const r = await queryOne<{ hit: boolean }>(
    `WITH open AS (
       SELECT p.id, p.tenant_id, p.invoice_id, vm.money_part
         FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
        WHERE p.landlord_id = $1 AND ${payableRowSql('p')} AND vm.money_part > 0)
     SELECT EXISTS (SELECT 1 FROM open WHERE money_part = $2::numeric)
         OR EXISTS (SELECT 1 FROM (SELECT SUM(money_part) AS s FROM open WHERE tenant_id IS NOT NULL GROUP BY tenant_id) x
                     WHERE x.s = $2::numeric)
         OR EXISTS (SELECT 1 FROM (SELECT SUM(money_part) AS s FROM open WHERE invoice_id IS NOT NULL GROUP BY invoice_id) x
                     WHERE x.s = $2::numeric) AS hit`,
    [landlordId, Number(amount).toFixed(2)])
  return !!r?.hit
}

/** The payer rule a deposit would file itself under, or null (every refusal in one place). */
async function autoFileRuleFor(txn: DepositRow): Promise<AutoFileRule | null> {
  const merchant = txn.normalized_merchant ?? ''
  if (!(Number(txn.amount) > 0) || !merchant || !namesAPayer(merchant)) return null
  if (isRentChannelPayer(merchant) || isRentChannelPayer(txn.description)) return null
  // #48.1: a transfer between accounts ("XFER FROM SAVINGS") is most often the
  // landlord's own money — never income that files itself.
  if (memoSaysTransfer(merchant) || memoSaysTransfer(txn.description)) return null
  const rule = await queryOne<AutoFileRule & { last_direction: string | null; auto_file_income: boolean }>(
    `SELECT id, category, scope_kind, property_id, unit_id, last_direction, auto_file_income
       FROM landlord_merchant_rules WHERE landlord_id = $1 AND normalized_merchant = $2`, [txn.landlord_id, merchant])
  if (!rule || rule.last_direction !== 'in' || !rule.auto_file_income) return null
  if (!(OTHER_INCOME_CATEGORIES as readonly string[]).includes(rule.category)) return null
  if (await payerEverMatchedToTenantBill(txn.landlord_id, merchant)) return null
  if (await equalsAnyOpenBill(txn.landlord_id, txn.amount)) return null
  return { id: rule.id, category: rule.category, scope_kind: rule.scope_kind, property_id: rule.property_id, unit_id: rule.unit_id }
}

/**
 * Undo an income filing the feed made by itself: the income is voided and the
 * deposit goes back to review — never filed by itself again. With
 * stopAutoFiling, this payer's deposits stop filing themselves at all.
 */
export async function undoAutoFile(
  landlordId: string, txnId: string, opts: { stopAutoFiling?: boolean; undoneBy: string | null },
): Promise<{ id: string; stoppedForPayer: string | null }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const t = (await client.query<any>(
      `SELECT id, status, landlord_other_income_id, auto_filed_rule_id, auto_filed_at, normalized_merchant
         FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [txnId, landlordId])).rows[0]
    if (!t) throw new AppError(404, 'Transaction not found')
    if (!t.auto_filed_rule_id || t.status !== 'categorized') {
      throw new AppError(409, 'This deposit was not filed by itself, so there is nothing to undo here.')
    }
    if (t.landlord_other_income_id) {
      const v = await client.query(
        `UPDATE landlord_other_income SET status = 'voided', voided_at = now(), updated_at = now()
          WHERE id = $1 AND landlord_id = $2 AND status = 'active'`, [t.landlord_other_income_id, landlordId])
      if ((v.rowCount ?? 0) !== 1) {
        throw new AppError(409, 'The income this deposit filed was changed since, so it can’t be undone here.')
      }
    }
    const marker = {
      version: 1, undone: true, undoneAt: new Date().toISOString(), undoneBy: opts.undoneBy,
      was: { kind: 'auto_filed', ruleId: t.auto_filed_rule_id, incomeId: t.landlord_other_income_id, filedAt: t.auto_filed_at },
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = 'needs_review', landlord_other_income_id = NULL, categorized_at = NULL,
              auto_filed_rule_id = NULL, auto_filed_at = NULL, auto_settle_undo = $2::jsonb, updated_at = now()
        WHERE id = $1`, [txnId, JSON.stringify(marker)])
    let stopped: string | null = null
    if (opts.stopAutoFiling) {
      await client.query(
        `UPDATE landlord_merchant_rules SET auto_file_income = FALSE, updated_at = now() WHERE id = $1 AND landlord_id = $2`,
        [t.auto_filed_rule_id, landlordId])
      stopped = t.normalized_merchant ?? null
    }
    await client.query('COMMIT')
    return { id: txnId, stoppedForPayer: stopped }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Suggestions (per-landlord merchant memory) ──────────────────────────────
export async function suggestForMerchant(landlordId: string, normalizedMerchant: string) {
  if (!normalizedMerchant) return null
  const rule = await queryOne<any>(
    `SELECT category, scope_kind, property_id, unit_id, hit_count
       FROM landlord_merchant_rules
      WHERE landlord_id = $1 AND normalized_merchant = $2`, [landlordId, normalizedMerchant])
  if (!rule) return null
  return {
    category: rule.category,
    scopeKind: rule.scope_kind as MerchantRuleScope,
    propertyId: rule.property_id,
    unitId: rule.unit_id,
    hitCount: rule.hit_count,
  }
}

/**
 * Remember what the landlord did with this payer, for next time. S655 (Step
 * 12): and which way the money went. Money in from a payer sets
 * last_direction 'in' — what lets that payer's next deposit file itself
 * (autoFileRuleFor) — EXCEPT for a rent channel (RENT_CHANNEL_PAYERS: DoorLoop,
 * AppFolio…), a payer ever matched to a tenant's bill, a transfer between
 * accounts ("XFER FROM SAVINGS", #48.1 — most often the landlord's own money),
 * or a memo that names no payer at all ("MOBILE DEPOSIT"): those are written
 * with no direction, so they
 * never file themselves. Money out sets 'out'.
 */
async function rememberMerchantChoice(landlordId: string, normalizedMerchant: string, input: {
  category: string; scopeKind: MerchantRuleScope; propertyId: string | null; unitId: string | null
  direction: 'in' | 'out'; description?: string | null
}) {
  if (!normalizedMerchant) return
  let direction: 'in' | 'out' | null = input.direction
  if (direction === 'in' && (
    !namesAPayer(normalizedMerchant)
    || isRentChannelPayer(normalizedMerchant) || isRentChannelPayer(input.description)
    || memoSaysTransfer(normalizedMerchant) || memoSaysTransfer(input.description)
    || await payerEverMatchedToTenantBill(landlordId, normalizedMerchant))) {
    direction = null
  }
  await query(
    `INSERT INTO landlord_merchant_rules
       (landlord_id, normalized_merchant, category, scope_kind, property_id, unit_id, last_direction)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (landlord_id, normalized_merchant) DO UPDATE
       SET category=EXCLUDED.category, scope_kind=EXCLUDED.scope_kind,
           property_id=EXCLUDED.property_id, unit_id=EXCLUDED.unit_id,
           last_direction=EXCLUDED.last_direction,
           hit_count=landlord_merchant_rules.hit_count + 1,
           last_used_at=now(), updated_at=now()`,
    [landlordId, normalizedMerchant, input.category, input.scopeKind, input.propertyId, input.unitId, direction])
}

// ── Categorize (2-click → expense or income) ────────────────────────────────

type CategorizeInput = {
  category: string
  scopeKind: MerchantRuleScope
  unitId?: string | null
  propertyId?: string | null
  vendor?: string | null
  description?: string | null
}

/**
 * S655: may this row be filed into the P&L? Only from review, or from a row the
 * landlord ignored themselves (changing their mind). Everything else is either
 * already in the books or is not a transaction to file — and the message says
 * which, because "not found" would send the landlord looking for a bug.
 */
function assertFileable(txn: any) {
  if (txn.status === 'categorized') throw new AppError(409, 'Transaction already categorized')
  // Whatever its status says, a row that already booked an expense or income
  // is in the books. Filing it again would count the same money twice.
  if (txn.expense_id || txn.landlord_other_income_id) {
    throw new AppError(409, 'This transaction is already filed in your books.')
  }
  // Money GAM already has on record reaches the P&L through `payments`; filing
  // it here too would count it twice (S605). A tenant's confirmed deposit is
  // the same money as the rent it settled.
  if (txn.status === 'matched' || txn.matched_disbursement_id || txn.matched_payment_id) {
    throw new AppError(409, txn.matched_payment_id && !txn.matched_disbursement_id
      ? 'This deposit is already applied to a tenant’s rent, so it’s counted in your income automatically. Recording it again would double it.'
      : 'This deposit is money GAM already sent you, so it’s counted in your income automatically. Recording it again would double it.')
  }
  if (txn.bank_status === 'void' || txn.ignored_reason === 'bank_void') {
    throw new AppError(409, 'Your bank voided this transaction, so there’s nothing to file.')
  }
  if (txn.status === 'ignored' && txn.ignored_reason === 'duplicate') {
    throw new AppError(409,
      'This is a second copy of a transaction already on your feed, from an earlier link to the same bank. File the original instead.')
  }
  if (txn.status === 'ignored' && txn.ignored_reason === 'before_books') {
    throw new AppError(409, 'This is from before your books start date. Move the start date earlier if you want to file it.')
  }
  if (txn.status !== 'needs_review' && txn.status !== 'ignored') {
    throw new AppError(409, 'This transaction can’t be filed.')
  }
}

/**
 * File a bank row into the landlord's P&L: money out → landlord_expenses, money
 * in → landlord_other_income (S605). Landlord-confirmed; scope is required.
 * Remembers the merchant choice for next time.
 *
 * S655: the row is locked for the whole filing, so a double click can no longer
 * book the same charge twice, and the guards above run against the locked row.
 */
export async function categorizeTransaction(landlordId: string, txnId: string, input: CategorizeInput):
  Promise<{ expenseId?: string; incomeId?: string }> {
  const client = await getClient()
  let remembered: {
    normalizedMerchant: string; propertyId: string | null; unitId: string | null
    direction: 'in' | 'out'; description: string | null
  } | null = null
  let result: { expenseId?: string; incomeId?: string }
  try {
    await client.query('BEGIN')
    const txn = (await client.query(
      `SELECT *, to_char(posted_date, 'YYYY-MM-DD') AS posted_date_str
         FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [txnId, landlordId])).rows[0]
    if (!txn) throw new AppError(404, 'Transaction not found')
    assertFileable(txn)
    if (Number(txn.amount) === 0) throw new AppError(400, 'This transaction has no amount to categorize')

    // S605: the branch is on the sign of the amount, not on a caller-supplied
    // flag, so there's no way to file a deposit as an expense or a payment as
    // income — and neither category set may cross over.
    if (Number(txn.amount) > 0) {
      const r = await fileAsIncome(client, landlordId, txn, input)
      result = { incomeId: r.incomeId }
      remembered = {
        normalizedMerchant: txn.normalized_merchant, propertyId: r.propertyId, unitId: r.unitId,
        direction: 'in', description: txn.description ?? null,
      }
    } else {
      if (!EXPENSE_CATEGORIES.includes(input.category as any)) {
        throw new AppError(400, 'Pick an expense category for money going out')
      }
      // Scope → expense shape.
      let unitId: string | null = null
      let propertyId: string | null = null
      let isCommon = false
      if (input.scopeKind === 'unit') {
        if (!input.unitId) throw new AppError(400, 'A unit is required for unit scope')
        unitId = input.unitId
      } else {
        if (!input.propertyId) throw new AppError(400, 'A property is required for property scope')
        propertyId = input.propertyId
        isCommon = true
        // S603 (Nic): 'property_common' and 'property_allocate' now behave
        // IDENTICALLY — every non-unit cost is split across the property's units at
        // report time, so there is nothing left to choose between. The enum value is
        // still accepted (existing merchant rules carry it) but no longer branches.
        // Retiring the duplicate value needs its own migration + backfill.
      }
      // createLandlordExpense checks the unit/property belong to this landlord.
      // S655 review: on THIS transaction's client, so the expense and the row
      // marked filed commit together or not at all — never an expense booked
      // with the row still in review, waiting to be filed (and booked) again.
      const expense = await createLandlordExpense({
        landlordId,
        propertyId,
        unitId,
        category: input.category,
        amount: Math.abs(Number(txn.amount)),
        description: input.description ?? txn.description ?? null,
        vendor: input.vendor ?? txn.normalized_merchant ?? null,
        expenseDate: txn.posted_date_str,
        isCommon,
      }, client)
      await client.query(
        `UPDATE bank_transactions
            SET status='categorized', ignored_reason=NULL, expense_id=$2, categorized_at=now(), updated_at=now()
          WHERE id=$1`, [txnId, expense.id])
      result = { expenseId: expense.id }
      remembered = {
        normalizedMerchant: txn.normalized_merchant, propertyId, unitId,
        direction: 'out', description: txn.description ?? null,
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  // Remember the merchant choice (outside the txn — a best-effort learning write).
  if (remembered) {
    await rememberMerchantChoice(landlordId, remembered.normalizedMerchant, {
      category: input.category, scopeKind: input.scopeKind,
      propertyId: remembered.propertyId, unitId: remembered.unitId,
      direction: remembered.direction, description: remembered.description,
    })
  }
  return result
}

/**
 * S605: record a money-in bank row as landlord income, inside the caller's
 * transaction. Only unmatched deposits — money GAM never moved — reach here
 * (assertFileable refuses the rest).
 *
 * S655: the unit or property named in the request must be this landlord's.
 * It was stored unchecked, so a request could file income against another
 * company's unit. A unit-scoped row also records the unit's property, the same
 * shape createLandlordExpense gives an expense.
 */
async function fileAsIncome(client: PoolClient, landlordId: string, txn: any, input: CategorizeInput) {
  if (!OTHER_INCOME_CATEGORIES.includes(input.category as any)) {
    throw new AppError(400, 'Pick an income category for money coming in')
  }

  let unitId: string | null = null
  let propertyId: string | null = null
  let rowPropertyId: string | null = null
  let isCommon = false
  if (input.scopeKind === 'unit') {
    if (!input.unitId) throw new AppError(400, 'A unit is required for unit scope')
    const u = (await client.query<{ property_id: string; landlord_id: string }>(
      `SELECT property_id, landlord_id FROM units WHERE id = $1`, [input.unitId])).rows[0]
    if (!u || u.landlord_id !== landlordId) throw new AppError(400, 'Unit does not belong to you')
    unitId = input.unitId
    rowPropertyId = u.property_id
  } else {
    if (!input.propertyId) throw new AppError(400, 'A property is required for property scope')
    const p = (await client.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [input.propertyId])).rows[0]
    if (!p || p.landlord_id !== landlordId) throw new AppError(400, 'Property does not belong to you')
    propertyId = input.propertyId
    rowPropertyId = input.propertyId
    isCommon = true
  }

  const inc = await client.query(
    `INSERT INTO landlord_other_income
       (landlord_id, property_id, unit_id, category, amount, description, payer, income_date, is_common)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [landlordId, rowPropertyId, unitId, input.category, Math.abs(Number(txn.amount)),
     input.description ?? txn.description ?? null,
     input.vendor ?? txn.normalized_merchant ?? null, txn.posted_date_str, isCommon])
  await client.query(
    `UPDATE bank_transactions
        SET status='categorized', ignored_reason=NULL, landlord_other_income_id=$2, categorized_at=now(), updated_at=now()
      WHERE id=$1`, [txn.id, inc.rows[0].id])
  return { incomeId: inc.rows[0].id as string, propertyId, unitId }
}

/** The landlord dismisses a row. Recorded as THEIR call, so nothing automatic ever undoes it. */
export async function ignoreTransaction(landlordId: string, txnId: string) {
  const res = await queryOne<{ id: string }>(
    `UPDATE bank_transactions SET status='ignored', ignored_reason='landlord', updated_at=now()
      WHERE id=$1 AND landlord_id=$2 AND status IN ('needs_review','matched') RETURNING id`,
    [txnId, landlordId])
  if (!res) throw new AppError(404, 'Transaction not found or not ignorable')
  return { ok: true }
}

/**
 * Can GAM debit through this link? 'unknown' when Stripe could not be asked —
 * never guessed, because the answer decides whether a disconnect is allowed.
 */
async function debitCapability(conn: any): Promise<'yes' | 'no' | 'unknown'> {
  if (conn.provider !== 'stripe_fc' || !conn.stripe_fc_account_id) return 'no'
  try {
    const acct: any = await getStripe().financialConnections.accounts.retrieve(conn.stripe_fc_account_id)
    const perms: string[] = acct?.permissions ?? []
    if (acct?.status && acct.status !== 'active') return 'no'
    return perms.includes('payment_method') ? 'yes' : 'no'
  } catch (e: any) {
    if (e?.code === 'resource_missing' || e?.statusCode === 404) return 'no'
    return 'unknown'
  }
}

/**
 * Stop syncing a linked bank.
 *
 * S655 (Step 12; decisions: "the fee debit is mandatory", S652 "a bank link is
 * two-way"): GAM collects its fees from a linked bank when there is no payout
 * to net them against. So the LAST link GAM can debit from cannot be
 * disconnected — link another bank first. When the link the fee debit is drawn
 * from goes and another debit-capable one stays, the debit method is minted
 * again from the one that stays, before anything is disconnected; if that
 * fails, nothing is disconnected. A link the debit is not drawn from goes
 * without moving the debit (Step 12 review).
 */
export async function disconnectConnection(landlordId: string, connectionId: string) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Two disconnects at once must not each count the other as the bank that stays.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`bank_disconnect:${landlordId}`])
    const conn = (await client.query<any>(
      `SELECT * FROM bank_connections WHERE id = $1 AND landlord_id = $2 AND status <> 'disconnected'`,
      [connectionId, landlordId])).rows[0]
    if (!conn) throw new AppError(404, 'Connection not found')
    const can = await debitCapability(conn)
    if (can === 'unknown') {
      throw new AppError(503, 'Stripe could not be reached to check this bank link, so nothing was disconnected. Try again in a minute.')
    }
    let movedTo: { name: string; last4: string | null } | null = null
    if (can === 'yes') {
      // Step 12 review: the fee debit moves only when it is drawn from THIS
      // link. Removing a link the debit does not use leaves it where it is —
      // with three links, removing an unused one must not quietly move the
      // landlord's fee debit to a different bank account.
      const source = await debitDrawsFrom(client, landlordId, conn.stripe_fc_account_id)
      if (source === 'unknown') {
        throw new AppError(503, 'Stripe could not be reached to check which bank GAM collects its fees from, so nothing was disconnected. Try again in a minute.')
      }
      const others = (await client.query<any>(
        `SELECT * FROM bank_connections WHERE landlord_id = $1 AND id <> $2 AND status = 'active' ORDER BY created_at DESC`,
        [landlordId, connectionId])).rows
      let replacement: any = null
      for (const o of others) {
        if (await debitCapability(o) === 'yes') { replacement = o; break }
      }
      if (!replacement) {
        throw new AppError(409,
          'This is the only linked bank GAM can collect its fees from, so it can’t be disconnected. ' +
          'Link your other bank first (Connect feed), then disconnect this one.')
      }
      // Not drawn from this link (another link's, or none yet — fee collection
      // mints one from the newest link when it needs it): nothing to move.
      if (source !== 'this') {
        await client.query(
          `UPDATE bank_connections SET status='disconnected', updated_at=now() WHERE id=$1 AND landlord_id=$2`,
          [connectionId, landlordId])
        await client.query('COMMIT')
        return { ok: true, debitMovedTo: null }
      }
      const pm = await createDebitPaymentMethod(landlordId, replacement.id)
      if (!pm) {
        throw new AppError(409,
          `GAM could not set up fee collection from ${replacement.display_name || replacement.institution_name || 'your other bank'}, ` +
          'so nothing was disconnected. Link that bank once more, then try again.')
      }
      await client.query(
        `UPDATE landlords SET gam_debit_payment_method_id = $2, gam_debit_bank_last4 = $3, gam_debit_bank_name = $4,
                gam_debit_authorized_at = COALESCE(gam_debit_authorized_at, NOW()), gam_debit_revoked_at = NULL, updated_at = NOW()
          WHERE id = $1`, [landlordId, pm.paymentMethodId, pm.last4, pm.bankName])
      movedTo = { name: pm.bankName ?? replacement.institution_name ?? 'your other bank', last4: pm.last4 }
    }
    await client.query(
      `UPDATE bank_connections SET status='disconnected', updated_at=now() WHERE id=$1 AND landlord_id=$2`,
      [connectionId, landlordId])
    await client.query('COMMIT')
    return { ok: true, debitMovedTo: movedTo }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Is the landlord's fee debit (landlords.gam_debit_payment_method_id) drawn
 * from this Financial Connections account? 'this' when it is; 'elsewhere' when
 * it is drawn from another account; 'none' when there is no debit method (or
 * Stripe no longer has it); 'unknown' when Stripe could not be asked.
 */
async function debitDrawsFrom(
  client: PoolClient, landlordId: string, fcAccountId: string | null,
): Promise<'this' | 'elsewhere' | 'none' | 'unknown'> {
  const pmId = (await client.query<{ pm: string | null }>(
    `SELECT gam_debit_payment_method_id AS pm FROM landlords WHERE id = $1`, [landlordId])).rows[0]?.pm ?? null
  if (!pmId) return 'none'
  try {
    const pm: any = await getStripe().paymentMethods.retrieve(pmId)
    const fca = pm?.us_bank_account?.financial_connections_account ?? null
    if (!fca) return 'elsewhere'
    return fca === fcAccountId ? 'this' : 'elsewhere'
  } catch (e: any) {
    if (e?.code === 'resource_missing' || e?.statusCode === 404) return 'none'
    return 'unknown'
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────
export async function listConnections(landlordId: string) {
  const rows = await query<any>(
    `SELECT id, provider, institution_name, account_last4, account_type, display_name,
            status, last_synced_at, last_sync_error, created_at,
            current_balance, balance_currency, balance_as_of, stripe_fc_account_id
       FROM bank_connections
      WHERE landlord_id = $1 AND status <> 'disconnected'
      ORDER BY created_at DESC`, [landlordId])
  // S652 (Nic): every linked bank says whether GAM can debit from it, and why not.
  const stripe = getStripe()
  for (const r of rows) {
    r.debit_ready = false; r.debit_problem = null
    if (!r.stripe_fc_account_id) { r.debit_problem = 'This link has no Stripe account behind it — link it again.'; continue }
    try {
      const acct: any = await stripe.financialConnections.accounts.retrieve(r.stripe_fc_account_id)
      const perms: string[] = acct?.permissions ?? []
      if (acct?.status && acct.status !== 'active') r.debit_problem = `This link is ${acct.status} at the bank — link it again.`
      else if (!perms.includes('payment_method')) r.debit_problem = 'Linked before GAM asked for permission to debit — link this account once more.'
      else r.debit_ready = true
    } catch (e: any) { r.debit_problem = `Stripe could not read this link: ${e?.message ?? e}` }
    delete r.stripe_fc_account_id
  }
  return rows
}

/**
 * List transactions with each row's auto-suggestion attached (so the review queue
 * can pre-fill without an N+1 from the client). Defaults to the review queue.
 */
export async function listTransactions(landlordId: string, opts: { status?: string; connectionId?: string; limit?: number } = {}) {
  // S655: a copy from an earlier link, or a transaction the bank voided, is kept
  // on file but never listed — it is not money that moved.
  const conds = ['bt.landlord_id = $1', `NOT (COALESCE(bt.ignored_reason, '') = ANY($2::text[]))`]
  const params: any[] = [landlordId, [...BANK_TXN_HIDDEN_REASONS]]
  if (opts.status) { params.push(opts.status); conds.push(`bt.status = $${params.length}`) }
  if (opts.connectionId) { params.push(opts.connectionId); conds.push(`bt.bank_connection_id = $${params.length}`) }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
  const rows = await query<any>(
    `SELECT bt.id, bt.amount::float AS amount, bt.posted_date, bt.description,
            bt.normalized_merchant, bt.status, bt.currency,
            -- S655: why it is ignored, and what the bank says about it
            bt.ignored_reason, bt.bank_status,
            c.display_name AS connection_name,
            r.category AS suggested_category, r.scope_kind AS suggested_scope_kind,
            r.property_id AS suggested_property_id, r.unit_id AS suggested_unit_id,
            -- S655: what a matched row was matched TO. The page called every
            -- matched row a GAM payout, including a tenant's own cash deposit.
            -- S655 (Step 12): a bank deposit slip, and a deposit that filed
            -- itself as income (categorized, not matched — but labeled).
            CASE WHEN bt.auto_filed_rule_id IS NOT NULL AND bt.status = 'categorized' THEN 'auto_filed'
                 WHEN bt.status <> 'matched' THEN NULL
                 WHEN bt.matched_disbursement_id IS NOT NULL THEN 'gam_payout'
                 WHEN bt.matched_payment_id IS NOT NULL THEN 'tenant_deposit'
                 WHEN bt.auto_settle_undo->>'kind' = 'deposit_slip' THEN 'deposit_slip'
            END AS match_kind,
            bt.matched_disbursement_id,
            -- Settled by itself on amount; and whether Undo can be offered.
            bt.auto_settled_at, bt.auto_filed_at,
            (bt.status = 'matched' AND bt.matched_disbursement_id IS NULL
              AND ((bt.auto_settle_undo ? 'receiptId') OR bt.auto_settle_undo->>'kind' = 'deposit_slip')) AS can_undo,
            slip.slip_deposit_date, slip.slip_item_count, slip.slip_other_amount, slip.slip_source,
            dep.unit_number AS matched_unit_number, dep.tenant_name AS matched_tenant_name,
            dep.charge_count AS matched_charge_count
       FROM bank_transactions bt
       JOIN bank_connections c ON c.id = bt.bank_connection_id
       LEFT JOIN landlord_merchant_rules r
              ON r.landlord_id = bt.landlord_id AND r.normalized_merchant = bt.normalized_merchant
       LEFT JOIN LATERAL (
         SELECT u.unit_number,
                (SELECT us.first_name || ' ' || us.last_name FROM tenants t JOIN users us ON us.id = t.user_id
                  WHERE t.id = p.tenant_id) AS tenant_name,
                (SELECT COUNT(*)::int FROM bank_deposit_allocations a WHERE a.bank_transaction_id = bt.id) AS charge_count
           FROM payments p LEFT JOIN units u ON u.id = p.unit_id
          WHERE p.id = bt.matched_payment_id
       ) dep ON bt.matched_payment_id IS NOT NULL
       LEFT JOIN LATERAL (
         SELECT to_char(s.deposit_date, 'YYYY-MM-DD') AS slip_deposit_date, s.source AS slip_source,
                s.other_amount::float AS slip_other_amount,
                (SELECT COUNT(*)::int FROM bank_deposit_slip_items i WHERE i.slip_id = s.id AND i.voided_at IS NULL) AS slip_item_count
           FROM bank_deposit_slips s
          WHERE s.bank_transaction_id = bt.id AND s.status = 'matched'
          LIMIT 1
       ) slip ON bt.status = 'matched'
      WHERE ${conds.join(' AND ')}
      ORDER BY bt.posted_date DESC, bt.created_at DESC
      LIMIT ${limit}`, params)

  // S655 (Nic): a GAM payout row says what it carried — every payment inside
  // it. One batch for every payout on the page.
  const payoutIds = rows.filter((r: any) => r.match_kind === 'gam_payout').map((r: any) => r.matched_disbursement_id)
  if (payoutIds.length) {
    const comps = await payoutCompositions(payoutIds)
    for (const r of rows) {
      if (r.match_kind === 'gam_payout') r.payout_breakdown = comps.get(r.matched_disbursement_id) ?? null
    }
  }
  return rows
}

/**
 * S605: sync every active connection. Stripe backfills a newly linked account
 * asynchronously, so the sync fired at link time usually returns nothing and
 * reports "refresh is still pending". Without a retry the landlord would have
 * to keep pressing Sync by hand until Stripe caught up. Runs hourly.
 *
 * Per-connection failures are swallowed: one landlord's revoked bank must never
 * stop everyone else's sync.
 */
export async function syncAllActiveConnections(): Promise<{ synced: number; inserted: number; failed: number }> {
  const conns = await query<{ id: string }>(
    `SELECT id FROM bank_connections WHERE status = 'active'`)
  let inserted = 0, failed = 0, synced = 0
  for (const c of conns) {
    try {
      const r = await syncConnection(c.id)
      inserted += r.inserted
      synced++
    } catch {
      failed++
    }
  }
  return { synced, inserted, failed }
}

/**
 * S642 (Nic): refresh every linked account's cached balance — once a day, on
 * banking days only.
 *
 *   "Change it to once a day and only Monday through Friday excluding banking
 *    holidays. There's no reason their real bank would even update on banking
 *    holidays or weekends, so let's match that."
 *
 * Each call is billable. This used to ride along with the transaction sync four
 * times a day, which cost $9.30 in August on ONE account while the transaction
 * feed itself — the thing the feature exists for — cost $0.30. Four times a day,
 * every day, to re-read a number that a bank only moves on business days.
 *
 * 4×/day × 365 = 1,460 calls a year per account. Once a day on ~251 banking
 * days = 251. A 83% cut, and nothing a landlord can perceive: the balance was
 * never fresher than the bank's own posting schedule.
 *
 * The caller decides it is a banking day (see scheduler) so this stays a plain
 * "do it now" the admin can also trigger by hand.
 */
export async function refreshAllBalances(): Promise<{ refreshed: number; failed: number }> {
  const conns = await query<any>(
    `SELECT * FROM bank_connections WHERE status = 'active'`)
  let refreshed = 0, failed = 0
  for (const c of conns) {
    try { await refreshBalance(c); refreshed++ } catch { failed++ }
  }
  return { refreshed, failed }
}

/**
 * S605: set the landlord's books start date and apply it to what's already
 * imported.
 *
 * Setting the date has to be retroactive or it's useless — Oak Park had already
 * pulled 112 rows back to February before this existed. Moving the date is
 * therefore two-way and non-destructive:
 *   • rows before the cutoff that are still awaiting review  → ignored
 *   • rows on/after the cutoff that were hidden by a PREVIOUS, later cutoff
 *     → returned to needs_review
 *
 * Rows the landlord already CATEGORIZED are never touched. Those are real
 * expenses in their P&L; silently un-booking them because a date moved would
 * change their financials behind their back.
 *
 * S655: and it moves ONLY rows it hid itself (ignored_reason = before_books).
 * It used to bring back every ignored row on/after the date — a row the
 * landlord dismissed, a copy from an earlier link to the same bank, a charge the
 * bank voided — because a bare `ignored` could not say which was which. Re-saving
 * Oak Park's date would have put 35 hidden PNC copies straight back in review.
 *
 * Pass `outer` to run inside the caller's transaction (a one-time script's dry
 * run); otherwise it runs in its own.
 */
export async function setBooksStartDate(
  landlordId: string,
  date: string | null,
  outer?: PoolClient,
): Promise<{ ignored: number; restored: number }> {
  const client = outer ?? await getClient()
  try {
    if (!outer) await client.query('BEGIN')
    await client.query('UPDATE landlords SET books_start_date = $2 WHERE id = $1', [landlordId, date])
    // Lock what may move in id order — the order a bank sync locks in — so a
    // save that lands mid-sync waits for it instead of deadlocking with it.
    await client.query(
      `SELECT id FROM bank_transactions
        WHERE landlord_id = $1 AND (status = 'needs_review' OR (status = 'ignored' AND ignored_reason = 'before_books'))
        ORDER BY id FOR UPDATE`, [landlordId])

    const ignored = date
      ? (await client.query(
          `UPDATE bank_transactions SET status = 'ignored', ignored_reason = 'before_books', updated_at = now()
            WHERE landlord_id = $1 AND posted_date < $2::date AND status = 'needs_review'
            RETURNING id`, [landlordId, date])).rowCount ?? 0
      : 0

    // Cleared: everything the date hid comes back. Moved: what is now on or
    // after it comes back.
    const restored = (await client.query(
      `UPDATE bank_transactions SET status = 'needs_review', ignored_reason = NULL, updated_at = now()
        WHERE landlord_id = $1 AND status = 'ignored' AND ignored_reason = 'before_books'
          AND ($2::date IS NULL OR posted_date >= $2::date)
        RETURNING id`, [landlordId, date])).rowCount ?? 0

    if (!outer) await client.query('COMMIT')
    return { ignored, restored }
  } catch (e) {
    if (!outer) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (!outer) client.release()
  }
}

/**
 * Mint the us_bank_account PaymentMethod GAM would debit, from a bank the
 * landlord already linked for the feed.
 *
 * Separate from linking on purpose. Linking is "you may read this account";
 * this is called only at the moment a landlord authorizes a debit, so the
 * payment method does not exist on any account that never said yes.
 *
 * Returns null when the link predates the payment_method permission — the
 * caller turns that into "re-link your bank", not into a silent failure.
 */
/**
 * S652 (Nic): say WHY a linked bank cannot be debited. A feed link made before
 * the session asked for the payment_method permission (Oak Park's PNC, August
 * 17) can show balances and transactions and still not be pulled from — the
 * bank has to be linked once more so the new permission is granted.
 */
export async function debitLinkProblem(landlordId: string): Promise<string> {
  const conn = await queryOne<any>(
    `SELECT * FROM bank_connections WHERE landlord_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [landlordId])
  if (!conn) return 'No bank is linked under Settings → Bank feed.'
  if (!conn.stripe_fc_account_id) return `The ${conn.institution_name ?? 'bank'} link has no Stripe account behind it — link it again.`
  try {
    const acct: any = await getStripe().financialConnections.accounts.retrieve(conn.stripe_fc_account_id)
    const perms: string[] = acct?.permissions ?? []
    if (!perms.includes('payment_method')) {
      return `The ${conn.institution_name ?? 'bank'} ****${conn.account_last4 ?? ''} link was made without permission to debit. Link the same account once more under Settings → Bank feed; the new link asks for it.`
    }
    if (acct?.status && acct.status !== 'active') return `The ${conn.institution_name ?? 'bank'} link is ${acct.status} at the bank — link it again.`
    return 'Stripe refused to make a debit method from this link.'
  } catch (e: any) {
    return `Stripe could not read the ${conn.institution_name ?? 'bank'} link: ${e?.message ?? e}`
  }
}

export async function createDebitPaymentMethod(
  landlordId: string,
  bankConnectionId?: string,
): Promise<{ paymentMethodId: string; last4: string | null; bankName: string | null } | null> {
  const conn = await queryOne<any>(
    bankConnectionId
      ? `SELECT * FROM bank_connections WHERE id = $2 AND landlord_id = $1 AND status = 'active'`
      : `SELECT * FROM bank_connections WHERE landlord_id = $1 AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
    bankConnectionId ? [landlordId, bankConnectionId] : [landlordId])
  if (!conn?.stripe_fc_account_id) return null

  const stripe = getStripe()
  const customer = await getOrCreateFcCustomer(landlordId)
  // S652 (Nic): the Oak Park pull failed with "no usable bank link" while PNC
  // was linked and active. Stripe refuses a bank payment method without a
  // billing name — the error was swallowed as "no link". The company's name
  // and its owner's email are the billing details.
  const who = await queryOne<{ name: string | null; email: string | null }>(
    `SELECT COALESCE(NULLIF(la.business_name, ''), u.first_name || ' ' || u.last_name) AS name, u.email
       FROM landlords la JOIN users u ON u.id = la.user_id WHERE la.id = $1`, [landlordId])
  try {
    const pm = await stripe.paymentMethods.create({
      type: 'us_bank_account',
      us_bank_account: { financial_connections_account: conn.stripe_fc_account_id },
      billing_details: { name: who?.name || 'GAM landlord', email: who?.email || undefined },
    } as any)
    await stripe.paymentMethods.attach(pm.id, { customer })
    return {
      paymentMethodId: pm.id,
      last4: (pm as any).us_bank_account?.last4 ?? conn.account_last4 ?? null,
      bankName: (pm as any).us_bank_account?.bank_name ?? conn.institution_name ?? null,
    }
  } catch (e: any) {
    // The common case by far: a link made before payment_method was requested.
    if (/permission|financial_connections/i.test(e?.message ?? '')) return null
    throw e
  }
}
