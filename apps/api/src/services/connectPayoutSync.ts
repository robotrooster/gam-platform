/**
 * S652 — EVERY PAYOUT A CONNECT ACCOUNT MADE, PULLED FROM STRIPE INTO GAM.
 *
 * Nic, on the dashboard: "why is there a discrepancy between what I pushed
 * through the Stripe dashboard and what's actually there on the display?"
 * Because a payout made in Stripe never reached GAM: the connected-account
 * webhook has never delivered a payout event (connect_payouts had zero rows),
 * and only GAM-initiated payouts were written to `disbursements`. So the
 * $4,154.89 he paid out himself was invisible, while the $413 the weekly run
 * paid the same evening showed with no bank and no company on it.
 *
 * This asks Stripe directly. For every Connect account GAM knows (landlords,
 * the users that hold one), list the recent payouts and make sure each one is
 * a row in `disbursements` — created as 'stripe_dashboard' when GAM did not
 * initiate it, otherwise updated in place — with the bank it went to (name and
 * last four, from Stripe's own record) and its status. Runs after each payout
 * run and nightly; safe to run any time. The Connect webhook files the same
 * row the moment Stripe reports a payout (see stripeConnect.recordPayoutEvent),
 * so the page updates in seconds and this is the net under it.
 */
import { query, queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'

export type PayoutLister = {
  payouts: { list: (params: any, opts: any) => Promise<{ data: any[] }> }
  accounts: { retrieveExternalAccount: (acct: string, id: string) => Promise<any> }
}

const dispStatus = (s: string) =>
  s === 'paid' ? 'settled' : (s === 'failed' || s === 'canceled') ? 'failed' : 'processing'

export type PayoutOwner = { account: string; user_id: string; landlord_id: string | null }

/**
 * One payout → one `disbursements` row. Updates the row GAM wrote when it
 * initiated the payout (status, settled date, bank, company); inserts a
 * 'stripe_dashboard' row when the landlord made the payout in Stripe
 * themselves. Called from the nightly/after-run sync AND from the Connect
 * webhook the moment Stripe reports the payout — same row either way.
 */
export async function fileConnectPayout(
  stripe: PayoutLister, owner: PayoutOwner, p: any,
  banks: Map<string, { name: string | null; last4: string | null }> = new Map(),
): Promise<'created' | 'updated'> {
  const dest = typeof p.destination === 'string' ? p.destination : p.destination?.id ?? null
  let bank = dest ? banks.get(dest) : undefined
  if (dest && !bank) {
    try {
      const ext = await stripe.accounts.retrieveExternalAccount(owner.account, dest)
      bank = { name: ext?.bank_name ?? null, last4: ext?.last4 ?? null }
    } catch { bank = { name: null, last4: null } }
    banks.set(dest, bank)
  }
  const amount = (p.amount ?? 0) / 100
  const status = dispStatus(String(p.status))
  const initiated = new Date((p.created ?? 0) * 1000)
  const settled = status === 'settled' && p.arrival_date ? new Date(p.arrival_date * 1000) : null
  const existing = await queryOne<{ id: string }>(`SELECT id FROM disbursements WHERE stripe_payout_id = $1`, [p.id])
  if (existing) {
    await query(
      `UPDATE disbursements SET status=$2, settled_at=COALESCE(settled_at,$3),
              bank_name=COALESCE(bank_name,$4), bank_last4=COALESCE(bank_last4,$5),
              landlord_id=COALESCE(landlord_id,$6)
        WHERE id=$1`, [existing.id, status, settled, bank?.name ?? null, bank?.last4 ?? null, owner.landlord_id])
    return 'updated'
  }
  await query(
    `INSERT INTO disbursements
       (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, settled_at,
        fee_charged, bank_name, bank_last4, notes, created_at)
     VALUES ($1,$2,'stripe_dashboard',$3,$4,$5,$6,$7,0,$8,$9,$10,$6)`,
    [owner.user_id, owner.landlord_id, amount, status, p.id, initiated, settled, bank?.name ?? null, bank?.last4 ?? null,
     'Paid out from the Stripe dashboard; recorded by GAM from Stripe.'])
  return 'created'
}

/** The GAM owner of a Connect account: the user, and the company it is stamped on. */
export async function connectPayoutOwner(account: string): Promise<PayoutOwner | null> {
  return queryOne<PayoutOwner>(
    `SELECT $1::text AS account, user_id, landlord_id FROM (
       SELECT l.user_id, l.id AS landlord_id, l.created_at FROM landlords l
        WHERE l.stripe_connect_account_id = $1 AND l.user_id IS NOT NULL
       UNION ALL
       SELECT u.id, NULL, u.created_at FROM users u WHERE u.stripe_connect_account_id = $1
     ) x ORDER BY landlord_id NULLS LAST, created_at LIMIT 1`, [account])
}

export async function syncConnectPayouts(stripe: PayoutLister = getStripe() as any, opts: { limit?: number } = {}) {
  const accounts = await query<PayoutOwner>(
    `SELECT DISTINCT ON (account) account, user_id, landlord_id FROM (
       SELECT l.stripe_connect_account_id AS account, l.user_id, l.id AS landlord_id
         FROM landlords l WHERE l.stripe_connect_account_id IS NOT NULL AND l.user_id IS NOT NULL
       UNION ALL
       SELECT u.stripe_connect_account_id, u.id, NULL FROM users u WHERE u.stripe_connect_account_id IS NOT NULL
     ) x ORDER BY account, landlord_id NULLS LAST`)
  const banks = new Map<string, { name: string | null; last4: string | null }>()
  let seen = 0, created = 0, updated = 0
  for (const a of accounts) {
    let page: { data: any[] }
    try { page = await stripe.payouts.list({ limit: opts.limit ?? 25 }, { stripeAccount: a.account }) }
    catch (e) { logger.warn({ err: e, account: a.account }, '[payout-sync] could not list payouts'); continue }
    for (const p of page.data) {
      seen++
      if (await fileConnectPayout(stripe, a, p, banks) === 'created') created++; else updated++
    }
  }
  return { accounts: accounts.length, seen, created, updated }
}
