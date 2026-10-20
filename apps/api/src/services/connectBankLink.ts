/**
 * ONE BANK LINK — adopting the bank a landlord already connected in step one.
 *
 * 10/20 (Nic): "We need a way to link the bank account once and have it be
 * everything. It needs to do the feed. It needs to do the deposits or whatever
 * one flow needs to be the whole thing and it boggles my mind that Stripe being
 * one of the biggest payment processors in the world has no functionality for
 * that."
 *
 * WHAT IS SET UP, AND WHAT IS NOT YET PROVEN. On the morning of 10/20 Nic
 * turned on, in the Stripe Dashboard under Settings > Connect > Payouts >
 * External accounts, collection of bank details with Financial Connections plus
 * the optional financial-data access for balances, account ownership details
 * and transactions. So the SETTING is on.
 *
 * What has NOT happened yet is an onboarding under that setting. Measured
 * against live Stripe on 10/20, every Financial Connections link the three live
 * connected accounts hold carries permissions exactly ["payment_method"] with
 * no subscriptions — Oak Park's (fca_1U5WDs…, inactive), TruBlu's
 * (fca_1USLR9…, active). Both were granted before the switch. So the claim
 * "from the switch on, the bank from step one can be read for transactions"
 * rests on the setting and Stripe's documentation, NOT on a read of a real
 * object, and this file is written so that being wrong about it costs nothing:
 * permissions are read off the Stripe object every time, and a link that does
 * not carry `transactions` is never adopted. If the setting turns out to widen
 * only what the platform may REQUEST rather than what each new link records,
 * every landlord lands in `not_readable` and does step two by hand, exactly as
 * today. The first real onboarding is what proves it either way.
 *
 * AND IT DOES NOT ALWAYS APPLY. A Connect account can hold NO Financial
 * Connections link at all: Mountain View's payout bank was added by routing and
 * account number (external account WELLS FARGO ••8739, status "new") and its
 * account holds zero FC links. Whenever onboarding takes the manual-entry path,
 * or the bank is not supported by Financial Connections, there is nothing to
 * adopt — `no_link` — and step two stays. "Step two is already done the first
 * time the landlord looks" is true for a Financial-Connections onboarding, not
 * for every onboarding.
 *
 * WHAT THIS FILE DOES. Asks a landlord's connected account which bank links it
 * holds, and when one of them can be read for transactions, writes it into
 * `bank_connections` as the landlord's feed. From then on the Bank page shows
 * step two as done and the feed syncs it like any other link — see
 * `bankFeed.fcAcct`, which is the one place that knows a connect-held link needs
 * the Stripe-Account header.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   * It never touches an existing feed. Mountain View has been syncing since
 *     09-03 and Oak Park since 09-26, both through GAM's platform customer. A
 *     landlord who already has a row is left alone and Stripe is not even
 *     asked. Running two links on one bank account is exactly the duplicate-row
 *     problem S652 and S655 were spent fixing — and `status` is not the test
 *     for that, because one Stripe timeout in the 06:00 sync writes
 *     status='error' on a perfectly good link (bankFeed.syncConnection). A row
 *     that exists and was not deliberately removed IS the landlord's feed,
 *     whatever it last said about syncing.
 *
 *   * It never mints GAM's fee debit, because it cannot. The debit is a
 *     PLATFORM payment method; the onboarding link belongs to the connected
 *     account, and Stripe will not build a platform payment method out of a
 *     bank account the platform cannot even retrieve without that account's
 *     header. Verified live on 10/20, and `bankFeed.createDebitPaymentMethod`
 *     filters to platform-held links for the same reason.
 *
 *     So an adopted link leaves GAM with a feed and NO route to debit — which
 *     under S651 ("it's mandatory… if there's no electronic charges to debit
 *     against, then when it hits the threshold, we debit from their account
 *     that they have linked") is a collection failure, never an exemption. Two
 *     things carry it, and neither is a toggle: the Bank page states that one
 *     connection here is still needed for fee collection (it does not offer it
 *     as a preference), and `landlordGamDebit.uncollectableLandlords` already
 *     reports any landlord over the threshold with no debit method. This
 *     function's part is to say so out loud in the log when it adopts, so the
 *     state is never silent.
 *
 *   * It never assumes. Permissions are read off the Stripe object, never
 *     inferred from a date. A link made before this morning carries
 *     payment_method only and is not adopted, because reading it for
 *     transactions returns a 400 naming the missing permission — Stripe fixes
 *     permissions at link time and they never widen.
 */
import { query, queryOne, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { fcCanReadTransactions, FC_BALANCES_PERMISSION } from '@gam/shared'
import { syncConnection } from './bankFeed'

/**
 * How long GAM waits before asking a landlord's connected account again when
 * the last ask found nothing to adopt. An onboarding that finishes mid-session
 * also fires the `account.updated` webhook, which asks immediately — this is
 * only the floor under a page that is open and refetching.
 */
export const RECHECK_AFTER_MINUTES = 10

/** One bank link as the connected account holds it. */
export interface ConnectHeldLink {
  id: string
  institutionName: string | null
  displayName: string | null
  last4: string | null
  status: string | null
  subcategory: string | null
  permissions: string[]
  /** Can the feed read transactions through it? */
  readable: boolean
}

export type OnboardingBankOutcome =
  /** No Stripe account at all — step one has not been started. */
  | { state: 'no_stripe_account' }
  /** A bank is already linked for the feed; nothing was asked and nothing changed. */
  | { state: 'already_linked' }
  /** Asked recently and found nothing; not asked again. */
  | { state: 'checked_recently' }
  /**
   * Another ask for this same landlord was running at this moment (a page that
   * polls every four seconds, and the webhook firing while it does). Nothing
   * was asked twice and nothing was written twice.
   */
  | { state: 'in_flight' }
  /**
   * The connected account holds a readable link, now the landlord's feed.
   * `debitOutstanding` says GAM has a feed and still no way to collect its fees
   * from this landlord — see the header; it is disclosed, never a choice.
   */
  | { state: 'adopted'; connectionId: string; link: ConnectHeldLink; debitOutstanding: boolean }
  /**
   * It holds a link, but nothing GAM may adopt: it cannot be read for
   * transactions, or the landlord took that bank off their feed themselves.
   * Step two still has a job.
   */
  | { state: 'not_readable'; links: ConnectHeldLink[] }
  /** It holds no bank link (the payout account was typed in by hand, not connected). */
  | { state: 'no_link' }
  /** Stripe could not be asked. Nothing claimed, nothing stamped — it will ask again. */
  | { state: 'unreachable'; error: string }

/**
 * Which landlords own this Stripe Connect account? Entity first, then its
 * founding owner (S554 allows the account to be anchored on the USER).
 *
 * 10/20 (review): the `account.updated` webhook resolved owners with
 * `WHERE stripe_connect_account_id = $1` against landlords ONLY, so a
 * user-anchored account found zero rows and nothing was adopted — the landlord
 * sat in front of a step that was already done until the lazy page path ran.
 * One resolution, used by both the webhook and the lookup below, so they cannot
 * drift apart. (Dormant on production today: all eight landlord rows carry the
 * account on the entity and users.stripe_connect_account_id is NULL for every
 * one of them.)
 */
export async function landlordsForConnectAccount(connectAccountId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT l.id FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) = $1`,
    [connectAccountId])
  return rows.map(r => r.id)
}

/** The Stripe account that is this company's, entity first then its founding owner (S554). */
async function connectAccountFor(landlordId: string): Promise<string | null> {
  const r = await queryOne<{ acct: string | null }>(
    `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS acct
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
  return r?.acct ?? null
}

/**
 * What bank links does this connected account hold?
 *
 * The Stripe-Account header is the whole trick. Without it the platform gets a
 * 404 on an account it owns the platform side of — confirmed live on 10/20
 * against TruBlu Management LLC (acct_1USLGx…): `No such account:
 * 'fca_1USLR9…'` header-less, and the full object with it. Filtering the
 * platform-side list by `account_holder[account]` returns nothing, so there is
 * no header-less route to this at all.
 */
export async function readConnectHeldLinks(connectAccountId: string): Promise<ConnectHeldLink[]> {
  const list: any = await getStripe().financialConnections.accounts.list(
    { limit: 25 }, { stripeAccount: connectAccountId })
  return (list?.data ?? []).map((a: any): ConnectHeldLink => {
    const permissions: string[] = Array.isArray(a?.permissions) ? a.permissions : []
    return {
      id: a.id,
      institutionName: a.institution_name ?? null,
      displayName: a.display_name ?? null,
      last4: a.last4 ?? null,
      status: a.status ?? null,
      subcategory: a.subcategory ?? a.category ?? null,
      permissions,
      readable: fcCanReadTransactions(permissions) && (!a.status || a.status === 'active'),
    }
  })
}

/**
 * Does this landlord already have a feed? Any row that was not deliberately
 * removed counts — `listConnections` draws the Bank page's list the same way
 * (`status <> 'disconnected'`), so the page and this guard can never disagree
 * about whether a bank is linked.
 *
 * 10/20 (review): this used to read `status = 'active'`, which left an errored
 * row invisible to the guard. One Stripe 502 in the 06:00 sweep writes
 * status='error' (bankFeed.syncConnection), and the next page render would then
 * adopt the connect-held link to the SAME physical bank as a second row,
 * subscribe it and sync it — two active connections on one bank account.
 */
async function hasFeed(landlordId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM bank_connections WHERE landlord_id = $1 AND status <> 'disconnected' LIMIT 1`,
    [landlordId])
  return rows.length > 0
}

/**
 * Claim the one ask, atomically, before Stripe is touched.
 *
 * 10/20 (review): the stamp used to be written AFTER the Stripe read, so the
 * floor it is supposed to enforce did not hold under the thing that actually
 * happens — OnboardingPage polls the connections endpoint every four seconds
 * while the landlord sits on step 4, and the first adoption (two subscribes and
 * a transaction import) can outlast four seconds. Both requests then read, both
 * stamped, both inserted, both subscribed and both synced. Claim first and the
 * loser is told `checked_recently` before any of that.
 *
 * Returns the stamp as it was BEFORE the claim, so an unreachable Stripe can put
 * it back and not burn the ask on a failure.
 */
async function claimTheAsk(landlordId: string, force: boolean): Promise<{ won: boolean; previous: Date | null }> {
  const r = await queryOne<{ won: boolean; previous: Date | null }>(
    `WITH before AS (
       SELECT id, connect_bank_checked_at AS prev FROM landlords WHERE id = $1 FOR UPDATE
     ), claimed AS (
       UPDATE landlords l SET connect_bank_checked_at = now()
         FROM before b
        WHERE l.id = b.id
          AND ($2::boolean
               OR b.prev IS NULL
               OR b.prev <= now() - ($3 || ' minutes')::interval)
       RETURNING l.id
     )
     SELECT (c.id IS NOT NULL) AS won, b.prev AS previous
       FROM before b LEFT JOIN claimed c ON c.id = b.id`,
    [landlordId, force, String(RECHECK_AFTER_MINUTES)])
  return { won: r?.won === true, previous: r?.previous ?? null }
}

/**
 * Make the bank from step one into the landlord's feed, when it can be read.
 *
 * Idempotent and cheap to call: it returns without touching Stripe when a bank
 * is already linked, and it remembers when it last asked so a page that
 * refetches does not spend a Stripe call per render.
 *
 * `force` is for the webhook that fires the moment onboarding completes, and for
 * an admin looking at a landlord on purpose — it skips the time floor but never
 * the "already has a feed" guard, because nothing about this is worth risking a
 * working feed over. It does not skip the lock: a forced ask arriving while a
 * page's ask is mid-adoption would otherwise subscribe and sync the same link a
 * second time.
 */
export async function ensureOnboardingBankLink(
  landlordId: string,
  opts: { force?: boolean } = {},
): Promise<OnboardingBankOutcome> {
  if (await hasFeed(landlordId)) return { state: 'already_linked' }

  const acct = await connectAccountFor(landlordId)
  if (!acct) return { state: 'no_stripe_account' }

  // One adoption per landlord at a time. Everything after this point reads or
  // writes at Stripe, and the callers are a 4-second page poll, an hourly job
  // and a webhook that can all land together.
  const lock = await getClient()
  const lockKey = `one-bank-link:${landlordId}`
  try {
    const got = await lock.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [lockKey])
    if (got.rows[0]?.ok !== true) return { state: 'in_flight' }
    try {
      return await adopt(landlordId, acct, opts.force === true)
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]).catch(() => {})
    }
  } finally {
    lock.release()
  }
}

/** The adoption itself, with the landlord's ask claimed and nobody else on it. */
async function adopt(landlordId: string, acct: string, force: boolean): Promise<OnboardingBankOutcome> {
  // Re-read under the lock: the request that just finished adopting may have
  // been the one holding it.
  if (await hasFeed(landlordId)) return { state: 'already_linked' }

  const claim = await claimTheAsk(landlordId, force)
  if (!claim.won) return { state: 'checked_recently' }

  let links: ConnectHeldLink[]
  try {
    links = await readConnectHeldLinks(acct)
  } catch (e: any) {
    // Nothing is claimed and nothing is stamped: an unreachable Stripe must not
    // look like "this landlord has no bank", and must not use up the one ask.
    await query('UPDATE landlords SET connect_bank_checked_at = $2 WHERE id = $1',
      [landlordId, claim.previous]).catch(() => {})
    logger.warn({ err: e, landlordId, acct }, '[one-bank-link] could not read the connected account’s bank links')
    return { state: 'unreachable', error: String(e?.message ?? e) }
  }

  // The payout bank was typed in by routing and account number, or the bank is
  // not supported by Financial Connections. Mountain View's shape. Step two stays.
  if (links.length === 0) return { state: 'no_link' }

  // A link the landlord already took off the feed is not adopted again. They
  // have seen that bank on the page and removed it — re-linking it behind them
  // because Stripe still holds the grant would be GAM overruling a decision
  // they made on purpose.
  const removed = new Set((await query<{ fca: string }>(
    `SELECT stripe_fc_account_id AS fca FROM bank_connections
      WHERE landlord_id = $1 AND status = 'disconnected' AND stripe_fc_account_id IS NOT NULL`,
    [landlordId])).map(r => r.fca))

  const readable = links.find(l => l.readable && !removed.has(l.id))
  if (!readable) return { state: 'not_readable', links }

  const inst = readable.institutionName ?? readable.displayName ?? 'Bank'
  const conn = await queryOne<{ id: string }>(
    `INSERT INTO bank_connections
       (landlord_id, provider, stripe_fc_account_id, stripe_connect_account_id,
        institution_name, account_last4, account_type, display_name, source, fc_permissions)
     VALUES ($1,'stripe_fc',$2,$3,$4,$5,$6,$7,'connect_onboarding',$8)
     ON CONFLICT (stripe_fc_account_id) WHERE stripe_fc_account_id IS NOT NULL
     DO UPDATE SET status='active', fc_permissions=EXCLUDED.fc_permissions,
                   stripe_connect_account_id=EXCLUDED.stripe_connect_account_id, updated_at=now()
     -- The unique index on stripe_fc_account_id is platform-wide, so this says
     -- out loud that a row belonging to a DIFFERENT company is never reassigned
     -- by an adoption. Nothing is returned then and nothing is claimed.
     WHERE bank_connections.landlord_id = EXCLUDED.landlord_id
     RETURNING id`,
    [landlordId, readable.id, acct, inst, readable.last4 ?? null, readable.subcategory,
     `${inst}${readable.last4 ? ' ••' + readable.last4 : ''}`, readable.permissions])
  if (!conn) {
    logger.warn({ landlordId, fca: readable.id },
      '[one-bank-link] that bank link is already on file under another company — not adopted')
    return { state: 'not_readable', links }
  }
  const connectionId = conn.id

  // Ask Stripe to keep refreshing it, exactly as a landlord-made link does.
  // Best-effort and each on its own: a link without balances consent must not
  // take the transaction subscription down with it.
  const stripe = getStripe()
  try {
    await stripe.financialConnections.accounts.subscribe(
      readable.id, { features: ['transactions'] }, { stripeAccount: acct })
  } catch (e) { logger.warn({ err: e, landlordId, fca: readable.id }, '[one-bank-link] transactions subscribe failed') }
  if (readable.permissions.includes(FC_BALANCES_PERMISSION)) {
    try {
      await stripe.financialConnections.accounts.subscribe(
        readable.id, { features: ['balance'] as any }, { stripeAccount: acct })
    } catch (e) { logger.warn({ err: e, landlordId, fca: readable.id }, '[one-bank-link] balance subscribe failed') }
  }

  // Stripe backfills asynchronously, so this usually reports "still pending" —
  // the hourly sync picks it up. Never allowed to fail the adoption.
  try { await syncConnection(connectionId) } catch { /* initial sync is best-effort */ }

  // S651: the fee debit is not optional, and an adopted link cannot serve it.
  // Written here so a landlord with a feed and no collection route is on the
  // record from the moment it happens, not first noticed when they are over the
  // threshold (landlordGamDebit.uncollectableLandlords).
  const debitOutstanding = !(await queryOne<{ pm: string | null }>(
    `SELECT gam_debit_payment_method_id AS pm FROM landlords WHERE id = $1`, [landlordId]))?.pm
  if (debitOutstanding) {
    logger.warn({ landlordId, connectionId, fca: readable.id },
      '[one-bank-link] feed adopted from Connect onboarding; GAM still has no way to debit this landlord’s bank')
  }

  logger.info({ landlordId, connectionId, fca: readable.id, institution: inst, debitOutstanding },
    '[one-bank-link] adopted the bank from Connect onboarding — step two is done')
  return { state: 'adopted', connectionId, link: readable, debitOutstanding }
}
