/**
 * ONE BANK LINK — a landlord should not find and log into the same bank twice.
 *
 * 10/20 (Nic): "We need a way to link the bank account once and have it be
 * everything. It needs to do the feed. It needs to do the deposits or whatever
 * one flow needs to be the whole thing and it boggles my mind that Stripe being
 * one of the biggest payment processors in the world has no functionality for
 * that."
 *
 * This morning Nic turned on, in the Stripe Dashboard under
 * Settings > Connect > Payouts > External accounts, financial-data access for
 * balances, account ownership details and transactions. So the bank a landlord
 * signs into while verifying their business can now be READ, and step two has
 * nothing left to collect from them.
 *
 * The two populations, and nobody gets asked twice:
 *   * Onboarded from today on — step two is already done. Pinned below.
 *   * Already onboarded (Blu Haws finished at 18:24 on 10/19, before the
 *     switch; Nic's own two companies linked their feeds separately in
 *     September) — step two stays, ONCE. Nic: "he still only has to do step two
 *     either way, right?" Yes. Pinned below that it is never twice.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. The Stripe Dashboard setting is on; no
 * onboarding has run under it yet. Measured against live Stripe on 10/20, every
 * Financial Connections link the three live connected accounts hold carries
 * permissions exactly ["payment_method"] with no subscriptions — so the tests
 * below drive BOTH shapes on purpose: a link that carries `transactions` (what
 * the setting is supposed to produce) and a link that does not (every link that
 * exists today). Being wrong about the setting costs a landlord step two by
 * hand, which is what happens today, and nothing else.
 *
 * NOTHING HERE REACHES STRIPE. The client is a fake that records every call and
 * the options each one carried, which is how the Stripe-Account header is
 * asserted — and `noStripeWrites()` fails the test if anything tries to create,
 * update or delete at Stripe.
 *
 * NEEDS MIGRATION 20261021190000, which is not on production yet:
 *   DB_NAME=gam_test TEST_APPLY_MIGRATIONS_AFTER=20261021170000 npx vitest run services/connectBankLink
 * (or `npm test -- connectBankLink` with the same env var — the package script
 * sets DB_NAME.) Drop the variable once the migration is applied.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface FakeCall { method: string; args: any[]; opts: any }

const stripeFake = vi.hoisted(() => ({
  calls: [] as FakeCall[],
  /** FC accounts the PLATFORM holds, by fca id. */
  platformAccounts: {} as Record<string, any>,
  /** FC accounts each CONNECTED account holds, by acct id. */
  connectAccounts: {} as Record<string, any[]>,
  /** Transactions per fca id. */
  txns: {} as Record<string, any[]>,
  /** Make the connected-account read fail, as an unreachable Stripe would. */
  listThrows: null as null | Error,
}))

vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const log = (method: string, args: any[], opts: any) => { stripeFake.calls.push({ method, args, opts }) }
  /** Every FC account the fake knows, platform-held or connect-held. */
  const findAccount = (id: string, opts: any) => {
    const acct = opts?.stripeAccount
    if (acct) return (stripeFake.connectAccounts[acct] ?? []).find((a: any) => a.id === id)
    return stripeFake.platformAccounts[id]
  }
  return {
    ...actual,
    getStripe: () => ({
      financialConnections: {
        accounts: {
          list: async (_params: any, opts: any) => {
            log('accounts.list', [_params], opts)
            if (stripeFake.listThrows) throw stripeFake.listThrows
            const acct = opts?.stripeAccount
            return { data: acct ? (stripeFake.connectAccounts[acct] ?? []) : Object.values(stripeFake.platformAccounts) }
          },
          retrieve: async (id: string, opts: any) => {
            log('accounts.retrieve', [id], opts)
            const a = findAccount(id, opts)
            // Live Stripe, 10/20: a connect-held link is a flat 404 header-less.
            if (!a) throw Object.assign(new Error(`No such account: '${id}'`), { code: 'resource_missing', statusCode: 404 })
            return a
          },
          refresh: async (id: string, _params: any, opts: any) => {
            log('accounts.refresh', [id, _params], opts)
            const a = findAccount(id, opts)
            if (!a) throw Object.assign(new Error(`No such account: '${id}'`), { code: 'resource_missing', statusCode: 404 })
            return a
          },
          subscribe: async (id: string, params: any, opts: any) => {
            log('accounts.subscribe', [id, params], opts)
            return findAccount(id, opts) ?? {}
          },
        },
        transactions: {
          list: (params: any, opts: any) => {
            log('transactions.list', [params], opts)
            const holder = opts?.stripeAccount
            const a = findAccount(params.account, opts)
            // Live Stripe, 10/20, reading a payment_method-only link:
            // "This account was not created with the required permissions
            // (`transactions`) to perform this operation."
            if (!a) throw Object.assign(new Error(`No such account: '${params.account}'`), { code: 'resource_missing', statusCode: 404 })
            if (!(a.permissions ?? []).includes('transactions')) {
              throw Object.assign(
                new Error('This account was not created with the required permissions (`transactions`) to perform this operation.'),
                { statusCode: 400 })
            }
            void holder
            const rows = stripeFake.txns[params.account] ?? []
            return { [Symbol.asyncIterator]: async function* () { for (const t of rows) yield t } }
          },
        },
        sessions: {
          create: async (...a: any[]) => { log('sessions.create', a, null); throw new Error('no Stripe writes in this suite') },
          retrieve: async (...a: any[]) => { log('sessions.retrieve', a, null); return { accounts: { data: [] } } },
        },
      },
      customers: {
        create: async (...a: any[]) => { log('customers.create', a, null); return { id: 'cus_fake' } },
      },
      paymentMethods: {
        create: async (...a: any[]) => { log('paymentMethods.create', a, null); return { id: 'pm_fake', us_bank_account: { last4: '0000', bank_name: 'Fake' } } },
        attach: async (...a: any[]) => { log('paymentMethods.attach', a, null); return {} },
        retrieve: async (...a: any[]) => { log('paymentMethods.retrieve', a, null); throw Object.assign(new Error('no pm'), { code: 'resource_missing', statusCode: 404 }) },
      },
    }),
  }
})

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import {
  ensureOnboardingBankLink, readConnectHeldLinks, RECHECK_AFTER_MINUTES,
  landlordsForConnectAccount,
} from './connectBankLink'
import { listConnections, syncConnection, createDebitPaymentMethod, fcAcct, isPlatformHeld } from './bankFeed'

/** The Stripe calls that change something at Stripe. None may happen in this suite. */
const WRITE_METHODS = ['sessions.create', 'paymentMethods.create', 'paymentMethods.attach',
  'customers.create', 'accounts.refresh', 'accounts.subscribe']

/**
 * Nothing in these tests may write at Stripe. `accounts.subscribe` is the one
 * call the adoption makes that is technically a write, so a test that expects it
 * names it; everything else is a failure.
 */
function noStripeWrites(allow: string[] = []) {
  const wrote = stripeFake.calls.filter(c => WRITE_METHODS.includes(c.method) && !allow.includes(c.method))
  expect(wrote.map(c => c.method), 'no Stripe writes').toEqual([])
}

const callsTo = (method: string) => stripeFake.calls.filter(c => c.method === method)

beforeEach(async () => {
  await cleanupAllSchema()
  stripeFake.calls = []
  stripeFake.platformAccounts = {}
  stripeFake.connectAccounts = {}
  stripeFake.txns = {}
  stripeFake.listThrows = null
})

/** A landlord, optionally with a Stripe Connect account on the ENTITY. */
async function landlord(opts: { connectAccount?: string | null } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { landlordId, userId } = await seedLandlord(c)
    if (opts.connectAccount) {
      await c.query(
        `UPDATE landlords SET stripe_connect_account_id = $2, connect_payouts_enabled = true,
                              connect_details_submitted = true WHERE id = $1`,
        [landlordId, opts.connectAccount])
    }
    await c.query('COMMIT')
    return { landlordId, userId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A bank link held by GAM's platform customer — the shape every live feed has today. */
async function platformLink(landlordId: string, fca: string, o: { inst?: string; last4?: string; permissions?: string[] } = {}) {
  const perms = o.permissions ?? ['transactions', 'balances', 'payment_method']
  stripeFake.platformAccounts[fca] = {
    id: fca, institution_name: o.inst ?? 'Wells Fargo', last4: o.last4 ?? '8739',
    status: 'active', permissions: perms, subcategory: 'checking',
  }
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_connections
       (landlord_id, provider, stripe_fc_account_id, institution_name, account_last4,
        display_name, source, fc_permissions)
     VALUES ($1,'stripe_fc',$2,$3,$4,$5,'landlord_link',$6) RETURNING id`,
    [landlordId, fca, o.inst ?? 'Wells Fargo', o.last4 ?? '8739',
     `${o.inst ?? 'Wells Fargo'} ••${o.last4 ?? '8739'}`, perms])).rows[0].id
}

/** A bank link the CONNECTED account holds, as Connect onboarding leaves it. */
function connectHeldLink(acct: string, fca: string, permissions: string[], o: { inst?: string; last4?: string; status?: string } = {}) {
  const link = {
    id: fca, institution_name: o.inst ?? 'First Mid Bank & Trust - Business',
    display_name: 'TRUBLU MANAGEMENT', last4: o.last4 ?? '8944',
    status: o.status ?? 'active', permissions, subcategory: 'checking',
    account_holder: { type: 'account', account: acct },
  }
  stripeFake.connectAccounts[acct] = [...(stripeFake.connectAccounts[acct] ?? []), link]
  return link
}

const txn = (id: string, amount: number, desc: string, day: string) => ({
  id, amount, currency: 'usd', description: desc, status: 'posted',
  transacted_at: Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000),
})

// ── Onboarded from today on: step two is already done ───────────────────────

describe('a landlord whose onboarding granted transactions', () => {
  it('has their bank adopted as the feed, so step two shows as done', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_new' })
    connectHeldLink('acct_new', 'fca_new', ['payment_method', 'balances', 'transactions', 'ownership'])
    stripeFake.txns['fca_new'] = [txn('fctxn_1', -12500, 'HOME DEPOT #1234', '2026-10-19')]

    const out = await ensureOnboardingBankLink(landlordId)
    expect(out.state).toBe('adopted')
    // S651: an adopted link cannot serve GAM's fee debit, so the adoption says
    // out loud that GAM still has no way to collect from this landlord. It is
    // disclosed on the Bank page and alarmed by uncollectableLandlords — never
    // treated as the landlord opting out.
    if (out.state === 'adopted') expect(out.debitOutstanding).toBe(true)

    // The row says where it came from and what it can do, so no screen has to guess.
    const row = (await db.query<any>(
      `SELECT * FROM bank_connections WHERE landlord_id = $1`, [landlordId])).rows[0]
    expect(row.status).toBe('active')
    expect(row.source).toBe('connect_onboarding')
    expect(row.stripe_connect_account_id).toBe('acct_new')
    expect(row.stripe_fc_account_id).toBe('fca_new')
    expect(row.fc_permissions).toEqual(['payment_method', 'balances', 'transactions', 'ownership'])

    // Which is what the Bank page reads: an active link, and it knows it was
    // granted in step one — that is step two done without asking anybody.
    const listed = await listConnections(landlordId)
    expect(listed).toHaveLength(1)
    expect(listed[0].status).toBe('active')
    expect(listed[0].source).toBe('connect_onboarding')
    expect(listed[0].connect_held).toBe(true)

    // And the transactions came with it — the whole point of the grant.
    const txns = await db.query('SELECT * FROM bank_transactions WHERE landlord_id = $1', [landlordId])
    expect(txns.rowCount).toBe(1)

    noStripeWrites(['accounts.subscribe'])
  })

  it('is never asked again — a second look makes no Stripe call at all', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_new' })
    connectHeldLink('acct_new', 'fca_new', ['payment_method', 'balances', 'transactions'])
    await ensureOnboardingBankLink(landlordId)
    const asksAfterFirst = callsTo('accounts.list').length
    expect(asksAfterFirst).toBe(1)

    // Every later look — a page render, an hourly job, the webhook firing again
    // — short-circuits on "a bank is already linked" before Stripe is touched.
    for (let i = 0; i < 5; i++) {
      expect((await ensureOnboardingBankLink(landlordId)).state).toBe('already_linked')
    }
    expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('already_linked')
    expect(callsTo('accounts.list')).toHaveLength(asksAfterFirst)

    // And exactly one link exists. Two links on one bank account is the
    // duplicate-row problem S652/S655 were spent fixing.
    const rows = await db.query('SELECT id FROM bank_connections WHERE landlord_id = $1', [landlordId])
    expect(rows.rowCount).toBe(1)
    noStripeWrites(['accounts.subscribe'])
  })

  it('a link that only carries payment_method is not adopted — permissions are read, never assumed', async () => {
    // Blu's actual link, as live Stripe reports it: fca_1USLR9…, active,
    // permissions ["payment_method"], finished 18:24 on 10/19 — before the switch.
    const { landlordId } = await landlord({ connectAccount: 'acct_1USLGxRfStEbjiIZ' })
    connectHeldLink('acct_1USLGxRfStEbjiIZ', 'fca_1USLR9RfStEbjiIZi6QYsn9v', ['payment_method'])

    const out = await ensureOnboardingBankLink(landlordId)
    expect(out.state).toBe('not_readable')
    if (out.state === 'not_readable') {
      expect(out.links[0].readable).toBe(false)
      expect(out.links[0].permissions).toEqual(['payment_method'])
    }
    expect((await db.query('SELECT id FROM bank_connections WHERE landlord_id = $1', [landlordId])).rowCount).toBe(0)
    noStripeWrites()
  })
})

// ── Onboarded before the switch: step two, exactly once ─────────────────────

describe('a landlord onboarded before the switch', () => {
  it('still gets step two, and gets it exactly once', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_1USLGxRfStEbjiIZ' })
    connectHeldLink('acct_1USLGxRfStEbjiIZ', 'fca_1USLR9RfStEbjiIZi6QYsn9v', ['payment_method'])

    // Step two is outstanding: no link, so the Bank page asks.
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('not_readable')
    expect(await listConnections(landlordId)).toHaveLength(0)

    // Looking again does not spend another Stripe call inside the window — a
    // page that refetches is not a reason to bill a Financial Connections read.
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('checked_recently')
    expect(callsTo('accounts.list')).toHaveLength(1)

    // He does step two: ONE bank sign-in on the Bank page, platform-held.
    await platformLink(landlordId, 'fca_blu_platform', { inst: 'First Mid Bank', last4: '8944' })

    // And is never asked again, whatever asks.
    for (const force of [false, true, false]) {
      expect((await ensureOnboardingBankLink(landlordId, { force })).state).toBe('already_linked')
    }
    const listed = await listConnections(landlordId)
    expect(listed).toHaveLength(1)
    expect(listed[0].source).toBe('landlord_link')
    expect(listed[0].connect_held).toBe(false)
    expect(listed[0].debit_ready).toBe(true)
    noStripeWrites()
  })

  it('the time floor expires, so a landlord who grants it later is picked up', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_later' })
    connectHeldLink('acct_later', 'fca_later_pm_only', ['payment_method'])
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('not_readable')
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('checked_recently')

    // Time passes, and the landlord relinks their bank through Stripe with the
    // new permissions — so the next look finds something readable.
    await db.query(
      `UPDATE landlords SET connect_bank_checked_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [landlordId, String(RECHECK_AFTER_MINUTES + 1)])
    stripeFake.connectAccounts['acct_later'] = []
    connectHeldLink('acct_later', 'fca_later_full', ['payment_method', 'balances', 'transactions'])

    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('adopted')
    noStripeWrites(['accounts.subscribe'])
  })
})

// ── One feed path, both shapes ──────────────────────────────────────────────

describe('the feed reads transactions through one path', () => {
  it('a connected-account link is read WITH the Stripe-Account header, a platform link without it', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_both' })

    // The platform-held link every live feed has today.
    const platformId = await platformLink(landlordId, 'fca_platform', { inst: 'Wells Fargo', last4: '8739' })
    stripeFake.txns['fca_platform'] = [
      txn('fctxn_p1', -40000, 'CHECK 1141 *2492', '2026-10-15'),
      txn('fctxn_p2', 125000, 'DOORLOOP CORPORATE ACH', '2026-10-16'),
    ]

    // The connect-held link an onboarding leaves behind.
    connectHeldLink('acct_both', 'fca_connect', ['payment_method', 'balances', 'transactions'])
    const connectId = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections
         (landlord_id, provider, stripe_fc_account_id, stripe_connect_account_id,
          institution_name, account_last4, display_name, source, fc_permissions)
       VALUES ($1,'stripe_fc','fca_connect','acct_both','First Mid Bank','8944',
               'First Mid Bank ••8944','connect_onboarding',
               ARRAY['payment_method','balances','transactions']) RETURNING id`,
      [landlordId])).rows[0].id
    stripeFake.txns['fca_connect'] = [txn('fctxn_c1', -7500, 'ACE HARDWARE', '2026-10-17')]

    // ONE function, called the same way for both.
    expect((await syncConnection(platformId)).inserted).toBe(2)
    expect((await syncConnection(connectId)).inserted).toBe(1)

    const reads = callsTo('transactions.list')
    expect(reads).toHaveLength(2)
    const platformRead = reads.find(r => r.args[0].account === 'fca_platform')!
    const connectRead = reads.find(r => r.args[0].account === 'fca_connect')!
    // The platform link is read directly, as it always was.
    expect(platformRead.opts).toBeUndefined()
    // The connected account's link is invisible without its id in the header.
    expect(connectRead.opts).toEqual({ stripeAccount: 'acct_both' })

    // Both banks' transactions land in the same table, under the same landlord.
    const rows = await db.query<any>(
      `SELECT external_id, bank_connection_id FROM bank_transactions WHERE landlord_id = $1 ORDER BY external_id`,
      [landlordId])
    expect(rows.rows.map(r => r.external_id)).toEqual(['fctxn_c1', 'fctxn_p1', 'fctxn_p2'])
    noStripeWrites()
  })

  it('the header is decided in one place, off the row itself', async () => {
    expect(fcAcct({ stripe_connect_account_id: 'acct_x' })).toEqual({ stripeAccount: 'acct_x' })
    expect(fcAcct({ stripe_connect_account_id: null })).toBeUndefined()
    expect(fcAcct(null)).toBeUndefined()
    expect(isPlatformHeld({ stripe_connect_account_id: null })).toBe(true)
    expect(isPlatformHeld({ stripe_connect_account_id: 'acct_x' })).toBe(false)
  })

  it('a link whose transactions permission is gone says so in words a landlord can act on', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_revoked' })
    connectHeldLink('acct_revoked', 'fca_revoked', ['payment_method'])
    const id = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections
         (landlord_id, provider, stripe_fc_account_id, stripe_connect_account_id,
          institution_name, account_last4, source, fc_permissions)
       VALUES ($1,'stripe_fc','fca_revoked','acct_revoked','First Mid Bank','8944',
               'connect_onboarding', ARRAY['payment_method']) RETURNING id`,
      [landlordId])).rows[0].id

    await expect(syncConnection(id)).rejects.toThrow(/permission to read its transactions/)
    const row = (await db.query<any>('SELECT * FROM bank_connections WHERE id = $1', [id])).rows[0]
    expect(row.status).toBe('error')
    expect(row.last_sync_error).toMatch(/Connect it once more/)
    // Not an active link any more, so the Bank page asks for step two again —
    // which is the only thing that can fix a permission Stripe fixed at link time.
    expect(await listConnections(landlordId)).toHaveLength(1)
    expect((await listConnections(landlordId))[0].status).toBe('error')
    noStripeWrites()
  })
})

// ── Nothing breaks for a landlord mid-flight ────────────────────────────────

describe('nothing breaks for anybody already set up', () => {
  it('an existing active feed keeps working and is never touched', async () => {
    // Mountain View's shape: a platform-held link, syncing since 09-03.
    const { landlordId } = await landlord({ connectAccount: 'acct_1UBh8jDngULWfeVL' })
    const id = await platformLink(landlordId, 'fca_1UBgtwDNEru9AEpKI06O5tZs', { inst: 'Wells Fargo', last4: '8739' })
    await db.query(
      `UPDATE bank_connections SET last_synced_at = now() - interval '1 hour', current_balance = 209691.47 WHERE id = $1`, [id])
    // Its connected account also holds an onboarding link to a different bank.
    connectHeldLink('acct_1UBh8jDngULWfeVL', 'fca_other_bank', ['payment_method', 'transactions'])
    stripeFake.txns['fca_1UBgtwDNEru9AEpKI06O5tZs'] = [txn('fctxn_mv', -2500, 'PROPANE', '2026-10-18')]

    // The look-up leaves it entirely alone — and does not even ask Stripe.
    expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('already_linked')
    expect(callsTo('accounts.list')).toHaveLength(0)

    const rows = await db.query<any>('SELECT * FROM bank_connections WHERE landlord_id = $1', [landlordId])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].id).toBe(id)
    expect(rows.rows[0].status).toBe('active')
    expect(rows.rows[0].source).toBe('landlord_link')
    expect(rows.rows[0].stripe_connect_account_id).toBeNull()

    // And it still syncs, through the same one path, with no header.
    expect((await syncConnection(id)).inserted).toBe(1)
    expect(callsTo('transactions.list')[0].opts).toBeUndefined()
    noStripeWrites()
  })

  it('a bank the landlord took off their feed is not re-linked behind them', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_removed' })
    connectHeldLink('acct_removed', 'fca_removed', ['payment_method', 'balances', 'transactions'])
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('adopted')

    // They disconnect it on the Bank page — a decision, not an accident.
    await db.query(
      `UPDATE bank_connections SET status = 'disconnected' WHERE landlord_id = $1`, [landlordId])

    // Stripe still holds the grant, so without this guard the next look would
    // put the bank straight back. It does not.
    expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('not_readable')
    const rows = await db.query<any>('SELECT status FROM bank_connections WHERE landlord_id = $1', [landlordId])
    expect(rows.rows.map(r => r.status)).toEqual(['disconnected'])
    noStripeWrites(['accounts.subscribe'])
  })

  it('a landlord with no Stripe account at all is sent to step one, as before', async () => {
    const { landlordId } = await landlord()
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('no_stripe_account')
    // Nothing asked, nothing stamped, nothing linked — the page shows step one.
    expect(callsTo('accounts.list')).toHaveLength(0)
    expect(await listConnections(landlordId)).toHaveLength(0)
    const stamped = await db.query<any>('SELECT connect_bank_checked_at FROM landlords WHERE id = $1', [landlordId])
    expect(stamped.rows[0].connect_bank_checked_at).toBeNull()
    noStripeWrites()
  })

  it('an unreachable Stripe claims nothing and does not use up the one ask', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_down' })
    stripeFake.listThrows = Object.assign(new Error('connection error'), { type: 'StripeConnectionError' })
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('unreachable')
    const stamped = await db.query<any>('SELECT connect_bank_checked_at FROM landlords WHERE id = $1', [landlordId])
    expect(stamped.rows[0].connect_bank_checked_at).toBeNull()
    // So the next look asks again rather than waiting out a ten-minute floor
    // that was set by a failure.
    stripeFake.listThrows = null
    connectHeldLink('acct_down', 'fca_down', ['payment_method', 'transactions'])
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('adopted')
    noStripeWrites(['accounts.subscribe'])
  })
})

// ── The fee debit is a different Stripe object, and is not pretended away ───

describe('the fee debit does not fold into the onboarding link', () => {
  it('GAM cannot mint a debit method from a connect-held link, and says why', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_debit' })
    connectHeldLink('acct_debit', 'fca_debit', ['payment_method', 'balances', 'transactions'])
    await ensureOnboardingBankLink(landlordId)

    // The debit is a PLATFORM payment method. Stripe will not build one from a
    // bank account held by a connected account — the platform cannot even
    // retrieve it without that account's header — so this refuses rather than
    // minting something that cannot be charged.
    expect(await createDebitPaymentMethod(landlordId)).toBeNull()
    expect(callsTo('paymentMethods.create')).toHaveLength(0)

    // And the page is told the truth about it, in words, beside the bank.
    const listed = await listConnections(landlordId)
    expect(listed[0].connect_held).toBe(true)
    expect(listed[0].debit_ready).toBe(false)
    expect(listed[0].debit_problem).toMatch(/cannot collect its fees from it/)

    const { debitLinkProblem } = await import('./bankFeed')
    expect(await debitLinkProblem(landlordId)).toMatch(/read it but not collect its fees/)
    noStripeWrites(['accounts.subscribe'])
  })

  it('a platform link still serves the debit when both shapes exist', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_mixed' })
    // The connect-held link is NEWER, which is exactly the order that used to
    // break this: the debit picks the newest active link.
    await platformLink(landlordId, 'fca_mixed_platform', { inst: 'PNC Bank', last4: '9677' })
    connectHeldLink('acct_mixed', 'fca_mixed_connect', ['payment_method', 'transactions'])
    await db.query(
      `INSERT INTO bank_connections
         (landlord_id, provider, stripe_fc_account_id, stripe_connect_account_id,
          institution_name, account_last4, source, fc_permissions, created_at)
       VALUES ($1,'stripe_fc','fca_mixed_connect','acct_mixed','First Mid Bank','8944',
               'connect_onboarding', ARRAY['payment_method','transactions'], now() + interval '1 day')`,
      [landlordId])

    const pm = await createDebitPaymentMethod(landlordId)
    expect(pm).not.toBeNull()
    expect(callsTo('paymentMethods.create')[0].args[0].us_bank_account.financial_connections_account)
      .toBe('fca_mixed_platform')
  })
})


// ── A link in 'error' is still the landlord's feed ──────────────────────────

describe('an errored link is not a free slot for a second one', () => {
  it('a sync failure does not let the connect-held link in as a second row', async () => {
    // Oak Park's exact shape in a post-switch world: a platform-held PNC ••9677
    // feed, plus a connect-held link to the SAME physical account.
    const { landlordId } = await landlord({ connectAccount: 'acct_1U5VpMDz9hhZGjwY' })
    const id = await platformLink(landlordId, 'fca_1UK4iYDNEru9AEpKNlQMWPVZ', { inst: 'PNC Bank', last4: '9677' })
    connectHeldLink('acct_1U5VpMDz9hhZGjwY', 'fca_connect_pnc', ['payment_method', 'balances', 'transactions'],
      { inst: 'PNC Bank', last4: '9677' })

    // One Stripe 502 in the 06:00 sweep writes status='error' on a link that is
    // completely fine. Nothing about the landlord's bank changed.
    await db.query(`UPDATE bank_connections SET status = 'error', last_sync_error = 'Could not sync transactions from the bank' WHERE id = $1`, [id])

    // The old guard read status='active', so the next page render adopted the
    // connect-held link, subscribed it and synced it: two active connections on
    // one bank account, which is the duplicate-row problem S652/S655 fixed.
    expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('already_linked')
    expect(callsTo('accounts.list')).toHaveLength(0)
    const rows = await db.query<any>('SELECT id, status FROM bank_connections WHERE landlord_id = $1', [landlordId])
    expect(rows.rows.map(r => r.status)).toEqual(['error'])
    noStripeWrites()
  })

  it('and the sweep retries it, so one timeout does not park a feed forever', async () => {
    const { landlordId } = await landlord()
    const id = await platformLink(landlordId, 'fca_errored', { inst: 'PNC Bank', last4: '9677' })
    stripeFake.txns['fca_errored'] = [txn('fctxn_heal', -5000, 'ACE HARDWARE', '2026-10-19')]
    await db.query(`UPDATE bank_connections SET status = 'error' WHERE id = $1`, [id])

    const { syncAllActiveConnections } = await import('./bankFeed')
    expect((await syncAllActiveConnections()).inserted).toBe(1)
    const row = (await db.query<any>('SELECT status FROM bank_connections WHERE id = $1', [id])).rows[0]
    expect(row.status).toBe('active')

    // A link the landlord took off the feed on purpose is still never synced.
    await db.query(`UPDATE bank_connections SET status = 'disconnected' WHERE id = $1`, [id])
    expect((await syncAllActiveConnections()).synced).toBe(0)
  })
})

// ── One ask, however many callers ───────────────────────────────────────────

describe('two callers at the same moment', () => {
  const lockKey = (landlordId: string) => `one-bank-link:${landlordId}`

  it('the second one does nothing at all — no Stripe, no row', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_race' })
    connectHeldLink('acct_race', 'fca_race', ['payment_method', 'balances', 'transactions'])

    // OnboardingPage polls the connections endpoint every four seconds while
    // the landlord sits on step 4, and the adopting request (two subscribes and
    // a transaction import) can take longer than that. This is the second poll
    // arriving mid-adoption.
    const holder = await db.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey(landlordId)])
      expect((await ensureOnboardingBankLink(landlordId)).state).toBe('in_flight')
      expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('in_flight')
      expect(callsTo('accounts.list')).toHaveLength(0)
      expect((await db.query('SELECT id FROM bank_connections WHERE landlord_id = $1', [landlordId])).rowCount).toBe(0)
      // And the ask was not spent, so the real adoption still happens.
      const stamped = await db.query<any>('SELECT connect_bank_checked_at FROM landlords WHERE id = $1', [landlordId])
      expect(stamped.rows[0].connect_bank_checked_at).toBeNull()
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey(landlordId)]).catch(() => {})
      holder.release()
    }

    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('adopted')
    noStripeWrites(['accounts.subscribe'])
  })

  it('the ask is claimed BEFORE Stripe is asked, so a slow first call blocks the second', async () => {
    const { landlordId } = await landlord({ connectAccount: 'acct_claim' })
    connectHeldLink('acct_claim', 'fca_claim_pm_only', ['payment_method'])

    // The stamp used to be written after the Stripe read, so two calls that
    // overlapped both read, both stamped and both went on. Now the first call
    // claims the window first: nothing readable, and the next caller is told so
    // without a second billable Financial Connections read.
    expect((await ensureOnboardingBankLink(landlordId)).state).toBe('not_readable')
    const stamped = await db.query<any>('SELECT connect_bank_checked_at FROM landlords WHERE id = $1', [landlordId])
    expect(stamped.rows[0].connect_bank_checked_at).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      expect((await ensureOnboardingBankLink(landlordId)).state).toBe('checked_recently')
    }
    expect(callsTo('accounts.list')).toHaveLength(1)
    noStripeWrites()
  })
})

// ── Whose Stripe account is it ──────────────────────────────────────────────

describe('a Connect account anchored on the user', () => {
  it('is resolved, so the webhook adopts for them too', async () => {
    // S554 allows the account to live on the USER row (the legacy anchoring).
    // The account.updated webhook used to look only at landlords.stripe_connect_account_id,
    // found nobody, and left that landlord staring at a step already done.
    const { landlordId, userId } = await landlord()
    await db.query(`UPDATE users SET stripe_connect_account_id = $2 WHERE id = $1`, [userId, 'acct_on_user'])
    expect(await landlordsForConnectAccount('acct_on_user')).toEqual([landlordId])

    connectHeldLink('acct_on_user', 'fca_on_user', ['payment_method', 'balances', 'transactions'])
    expect((await ensureOnboardingBankLink(landlordId, { force: true })).state).toBe('adopted')
    noStripeWrites(['accounts.subscribe'])
  })

  it('and an account nobody owns resolves to nobody', async () => {
    await landlord({ connectAccount: 'acct_someone' })
    expect(await landlordsForConnectAccount('acct_nobody')).toEqual([])
  })
})

describe('reading a connected account’s links', () => {
  it('reports exactly what Stripe says, readable or not', async () => {
    connectHeldLink('acct_read', 'fca_pm_only', ['payment_method'])
    connectHeldLink('acct_read', 'fca_full', ['payment_method', 'balances', 'transactions'], { last4: '1111' })
    connectHeldLink('acct_read', 'fca_inactive', ['transactions'], { last4: '2222', status: 'inactive' })

    const links = await readConnectHeldLinks('acct_read')
    expect(links.map(l => [l.id, l.readable])).toEqual([
      ['fca_pm_only', false],   // no transactions permission — fixed at link time
      ['fca_full', true],
      ['fca_inactive', false],  // the bank revoked it
    ])
    expect(callsTo('accounts.list')[0].opts).toEqual({ stripeAccount: 'acct_read' })
    noStripeWrites()
  })
})
