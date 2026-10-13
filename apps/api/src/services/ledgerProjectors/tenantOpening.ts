/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY J: THE OPENING POSTING AND
 * HOME SALES (gam-ledger-design-2026-10-12 §6 J1, J2; §15)
 *
 *   Nic 10/12: "history start = LANDLORD'S CHOICE (since joining GAM, or a
 *   start date + opening balances)"; "pre-GAM deposits = LANDLORD'S CHOICE via
 *   opening balances"; L11 home sales: the whole sale at signing (a note owed)
 *   or income as each payment comes in; L16 TruBlu picks its own start date.
 *
 * J1 — THE OPENING POSTING (key `opening:<landlord>`, dated the books start
 * date). The engine posts nothing dated before a company's books start; this
 * one posting carries what came before, so the balance sheet on the start date
 * is what the full history would have left:
 *   (a) every posting the company's projectors want dated before the start,
 *       netted per account and dimension — receivables still open, money GAM
 *       still owes, deposits and paid-ahead money owed — with the income and
 *       expense side, opening equity, "to confirm" suspense and the bank
 *       (10/12 review: a bank opens only from (c)) going to 3900 Opening
 *       balance equity. Home-sale notes are left to (b).
 *   (b) whole_sale_at_signing only: each home sale active before the start
 *       (started or activated before it, not cancelled before it) opens its
 *       note at financed − the principal of every installment billed before
 *       the start, on GAM or paid outside it (TruBlu: the 8 older sales open
 *       at what is still owed; no 2026 home sale is booked).
 *   (c) what the owner entered on the Opening balances step
 *       (books_opening_items): a bank account's balance on its own account,
 *       a deposit the landlord holds (Cr 2020), paid-ahead money the landlord
 *       holds (Cr 2050), anything else on the account the owner named, in that
 *       account's normal sense. An item entered for a different start date
 *       ("stale" on the page) makes the opening wait on the owner.
 *   The rest is 3900, per property, so the posting balances property by
 *   property. Re-projected whenever the start date, a contract, an
 *   installment, an opening item or a books method changes; a closed month
 *   gets the change on its first open day (the engine).
 *
 * J2 — A HOME SALE (key `home_sale:<contract>`), whole_sale_at_signing:
 *   on the day it went active   Dr 1310 note: financed / Dr 1099 the down
 *                               payment ("paid outside GAM, to confirm" — GAM
 *                               never bills it), counted as received /
 *                               Cr 4300 Home sales: the sale price
 *   cancelled after it was active (kind 'cancellation', its own day)
 *                               Dr 1520 Homes held for sale / Cr 1310 what is
 *                               still owed on the note (the home comes back)
 * income_as_paid: only the down payment, as income received on the day it went
 * active (the installments are income as billed, tenantCharges A7).
 * A sale active before the books start opens in J1 instead (only its
 * cancellation after the start posts here). A contract never activated posts
 * nothing. Both wait while the owner has not chosen the method.
 */
import type { PoolClient } from 'pg'
import { LEDGER_ACCOUNT_ROLE_BY_NAME, type LedgerAccountRole } from '@gam/shared'
import {
  type DesiredLine, type DesiredPosting, type LedgerProjector, type LedgerSourceRef,
  LedgerSourceError, registeredLedgerSourceTypes, ledgerProjectorFor,
} from '../ledgerEngine'
import { addDaysIso, type LedgerOwner } from '../ledgerOwner'
import { openingAccountSigns, openingAccountsToEquity } from '../ledgerOpeningAccounts'
import {
  Lines, cSql, centsOf, localDaySql, propertyTzSql, loadCompanyBooks, requireHomeSaleMethod, isUuid, type CompanyBooks,
} from './tenantShared'

export const TENANT_OPENING_RULE_VERSION = 1

/** Source types whose before-the-start postings J1 (a) never nets: home sales open through (b). */
const OPENING_SKIPS = new Set(['opening', 'home_sale', 'home_installment'])
/**
 * Roles J1 (a) leaves to 3900: what came before is equity on the start date,
 * never a "to confirm" item. 10/12 (Nic, ledger review): and the bank. A bank
 * account opens ONLY from the balance the owner enters on the Opening balances
 * step (c, design J1) — that statement balance already holds every payout,
 * matched deposit and slip GAM recorded before the start, so carrying those
 * too would count the money twice (and without an entered balance, the sum of
 * what GAM happened to record is not a bank balance).
 */
const OPENING_TO_EQUITY = new Set<LedgerAccountRole>(['suspense', 'opening_balance_equity', 'interproperty_clearing', 'bank_checking'])

// ─── Home-sale contracts ────────────────────────────────────────────────────

interface Contract {
  id: string; landlord_id: string; unit_id: string; tenant_id: string; lease_id: string | null; property_id: string | null
  status: string; start_month: string; activated_day: string | null; cancelled_day: string | null
  sale_c: string; down_c: string; financed_c: string
}

const CONTRACT_SQL = `
  SELECT c.id, c.landlord_id, c.unit_id, c.tenant_id, c.lease_id, u.property_id, c.status, c.start_month::text AS start_month,
         ${localDaySql('c.activated_at', 'z.tz')} AS activated_day, ${localDaySql('c.cancelled_at', 'z.tz')} AS cancelled_day,
         ${cSql('c.sale_price')} AS sale_c, ${cSql('c.down_payment')} AS down_c, ${cSql('c.financed_amount')} AS financed_c
    FROM home_sale_contracts c
    LEFT JOIN units u ON u.id = c.unit_id
    CROSS JOIN LATERAL (SELECT ${propertyTzSql('u.property_id', 'c.landlord_id')} AS tz) z`

/** Active before the books start: started or activated before it (design J1). */
function preBooks(c: Contract, start: string | null): boolean {
  if (!start || !c.activated_day) return false
  return c.start_month < start || c.activated_day < start
}

/** Principal of the contract's installments billed (a live payments row) or paid outside GAM, optionally before a day. */
async function principalReduced(client: PoolClient, contractId: string, beforeDay: string | null): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT ${cSql(`COALESCE(sum(i.principal_portion), 0)`)} AS c
       FROM home_sale_installments i
      WHERE i.contract_id = $1
        AND ($2::date IS NULL OR i.billing_month < $2::date)
        AND (i.settled_off_platform_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM payments p WHERE p.id = i.payment_id AND p.voided_at IS NULL AND p.status <> 'voided'))`,
    [contractId, beforeDay])
  return centsOf(r.rows[0]?.c)
}

export async function projectHomeSale(client: PoolClient, contractId: string): Promise<DesiredPosting[]> {
  if (!isUuid(contractId)) return []
  const c = (await client.query<Contract>(`${CONTRACT_SQL} WHERE c.id = $1`, [contractId])).rows[0]
  if (!c || !c.activated_day) return []
  const co = await loadCompanyBooks(client, c.landlord_id)
  const method = requireHomeSaleMethod(co)
  const d = { propertyId: c.property_id, unitId: c.unit_id, leaseId: c.lease_id, tenantId: c.tenant_id }
  const out: DesiredPosting[] = []
  const pre = preBooks(c, co.booksStart)

  if (!pre) {
    const L = new Lines()
    const down = centsOf(c.down_c)
    if (method === 'whole_sale_at_signing') {
      const financed = centsOf(c.financed_c)
      L.dr('home_notes_receivable', financed, { ...d, reportCategory: 'home_payments', memo: 'Note owed on the home sale' })
      L.dr('suspense', down, { ...d, memo: 'Down payment paid outside GAM, to confirm' })
      L.cr('home_sales', centsOf(c.sale_c) - down, { ...d, reportCategory: 'home_payments', memo: 'Home sale' })
      L.cr('home_sales', down, { ...d, reportCategory: 'home_payments', cashEffect: 'in', memo: 'Down payment' })
    } else {
      L.dr('suspense', down, { ...d, memo: 'Down payment paid outside GAM, to confirm' })
      L.cr('home_sales', down, { ...d, reportCategory: 'home_payments', cashEffect: 'in', memo: 'Down payment' })
    }
    if (!L.empty) out.push({ owner: { landlordId: c.landlord_id }, intendedDate: c.activated_day, memo: 'Home sale', lines: L.lines })
  }

  if (c.cancelled_day && method === 'whole_sale_at_signing') {
    const owed = centsOf(c.financed_c) - await principalReduced(client, c.id, null)
    if (owed !== 0) {
      const L = new Lines()
      L.dr('homes_held_for_sale', owed, { ...d, memo: 'Home back after the sale was cancelled' })
      L.cr('home_notes_receivable', owed, { ...d, reportCategory: 'home_payments', memo: 'Note closed: sale cancelled' })
      out.push({ owner: { landlordId: c.landlord_id }, postingKind: 'cancellation', intendedDate: c.cancelled_day,
        memo: 'Home sale cancelled', lines: L.lines })
    }
  }
  return out
}

export const homeSaleProjector: LedgerProjector = {
  sourceType: 'home_sale',
  ruleVersion: TENANT_OPENING_RULE_VERSION,
  project: (client, sourceId) => projectHomeSale(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null; last: string | null }>(
      `SELECT x.id, x.activated_day AS day, GREATEST(x.activated_day, x.cancelled_day) AS last
         FROM (${CONTRACT_SQL} WHERE c.landlord_id = $1 AND c.activated_at IS NOT NULL) x`, [owner.landlordId])
    return r.rows.filter(x => !opts.since || !x.last || x.last >= opts.since).map(x => ({ id: x.id, day: x.day }))
  },
}

// ─── J1: the opening posting ────────────────────────────────────────────────

interface NetLine { template: DesiredLine; cents: number }

function netKey(l: DesiredLine): string {
  return JSON.stringify([l.role ?? '', l.accountId ?? '', l.sub?.kind ?? '', l.sub?.value ?? '', l.propertyId ?? '', l.unitId ?? '',
    l.leaseId ?? '', l.tenantId ?? '', l.paymentId ?? '', l.vendorId ?? '', l.taxName ?? ''])
}

/**
 * 10/12 review (ledger P6): does a category's line dated `day` open in 3900?
 * Judged by the account the category charged to that day (its own dated map
 * row, else its starting role's — books_category_account): an income or
 * expense account, a bank, or an account one of OPENING_TO_EQUITY's roles uses
 * (suspense, opening balance equity…) → true; any other account → false (it
 * opens on that account); no account yet (the chart is not set up) → null,
 * and the line's role decides as before.
 */
async function categoryOpensToEquity(client: PoolClient, cache: Map<string, boolean | null>, categoryId: string, day: string): Promise<boolean | null> {
  const key = `${categoryId}|${day}`
  if (cache.has(key)) return cache.get(key)!
  const r = await client.query<{ account_id: string | null }>(
    `SELECT books_category_account($1::uuid, $2::date) AS account_id`, [categoryId, day])
  const accountId = r.rows[0]?.account_id ?? null
  let out: boolean | null = null
  if (accountId) {
    const eq = await openingAccountsToEquity(client, [accountId])
    out = eq.has(accountId) || (await client.query<{ yes: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM books_account_map m
                       WHERE m.account_id = $1 AND m.map_kind = 'role' AND m.map_value = ANY($2::text[])) AS yes`,
      [accountId, [...OPENING_TO_EQUITY]])).rows[0].yes
  }
  cache.set(key, out)
  return out
}

/** (a): every posting the registered projectors want dated before the start, netted. */
async function nettedBeforeStart(client: PoolClient, landlordId: string, start: string): Promise<Map<string, NetLine>> {
  const net = new Map<string, NetLine>()
  const owner: LedgerOwner = { landlordId }
  // 10/12 (Nic, ledger P7): a line that names its account itself (a
  // bookkeeper's journal entry, design J4) follows the same rule as a role's
  // line: an income or expense account, or a bank account, opens in 3900.
  const toEquity = new Map<string, boolean>()
  // 10/12 review: a category's account on a day, judged the same way (cached).
  const categoryEquity = new Map<string, boolean | null>()
  for (const type of registeredLedgerSourceTypes().sort()) {
    if (OPENING_SKIPS.has(type)) continue
    const projector = ledgerProjectorFor(type)!
    const refs = await projector.listSources(client, owner, { since: null })
    for (const ref of refs) {
      // Nothing of it is before the start. 10/12 (Nic, ledger review): a
      // source may list its day on the company's calendar and post on its
      // property's (at most a day apart, companies with properties in more
      // than one timezone) — so only a source listed more than a day past the
      // start is skipped unread; each posting's own day decides below.
      if (ref.day && ref.day > addDaysIso(start, 1)) continue
      let postings: DesiredPosting[]
      try {
        postings = await projector.project(client, ref.id)
      } catch (e) {
        // One listed on or after the start that cannot post yet (waiting on
        // the owner, a missing fact) is left out: it posts on its own when it
        // can, and if its day then turns out to be before the start, that
        // posting marks the opening again (the engine).
        if (ref.day && ref.day >= start) continue
        const msg = `the opening needs ${type} ${ref.id}, which cannot post yet: ${e instanceof Error ? e.message : String(e)}`
        throw new LedgerSourceError(e instanceof LedgerSourceError ? e.reasonCode : 'projector_error', msg)
      }
      for (const p of postings) {
        if (p.owner.landlordId !== landlordId || p.intendedDate >= start) continue
        const unknown = p.lines.filter(l => !l.role && l.accountId && !toEquity.has(l.accountId)).map(l => l.accountId!)
        if (unknown.length) {
          const eq = await openingAccountsToEquity(client, unknown)
          for (const id of unknown) toEquity.set(id, eq.has(id))
        }
        for (const l of p.lines) {
          if (!l.role && l.accountId && toEquity.get(l.accountId)) continue
          if (l.role === 'home_notes_receivable') continue
          // 10/12 review (ledger P6): a category's line posts to the account
          // the category charged to THAT DAY, which may be any account of the
          // chart (an owner's "Capital improvements" pointed at Equipment, a
          // money-in category on a liability) — so it is judged by that
          // account, never by its starting role's type. An income or expense
          // account, or a bank, opens in 3900; anything else opens on itself.
          const cat = l.sub && (l.sub.kind === 'expense_category' || l.sub.kind === 'income_category') ? l.sub.value : null
          if (cat) {
            const eq = await categoryOpensToEquity(client, categoryEquity, cat, p.intendedDate)
            if (eq === true) continue
            if (eq === false) {
              const k = netKey(l)
              const e = net.get(k) ?? { template: l, cents: 0 }
              e.cents += (l.debitCents ?? 0) - (l.creditCents ?? 0)
              net.set(k, e)
              continue
            }
            // eq null: the company's chart is not set up — the role decides, below.
          }
          if (l.role && OPENING_TO_EQUITY.has(l.role)) continue   // bank sub-accounts too (any `sub`)
          if (l.role) {
            const accountType = LEDGER_ACCOUNT_ROLE_BY_NAME[l.role]?.type
            if (accountType === 'income' || accountType === 'expense') continue
          }
          const k = netKey(l)
          const e = net.get(k) ?? { template: l, cents: 0 }
          e.cents += (l.debitCents ?? 0) - (l.creditCents ?? 0)
          net.set(k, e)
        }
      }
    }
  }
  return net
}

export async function projectOpening(client: PoolClient, landlordId: string): Promise<DesiredPosting[]> {
  if (!isUuid(landlordId)) return []
  const co: CompanyBooks = await loadCompanyBooks(client, landlordId)
  if (!co.booksStart) return []
  const start = co.booksStart
  const L = new Lines()

  // (a) what the history before the start leaves on the balance sheet.
  for (const e of [...(await nettedBeforeStart(client, landlordId, start)).values()]) {
    const t = e.template
    const dims = {
      propertyId: t.propertyId ?? null, unitId: t.unitId ?? null, leaseId: t.leaseId ?? null, tenantId: t.tenantId ?? null,
      paymentId: t.paymentId ?? null, vendorId: t.vendorId ?? null, taxName: t.taxName ?? null, sub: t.sub,
      reportCategory: 'opening' as const, memo: 'Before the books start',
    }
    if (t.accountId) L.drAccount(t.accountId, e.cents, dims)
    else L.dr(t.role!, e.cents, dims)
  }

  // (b) home-sale notes owed on the start date (whole sale at signing only).
  const contracts = (await client.query<Contract>(
    `${CONTRACT_SQL} WHERE c.landlord_id = $1 AND c.activated_at IS NOT NULL`, [landlordId])).rows
    .filter(c => preBooks(c, start) && !(c.cancelled_day && c.cancelled_day < start))
  if (contracts.length) {
    const method = requireHomeSaleMethod(co)
    if (method === 'whole_sale_at_signing') {
      for (const c of contracts) {
        const owed = centsOf(c.financed_c) - await principalReduced(client, c.id, start)
        L.dr('home_notes_receivable', owed, {
          propertyId: c.property_id, unitId: c.unit_id, leaseId: c.lease_id, tenantId: c.tenant_id,
          reportCategory: 'opening', memo: 'Home-sale note owed on the books start date',
        })
      }
    }
  }

  // (c) what the owner entered on the Opening balances step.
  const items = (await client.query<{
    kind: string; c: string; lease_id: string | null; tenant_id: string | null; property_id: string | null
    bank_connection_id: string | null; account_id: string | null; as_of: string; paid_on: string | null
  }>(
    `SELECT o.kind, ${cSql('o.amount')} AS c, o.lease_id, o.tenant_id, o.as_of::text AS as_of, o.paid_on::text AS paid_on,
            COALESCE(o.property_id, (SELECT u.property_id FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = o.lease_id)) AS property_id,
            o.bank_connection_id, o.account_id
       FROM books_opening_items o
      WHERE o.landlord_id = $1 AND o.voided_at IS NULL
      ORDER BY o.entered_at, o.id`, [landlordId])).rows
  // 10/12 (Nic, ledger review): an item entered for a different start date
  // (the owner moved the start after entering it — the page marks it "stale",
  // services/booksSettings) is not this start date's balance: a bank balance
  // as of 8/1 is not the 10/1 balance, and a deposit paid after the start is
  // not one held before it. The opening waits on the owner (no admin notice)
  // until they enter it again for the start date, or void it.
  const stale = items.filter(i => i.as_of !== start || (i.kind === 'deposit_held' && !!i.paid_on && i.paid_on > start))
  if (stale.length) {
    throw new LedgerSourceError('owner_not_ready',
      `Waiting on the owner: ${stale.length} opening balance(s) on the Opening balances step were entered for a different books start date than ${start}. Enter them again for the start date, or void them.`)
  }
  const signs = await openingAccountSigns(client, items.filter(i => i.kind === 'other' && i.account_id).map(i => i.account_id!))
  for (const i of items) {
    const cents = centsOf(i.c)
    const dims = { propertyId: i.property_id, leaseId: i.lease_id, tenantId: i.tenant_id, reportCategory: 'opening' as const }
    switch (i.kind) {
      case 'bank':
        if (!i.bank_connection_id) break
        L.dr('bank_checking', cents, { ...dims, sub: { kind: 'bank_connection', value: i.bank_connection_id }, memo: 'Bank balance on the books start date' })
        break
      case 'deposit_held':
        L.cr('security_deposits_payable', cents, { ...dims, memo: 'Deposit you hold from before the books start' })
        break
      case 'paid_ahead_held':
        L.cr('tenant_prepayments', cents, { ...dims, memo: 'Paid-ahead money you hold from before the books start' })
        break
      case 'other': {
        if (!i.account_id) break
        const sign = signs.get(i.account_id)
        if (!sign) throw new LedgerSourceError('missing_fact', `Opening balance account ${i.account_id} does not exist.`)
        L.drAccount(i.account_id, sign * cents, { ...dims, memo: 'Opening balance' })
        break
      }
    }
  }

  // The rest is opening balance equity, property by property.
  for (const [k, n] of [...L.netByProperty().entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    L.cr('opening_balance_equity', n, { propertyId: k === '' ? null : k, reportCategory: 'opening', memo: 'Opening balance equity' })
  }
  if (L.empty) return []
  return [{ owner: { landlordId }, intendedDate: start, memo: 'Opening balances on the books start date', lines: L.lines }]
}

export const openingProjector: LedgerProjector = {
  sourceType: 'opening',
  ruleVersion: TENANT_OPENING_RULE_VERSION,
  project: (client, sourceId) => projectOpening(client, sourceId),
  async listSources(client, owner: LedgerOwner): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ d: string | null }>(`SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [owner.landlordId])
    const d = r.rows[0]?.d
    return d ? [{ id: owner.landlordId, day: d }] : []
  },
}
