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
//   * Only OUTFLOWS (amount < 0) are categorizable as expenses. Inbound money is
//     auto-matched to disbursements or left for the landlord to ignore.
//   * Provider-agnostic: Stripe FC today; a CSV import path can add rows to the
//     same `bank_transactions` table later.
//
// Stripe is used only at the lib/stripe boundary so tests can mock it; every
// pure-DB function below (sync-from-rows, auto-match, categorize, suggest) runs
// without touching Stripe.
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { createLandlordExpense } from './landlordExpenses'
import type { MerchantRuleScope } from '@gam/shared'

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
  const session = await stripe.financialConnections.sessions.create({
    account_holder: { type: 'customer', customer },
    permissions: ['transactions'],
    prefetch: ['transactions'],
  })
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
  let inserted = 0
  for (const r of rows) {
    const res = await queryOne<{ id: string }>(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount, currency,
          description, normalized_merchant)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (bank_connection_id, external_id) DO NOTHING
       RETURNING id`,
      [connectionId, landlordId, r.externalId, r.postedDate, round2(r.amount).toFixed(2),
       r.currency ?? 'usd', r.description ?? null, normalizeMerchant(r.description)])
    if (res?.id) inserted++
  }
  await autoMatchLandlord(landlordId)
  return inserted
}

/** Pull transactions from Stripe FC for one connection and upsert them. */
export async function syncConnection(connectionId: string): Promise<{ inserted: number }> {
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
    await query('UPDATE bank_connections SET last_sync_error=$2, status=$3 WHERE id=$1',
      [connectionId, String(e?.message ?? e).slice(0, 500), 'error'])
    throw new AppError(502, 'Could not sync transactions from the bank')
  }
  const inserted = await upsertTransactions(connectionId, conn.landlord_id, rows)
  return { inserted }
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
}) {
  const txn = await queryOne<any>(
    `SELECT *, to_char(posted_date, 'YYYY-MM-DD') AS posted_date_str
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [txnId, landlordId])
  if (!txn) throw new AppError(404, 'Transaction not found')
  if (txn.status === 'categorized') throw new AppError(409, 'Transaction already categorized')
  if (Number(txn.amount) >= 0) throw new AppError(400, 'Only money-out transactions can be categorized as expenses')

  // Scope → expense shape.
  let unitId: string | null = null
  let propertyId: string | null = null
  let isCommon = false
  let allocatePerUnit = false
  if (input.scopeKind === 'unit') {
    if (!input.unitId) throw new AppError(400, 'A unit is required for unit scope')
    unitId = input.unitId
  } else {
    if (!input.propertyId) throw new AppError(400, 'A property is required for property scope')
    propertyId = input.propertyId
    isCommon = true
    allocatePerUnit = input.scopeKind === 'property_allocate'
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
      allocatePerUnit,
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
            status, last_synced_at, last_sync_error, created_at
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
