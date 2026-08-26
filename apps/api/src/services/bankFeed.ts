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
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { createLandlordExpense } from './landlordExpenses'
import type { MerchantRuleScope } from '@gam/shared'
import { OTHER_INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@gam/shared'

const round2 = (n: number) => Math.round(n * 100) / 100

// Auto-match tolerance: a settled disbursement counts as the source of an inbound
// bank deposit if the amounts match to the cent and the posted date is within this
// many days of the disbursement settling (ACH lands a few business days out).
const MATCH_DATE_WINDOW_DAYS = 6

/**
 * Normalize a raw bank memo into a stable merchant key. Uppercase, strip store
 * numbers / dates / punctuation / trailing location noise, collapse whitespace.
 * "HOME DEPOT #1234 PHOENIX AZ 07/12" → "HOME DEPOT".
 */
export function normalizeMerchant(description: string | null | undefined): string {
  if (!description) return ''
  let s = String(description).toUpperCase()
  s = s.replace(/\b(DEBIT|CREDIT|CARD|PURCHASE|POS|ACH|PMT|PAYMENT|WWW\.?|HTTP\S*)\b/g, ' ')
  s = s.replace(/#\s*\d+/g, ' ')            // store numbers
  s = s.replace(/\d{2}[\/-]\d{2}([\/-]\d{2,4})?/g, ' ') // dates
  s = s.replace(/\b\d{3,}\b/g, ' ')          // long digit runs (ref/txn ids)
  s = s.replace(/[^A-Z0-9&' ]+/g, ' ')       // punctuation
  s = s.replace(/\s+/g, ' ').trim()
  // Keep it to the leading, most-recognizable token(s).
  const words = s.split(' ').filter(Boolean).slice(0, 4)
  return words.join(' ')
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
      permissions: ['transactions', 'balances'],
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
    try { await syncConnection(conn.id) } catch { /* initial sync best-effort */ }
  }
  return out
}

// ── Sync ────────────────────────────────────────────────────────────────────
/**
 * Upsert a batch of normalized transactions for a connection (idempotent on
 * external_id) and auto-match new rows. Shared by the Stripe pull and any future
 * CSV import — pure DB, no Stripe. Returns how many were newly inserted.
 */
export async function upsertTransactions(
  connectionId: string,
  landlordId: string,
  rows: Array<{ externalId: string; postedDate: string; amount: number; currency?: string; description?: string | null }>,
): Promise<number> {
  // S605: anything before the landlord's books start date is still stored, but
  // lands as `ignored` so pre-GAM history never clutters the review queue.
  const [ll] = await query<{ books_start_date: string | null }>(
    `SELECT books_start_date FROM landlords WHERE id = $1`, [landlordId])
  const cutoff = ll?.books_start_date ?? null

  // S605: re-linking the SAME bank is now an expected action — granting balances
  // consent requires it — and Stripe issues a fresh account id each time, so the
  // (bank_connection_id, external_id) key sees the new rows as new. Left alone,
  // Oak Park's history would import a second time and every figure in the P&L
  // would double.
  //
  // So when a sibling connection exists for the same physical account (same
  // landlord, same institution, same last4), treat a same-day / same-amount /
  // same-description row as already-imported. Deliberately conservative: it only
  // engages for the re-link case, and a genuine duplicate charge — same merchant,
  // same amount, same day, same account — is rare enough that silently importing
  // it twice is the worse error.
  const siblings = await query<{ posted_date: string; amount: string; description: string | null }>(
    `SELECT t.posted_date, t.amount, t.description
       FROM bank_transactions t
       JOIN bank_connections c ON c.id = t.bank_connection_id
      WHERE t.landlord_id = $1
        AND t.bank_connection_id <> $2
        AND c.account_last4 IS NOT DISTINCT FROM (SELECT account_last4 FROM bank_connections WHERE id = $2)
        AND c.institution_name IS NOT DISTINCT FROM (SELECT institution_name FROM bank_connections WHERE id = $2)`,
    [landlordId, connectionId])
  const seen = new Set(siblings.map((s) =>
    `${String(s.posted_date).slice(0, 10)}|${Number(s.amount).toFixed(2)}|${s.description ?? ''}`))

  let inserted = 0
  let skippedDuplicate = 0
  for (const r of rows) {
    if (seen.size && seen.has(`${r.postedDate}|${round2(r.amount).toFixed(2)}|${r.description ?? ''}`)) {
      skippedDuplicate++
      continue
    }
    const beforeCutoff = cutoff != null && r.postedDate < cutoff
    const res = await queryOne<{ id: string }>(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount, currency,
          description, normalized_merchant, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (bank_connection_id, external_id) DO NOTHING
       RETURNING id`,
      [connectionId, landlordId, r.externalId, r.postedDate, round2(r.amount).toFixed(2),
       r.currency ?? 'usd', r.description ?? null, normalizeMerchant(r.description),
       beforeCutoff ? 'ignored' : 'needs_review'])
    if (res?.id) inserted++
  }
  await autoMatchLandlord(landlordId)
  // S624: and settle any deposit a tenant declared that the bank now confirms.
  await autoSettleDeclaredDeposits(landlordId)
  if (skippedDuplicate) {
    console.log(`[bankFeed] connection ${connectionId}: skipped ${skippedDuplicate} row(s) already imported via a prior link to the same account`)
  }
  return inserted
}

/** Pull transactions from Stripe FC for one connection and upsert them. */
export async function syncConnection(connectionId: string): Promise<{ inserted: number; pending?: boolean }> {
  const conn = await queryOne<any>('SELECT * FROM bank_connections WHERE id = $1', [connectionId])
  if (!conn) throw new AppError(404, 'Connection not found')
  if (conn.provider !== 'stripe_fc' || !conn.stripe_fc_account_id) {
    return { inserted: 0 } // CSV connections are populated via import, not sync.
  }
  const stripe = getStripe()
  const rows: Array<{ externalId: string; postedDate: string; amount: number; currency?: string; description?: string | null }> = []
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
  await refreshBalance(conn).catch(() => { /* see refreshBalance: never fails a sync */ })
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

  let acct: any
  try {
    acct = await stripe.financialConnections.accounts.refresh(conn.stripe_fc_account_id, {
      features: ['balance'],
    })
  } catch {
    // Refresh is a nicety — an account Stripe already has a balance for still
    // reports it on a plain retrieve, so fall back rather than giving up.
    acct = await stripe.financialConnections.accounts.retrieve(conn.stripe_fc_account_id)
  }

  const bal = acct?.balance
  if (!bal) return
  // Both shapes are currency-keyed maps of minor units.
  const pick = bal.cash?.available ?? bal.current ?? null
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
 */
export async function autoMatchLandlord(landlordId: string): Promise<number> {
  const candidates = await query<any>(
    `SELECT id, amount, posted_date FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0`, [landlordId])
  let matched = 0
  for (const t of candidates) {
    const disb = await queryOne<{ id: string }>(
      `SELECT d.id FROM disbursements d
        WHERE d.landlord_id = $1 AND d.status = 'settled'
          AND d.amount = $2
          AND d.settled_at IS NOT NULL
          AND ABS(d.settled_at::date - $3::date) <= $4
          AND NOT EXISTS (SELECT 1 FROM bank_transactions bt
                           WHERE bt.matched_disbursement_id = d.id)
        ORDER BY ABS(d.settled_at::date - $3::date) ASC
        LIMIT 1`,
      [landlordId, Number(t.amount).toFixed(2), t.posted_date, MATCH_DATE_WINDOW_DAYS])
    if (disb?.id) {
      await query(
        `UPDATE bank_transactions SET status='matched', matched_disbursement_id=$2, updated_at=now() WHERE id=$1`,
        [t.id, disb.id])
      matched++
    }
  }
  return matched
}

/**
 * S624 — auto-settle a deposit the TENANT declared and the BANK confirms.
 *
 * The only case that settles with nobody in the loop, and it is safe for a
 * specific reason: it takes TWO INDEPENDENT SIGNALS that had to agree, neither
 * of them the landlord's guess. The tenant said they deposited $X on a date; a
 * bank row for exactly $X posted within the window; and the instrument they
 * named does not contradict what the memo describes. Amount alone never
 * qualifies — in a park where every lot pays the same rent an amount identifies
 * nobody, and a confident wrong answer books one tenant's money onto another's
 * ledger and then onto their credit file.
 *
 * This overrides the S570 design lock ("landlord ALWAYS confirms") for TENANT
 * PAYMENTS ONLY, on Nic's S624 decision. Expense categorization keeps the lock:
 * there is no second signal there, only a merchant name.
 *
 * Never throws. A deposit that cannot be auto-settled simply stays in the review
 * queue with its shortlist, which is exactly where it would have been anyway.
 */
export async function autoSettleDeclaredDeposits(landlordId: string): Promise<number> {
  const { candidatesForDeposit } = await import('./bankDepositCandidates')
  const { confirmDepositMatch } = await import('./bankDepositConfirm')
  const { isPreselectable } = await import('./bankDepositMatch')

  const rows = await query<any>(
    `SELECT id, landlord_id, amount::float AS amount,
            to_char(posted_date,'YYYY-MM-DD') AS posted_date, description
       FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0`,
    [landlordId])

  let settled = 0
  for (const txn of rows) {
    try {
      const { candidates } = await candidatesForDeposit(txn)
      const top = candidates[0]
      // 'declared' is the only confidence that auto-settles. `isPreselectable`
      // also admits a unique amount match and a named check — good enough to
      // PRE-TICK for a landlord who is looking at it, not good enough to move
      // money unattended.
      if (!top || top.confidence !== 'declared' || !isPreselectable(top)) continue
      if (top.chargeIds.length === 0) continue

      const decl = await queryOne<{ id: string; method: string }>(
        `SELECT id, method FROM tenant_declared_deposits
          WHERE lease_id = $1 AND status = 'pending' AND amount = $2
          ORDER BY declared_date DESC LIMIT 1`,
        [top.leaseId, Number(txn.amount).toFixed(2)])
      if (!decl) continue

      await confirmDepositMatch({
        bankTransactionId: txn.id,
        chargeIds: top.chargeIds,
        method: decl.method as any,
        declarationId: decl.id,
        confirmedByUserId: null,
      })
      settled++
    } catch (e) {
      // One bad deposit must not stop the rest, and must not fail a bank sync.
      logger.warn({ err: e, transaction_id: txn.id },
        '[bank-feed] auto-settle skipped')
    }
  }
  return settled
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

async function rememberMerchantChoice(landlordId: string, normalizedMerchant: string, input: {
  category: string; scopeKind: MerchantRuleScope; propertyId: string | null; unitId: string | null
}) {
  if (!normalizedMerchant) return
  await query(
    `INSERT INTO landlord_merchant_rules
       (landlord_id, normalized_merchant, category, scope_kind, property_id, unit_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (landlord_id, normalized_merchant) DO UPDATE
       SET category=EXCLUDED.category, scope_kind=EXCLUDED.scope_kind,
           property_id=EXCLUDED.property_id, unit_id=EXCLUDED.unit_id,
           hit_count=landlord_merchant_rules.hit_count + 1,
           last_used_at=now(), updated_at=now()`,
    [landlordId, normalizedMerchant, input.category, input.scopeKind, input.propertyId, input.unitId])
}

// ── Categorize (2-click → expense) ──────────────────────────────────────────
/**
 * Turn an outflow transaction into a landlord_expenses row. Landlord-confirmed;
 * scope is required. Remembers the merchant choice for next time. Transactional:
 * the expense insert + the txn flip happen together.
 */
export async function categorizeTransaction(landlordId: string, txnId: string, input: {
  category: string
  scopeKind: MerchantRuleScope
  unitId?: string | null
  propertyId?: string | null
  vendor?: string | null
  description?: string | null
}): Promise<{ expenseId?: string; incomeId?: string }> {
  const txn = await queryOne<any>(
    `SELECT *, to_char(posted_date, 'YYYY-MM-DD') AS posted_date_str
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [txnId, landlordId])
  if (!txn) throw new AppError(404, 'Transaction not found')
  if (txn.status === 'categorized') throw new AppError(409, 'Transaction already categorized')

  // S605: money IN is now categorizable as income rather than only ignorable.
  // The branch is on the sign of the amount, not on a caller-supplied flag, so
  // there's no way to file a deposit as an expense or a payment as income.
  if (Number(txn.amount) > 0) {
    return categorizeAsIncome(landlordId, txn, input)
  }
  if (Number(txn.amount) === 0) throw new AppError(400, 'This transaction has no amount to categorize')
  // Symmetric to the income check below: the route accepts both category sets,
  // so the expense branch must refuse an income category outright.
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

  const client = await getClient()
  try {
    await client.query('BEGIN')
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
    })
    await client.query(
      `UPDATE bank_transactions
          SET status='categorized', expense_id=$2, categorized_at=now(), updated_at=now()
        WHERE id=$1`, [txnId, expense.id])
    await client.query('COMMIT')
    // Remember the merchant choice (outside the txn — a best-effort learning write).
    await rememberMerchantChoice(landlordId, txn.normalized_merchant, {
      category: input.category, scopeKind: input.scopeKind, propertyId, unitId,
    })
    return { expenseId: expense.id }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * S605: record a money-in bank row as landlord income.
 *
 * The guard that matters is the `matched` check. Auto-matching ties inbound rows
 * to the GAM disbursement that produced them; those already reach the P&L via
 * `payments`, so letting one be filed here too would count the same rent twice
 * and overstate the landlord's income. Only unmatched deposits — money GAM never
 * moved — are eligible.
 */
async function categorizeAsIncome(landlordId: string, txn: any, input: {
  category: string
  scopeKind: MerchantRuleScope
  unitId?: string | null
  propertyId?: string | null
  vendor?: string | null
  description?: string | null
}) {
  if (txn.status === 'matched' || txn.disbursement_id) {
    throw new AppError(409,
      'This deposit is money GAM already sent you, so it’s counted in your income ' +
      'automatically. Recording it again would double it.')
  }
  if (!OTHER_INCOME_CATEGORIES.includes(input.category as any)) {
    throw new AppError(400, 'Pick an income category for money coming in')
  }

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
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const inc = await client.query(
      `INSERT INTO landlord_other_income
         (landlord_id, property_id, unit_id, category, amount, description, payer, income_date, is_common)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [landlordId, propertyId, unitId, input.category, Math.abs(Number(txn.amount)),
       input.description ?? txn.description ?? null,
       input.vendor ?? txn.normalized_merchant ?? null, txn.posted_date_str, isCommon])
    await client.query(
      `UPDATE bank_transactions
          SET status='categorized', landlord_other_income_id=$2, categorized_at=now(), updated_at=now()
        WHERE id=$1`, [txn.id, inc.rows[0].id])
    await client.query('COMMIT')
    await rememberMerchantChoice(landlordId, txn.normalized_merchant, {
      category: input.category, scopeKind: input.scopeKind, propertyId, unitId,
    })
    return { incomeId: inc.rows[0].id }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function ignoreTransaction(landlordId: string, txnId: string) {
  const res = await queryOne<{ id: string }>(
    `UPDATE bank_transactions SET status='ignored', updated_at=now()
      WHERE id=$1 AND landlord_id=$2 AND status IN ('needs_review','matched') RETURNING id`,
    [txnId, landlordId])
  if (!res) throw new AppError(404, 'Transaction not found or not ignorable')
  return { ok: true }
}

export async function disconnectConnection(landlordId: string, connectionId: string) {
  const res = await queryOne<{ id: string }>(
    `UPDATE bank_connections SET status='disconnected', updated_at=now()
      WHERE id=$1 AND landlord_id=$2 RETURNING id`, [connectionId, landlordId])
  if (!res) throw new AppError(404, 'Connection not found')
  return { ok: true }
}

// ── Reads ───────────────────────────────────────────────────────────────────
export async function listConnections(landlordId: string) {
  return query<any>(
    `SELECT id, provider, institution_name, account_last4, account_type, display_name,
            status, last_synced_at, last_sync_error, created_at,
            current_balance, balance_currency, balance_as_of
       FROM bank_connections
      WHERE landlord_id = $1 AND status <> 'disconnected'
      ORDER BY created_at DESC`, [landlordId])
}

/**
 * List transactions with each row's auto-suggestion attached (so the review queue
 * can pre-fill without an N+1 from the client). Defaults to the review queue.
 */
export async function listTransactions(landlordId: string, opts: { status?: string; connectionId?: string; limit?: number } = {}) {
  const conds = ['bt.landlord_id = $1']
  const params: any[] = [landlordId]
  if (opts.status) { params.push(opts.status); conds.push(`bt.status = $${params.length}`) }
  if (opts.connectionId) { params.push(opts.connectionId); conds.push(`bt.bank_connection_id = $${params.length}`) }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
  const rows = await query<any>(
    `SELECT bt.id, bt.amount::float AS amount, bt.posted_date, bt.description,
            bt.normalized_merchant, bt.status, bt.currency,
            c.display_name AS connection_name,
            r.category AS suggested_category, r.scope_kind AS suggested_scope_kind,
            r.property_id AS suggested_property_id, r.unit_id AS suggested_unit_id
       FROM bank_transactions bt
       JOIN bank_connections c ON c.id = bt.bank_connection_id
       LEFT JOIN landlord_merchant_rules r
              ON r.landlord_id = bt.landlord_id AND r.normalized_merchant = bt.normalized_merchant
      WHERE ${conds.join(' AND ')}
      ORDER BY bt.posted_date DESC, bt.created_at DESC
      LIMIT ${limit}`, params)
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
 * S605: set the landlord's books start date and apply it to what's already
 * imported.
 *
 * Setting the date has to be retroactive or it's useless — Oak Park had already
 * pulled 112 rows back to February before this existed. Moving the date is
 * therefore two-way and non-destructive:
 *   • rows before the cutoff that are still awaiting review  → ignored
 *   • rows on/after the cutoff that were auto-ignored by a PREVIOUS, later
 *     cutoff → returned to needs_review
 *
 * Rows the landlord already CATEGORIZED are never touched. Those are real
 * expenses in their P&L; silently un-booking them because a date moved would
 * change their financials behind their back.
 */
export async function setBooksStartDate(
  landlordId: string,
  date: string | null,
): Promise<{ ignored: number; restored: number }> {
  await query('UPDATE landlords SET books_start_date = $2 WHERE id = $1', [landlordId, date])

  if (!date) {
    // Cleared: bring auto-ignored rows back for review. Categorized stays.
    const restored = await query<{ id: string }>(
      `UPDATE bank_transactions SET status = 'needs_review'
        WHERE landlord_id = $1 AND status = 'ignored' RETURNING id`, [landlordId])
    return { ignored: 0, restored: restored.length }
  }

  const ignored = await query<{ id: string }>(
    `UPDATE bank_transactions SET status = 'ignored'
      WHERE landlord_id = $1 AND posted_date < $2::date AND status = 'needs_review'
      RETURNING id`, [landlordId, date])

  const restored = await query<{ id: string }>(
    `UPDATE bank_transactions SET status = 'needs_review'
      WHERE landlord_id = $1 AND posted_date >= $2::date AND status = 'ignored'
      RETURNING id`, [landlordId, date])

  return { ignored: ignored.length, restored: restored.length }
}
