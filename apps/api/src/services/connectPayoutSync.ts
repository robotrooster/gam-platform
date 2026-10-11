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
import { query, queryOne, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { stampPayoutTransfers, PAYOUT_GAP_NOTICE } from './payoutComposition'

export type PayoutLister = {
  payouts: { list: (params: any, opts: any) => Promise<{ data: any[] }> }
  accounts: { retrieveExternalAccount: (acct: string, id: string) => Promise<any> }
}

const dispStatus = (s: string) =>
  s === 'paid' ? 'settled' : (s === 'failed' || s === 'canceled') ? 'failed' : 'processing'

export type PayoutOwner = { account: string; user_id: string; landlord_id: string | null }

/**
 * One payout → one `disbursements` row. Updates the row GAM wrote when it
 * initiated the payout (status, settled date, bank, company — and what it
 * carried, when recording that the first time failed); inserts a
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
  let existing = await queryOne<{ id: string }>(`SELECT id FROM disbursements WHERE stripe_payout_id = $1`, [p.id])
  if (!existing) {
    // S655 review: ON CONFLICT, because the payout run (or a second delivery
    // of this webhook) can file the same payout between the lookup above and
    // this insert. stripe_payout_id is unique (migration 20261003001000): one
    // payout, one row. The loser updates the winner's row below.
    const created = await queryOne<{ id: string }>(
      `INSERT INTO disbursements
         (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, settled_at,
          fee_charged, bank_name, bank_last4, notes, created_at, stripe_account_id)
       VALUES ($1,$2,'stripe_dashboard',$3,$4,$5,$6,$7,0,$8,$9,$10,$6,$11)
       ON CONFLICT (stripe_payout_id) WHERE stripe_payout_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [owner.user_id, owner.landlord_id, amount, status, p.id, initiated, settled, bank?.name ?? null, bank?.last4 ?? null,
       'Paid out from the Stripe dashboard; recorded by GAM from Stripe.', owner.account])
    if (created?.id) {
      // S655: a payout made in Stripe sweeps the same balance GAM's transfers fill,
      // so it carried the transfers that landed before it. Record them, so this
      // payout lists its payments like any other. A failed payout carried nothing.
      if (status !== 'failed') {
        try {
          await stampPayoutTransfers({
            disbursementId: created.id, connectAccountId: owner.account,
            payoutAmount: amount, payoutAt: initiated,
          })
        } catch (e) {
          logger.warn({ err: e, payout_id: p.id }, '[payout-sync] could not record what the payout carried')
        }
      }
      return 'created'
    }
    existing = await queryOne<{ id: string }>(`SELECT id FROM disbursements WHERE stripe_payout_id = $1`, [p.id])
    if (!existing) throw new Error(`payout ${p.id} was filed and then could not be read back`)
  }
  await query(
    `UPDATE disbursements SET status=$2, settled_at=COALESCE(settled_at,$3),
            bank_name=COALESCE(bank_name,$4), bank_last4=COALESCE(bank_last4,$5),
            landlord_id=COALESCE(landlord_id,$6)
      WHERE id=$1`, [existing.id, status, settled, bank?.name ?? null, bank?.last4 ?? null, owner.landlord_id])
  // S655: a failed payout's money goes back onto the Stripe balance, and the
  // next payout carries it — so its transfers go back in the queue with it.
  if (status === 'failed') {
    await query(
      `UPDATE platform_transfer_intents SET disbursement_id = NULL, updated_at = NOW() WHERE disbursement_id = $1`,
      [existing.id])
  } else {
    await restampIfNothingLinked(existing.id, owner.account, p.id)
  }
  return 'updated'
}

/**
 * S655 review: recording what a payout carried is best-effort — the payout run
 * and the webhook both log a failure and carry on, because the money has
 * already gone. But nothing ever tried again, and no later payout may take
 * what an earlier sweep carried, so one database hiccup left that sweep's
 * whole amount "not traced" for good and its payments listed nowhere.
 *
 * So whenever this sync (nightly, after each payout run, or the webhook) sees
 * a payout that did not fail and has no transfer linked to it, it records it
 * again, as of the moment the payout was made — the same instant its first
 * attempt used. A payout still inside its first few minutes is left to the
 * code that filed it, which may be mid-way through recording it right now.
 *
 * Some payouts rightly carry no transfer (a dashboard payout smaller than the
 * oldest waiting transfer takes none), so most nights this finds nothing new.
 * Then the payout stands exactly where its first record left it, and the admin
 * has already been told — the notice may be open, or acknowledged. Re-stamping
 * it with notices on raised the same "does not equal the transfers inside it"
 * notice again every night after an admin acknowledged it. So the re-stamp is
 * tried first and rolled back: only when it would link something is it done
 * for real, and the notices brought up to date (this payout's, and any later
 * sweep it takes transfers back from). The one exception is a payout the admin
 * was never told about — its first record failed before it could say — which
 * gets its notice once.
 */
const RESTAMP_AFTER_MINUTES = 10

async function restampIfNothingLinked(disbursementId: string, account: string, payoutId: string): Promise<void> {
  const row = await queryOne<{ amount: string; payout_at: Date }>(
    // The payout's own instant, rounded UP to the millisecond a JS date can
    // carry: rounded down, a transfer in the dropped microseconds would be
    // after this payout and — being before its stored time — before the next.
    `SELECT d.amount::text AS amount,
            date_trunc('milliseconds', COALESCE(d.initiated_at, d.created_at))
              + CASE WHEN COALESCE(d.initiated_at, d.created_at)
                          > date_trunc('milliseconds', COALESCE(d.initiated_at, d.created_at))
                     THEN interval '1 millisecond' ELSE interval '0' END AS payout_at
       FROM disbursements d
      WHERE d.id = $1
        AND d.status <> 'failed'
        AND COALESCE(d.initiated_at, d.created_at) < NOW() - make_interval(mins => $2)
        AND NOT EXISTS (SELECT 1 FROM platform_transfer_intents i WHERE i.disbursement_id = d.id)`,
    [disbursementId, RESTAMP_AFTER_MINUTES])
  if (!row) return
  const stamp = {
    disbursementId, connectAccountId: account,
    payoutAmount: Number(row.amount), payoutAt: new Date(row.payout_at),
  }
  try {
    if (!(await restampWouldLink(stamp)) && await adminWasToldAbout(disbursementId)) return
    const r = await stampPayoutTransfers(stamp)
    if (r.intentIds.length) {
      logger.info({ payout_id: payoutId, disbursementId, intents: r.intentIds },
        '[payout-sync] recorded what an earlier payout carried — its first record had failed')
    }
  } catch (e) {
    logger.warn({ err: e, payout_id: payoutId }, '[payout-sync] could not record what the payout carried')
  }
}

/**
 * Whether recording this payout again would link any transfer to it. Tried in
 * a transaction that is always rolled back, as a trial: nothing is written,
 * nobody is told, and nothing is logged — a take-back logged here never
 * happened, and the real call that follows logs its own.
 */
async function restampWouldLink(stamp: Parameters<typeof stampPayoutTransfers>[0]): Promise<boolean> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await stampPayoutTransfers({ ...stamp, client: c, trial: true })
    return r.intentIds.length > 0
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
  }
}

/** Whether a gap notice was ever raised for this payout, open or acknowledged. */
async function adminWasToldAbout(disbursementId: string): Promise<boolean> {
  return !!(await queryOne(
    `SELECT 1 FROM admin_notifications
      WHERE category = $1 AND context->>'disbursementId' = $2 LIMIT 1`,
    [PAYOUT_GAP_NOTICE, disbursementId]))
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
    // S655: oldest first. Stripe lists newest first, and a payout claims the
    // transfers waiting before it — filing the newest first would hand it the
    // older payout's transfers.
    const oldestFirst = [...page.data].sort((a, b) => Number(a.created ?? 0) - Number(b.created ?? 0))
    for (const p of oldestFirst) {
      seen++
      if (await fileConnectPayout(stripe, a, p, banks) === 'created') created++; else updated++
    }
  }
  return { accounts: accounts.length, seen, created, updated }
}
