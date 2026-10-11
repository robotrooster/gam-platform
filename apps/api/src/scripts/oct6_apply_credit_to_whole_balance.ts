/**
 * 10/6 (Nic) — money paid ahead put against the WHOLE balance, where it was
 * left sitting beside bills it could have paid.
 *
 *   "Credits need to not settle by line item. It needs to be a credit against
 *    the entire balance ... So why the hell would the credit not be applied to
 *    the entire balance? Why is it trying to settle line items? ... his
 *    outstanding balance is really only $17.64." And: "he's not going to get
 *    any late fees so we need to remove that $30."
 *
 * Marc Renspurger (Mountain View RV 52): a $600 check in September paid
 * September and left $297.06 paid ahead. On Oct 1 the old per-line draw paid
 * the $14.70 electric in full and skipped the $300 rent because the $282.36
 * left could not cover that whole line; the rent stayed open and six $5 late
 * fees were charged on it. The live rule now (creditUse.drawPaidAheadOnBalance)
 * puts paid-ahead money on the balance oldest bill first, part of a line where
 * it runs out. This script does, once, what that rule would have done:
 *
 * For every household (a person with one company) that has paid-ahead money
 * left on a lease while a bill line on that lease it could pay is open:
 *   1. LATE FEES ZEROED (never deleted — the fee stays on the bill at $0.00,
 *      settled, with the reason on it): an unpaid late fee on such a bill when
 *        (a) the paid-ahead money received by the day the bill was issued
 *            would have paid every other line of the bill AS ISSUED in full
 *            — judged on the bill's original charges at their full amounts
 *            (a slice the tenant later paid with their own money still
 *            counts as owed), less only credit already applied to them, and
 *            within the lease's monthly draw limit for that month, oldest
 *            bill first. The fee was charged only because the money was left
 *            beside the bill; or
 *        (b) the bill is marked late-fee exempt AND its household is one Nic
 *            named (`zeroExemptFor`; the command line names Marc's) — no late
 *            fee should have been charged on it at all (Marc's October bill:
 *            "we need to remove that $30"). On any other household a fee on
 *            an exempt bill is LISTED: the exemption may have been stamped for
 *            a reason that has nothing to do with the credit (work trade).
 *      Any other unpaid late fee on such a bill (the bill would still have
 *      owed something after the money) is LISTED, not touched, for Nic.
 *   2. THE MONEY APPLIED: the live rule runs for the household
 *      (creditUse.settleWholeBillIfCovered — the whole-bill rule, then the
 *      paid-ahead draw: oldest bill first, part of a line where it runs out,
 *      the month's draw cap kept). No email goes out.
 *   3. Landlord-issued credit and deposit interest beside an open bill are
 *      LISTED only: they are the payer's "Use" or "Save" unless they cover the
 *      whole bill (the live rule already applies that case in step 2).
 * Every change is printed per household. Run twice, the second run finds
 * nothing (the money is spent, the fees are at $0.00).
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back,
 * and nothing is written outside it (no admin alert, no email). --apply
 * commits. NEVER run against production without Nic's word.
 *   cd apps/api && npx ts-node -T src/scripts/oct6_apply_credit_to_whole_balance.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct6_apply_credit_to_whole_balance.ts --apply
 *   --zero-exempt-for=<tenant id>[,<tenant id>…] replaces the households
 *   rule (b) applies to (default: Marc Renspurger, the one Nic named).
 */
import type { PoolClient } from 'pg'
import { lockHousehold, payableRowSql, creditEligibleRowSql } from '../services/moneyPredicates'
import { householdQuote, settleWholeBillIfCovered, paidAheadDrawnByMonth, type HouseholdQuote } from '../services/creditUse'

/**
 * The households Nic named whose late-fee-exempt bill's fees come off (rule
 * b): Marc Renspurger, Mountain View RV 52 — "we need to remove that $30".
 */
export const NIC_NAMED_EXEMPT_BILL_TENANTS: readonly string[] = ['c7a6ebe8-cfc9-4c99-9921-b219bd82829a']

/** The reason written on a late fee zeroed because the money paid ahead should have paid its bill. */
export const CREDIT_SHOULD_HAVE_PAID_NOTE = 'Came off: money they paid ahead should have paid this bill (10/6)'
/** The reason written on a late fee zeroed because its bill is late-fee exempt. */
export const EXEMPT_BILL_NOTE = 'Came off: this bill is late-fee exempt (10/6)'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
const money = (c: number): string => `$${toDollars(c).toFixed(2)}`

export interface HouseholdFix {
  tenantId: string
  landlordId: string
  name: string
  owedBefore: number
  owedAfter: number
  paidAheadBefore: number
  paidAheadAfter: number
  /** Credit put on the balance, per charge (cents → dollars). */
  applied: Array<{ paymentId: string; label: string; amount: number; rowAmount: number; nowOwed: number }>
  /** Rows the money settled in full. */
  settledIds: string[]
  zeroed: Array<{ paymentId: string; invoiceId: string; dueDate: string; amount: number; why: 'credit_would_have_paid' | 'exempt_bill' }>
  listed: Array<{ paymentId: string; invoiceId: string; dueDate: string; amount: number; why: string }>
}

export interface ApplyCreditReport {
  households: HouseholdFix[]
  /** Landlord-issued credit / deposit interest sitting beside an open bill: listed, never spent here. */
  otherCredit: Array<{ tenantId: string; landlordId: string; name: string; credit: number; owed: number }>
}

/** Money owed now (cents): every required row, less credit already on it. */
function owedCents(q: HouseholdQuote): number {
  return q.leases.reduce((t, l) => t + l.rows.filter(r => r.required)
    .reduce((s, r) => s + Math.max(0, toCents(r.amount) - toCents(r.appliedOnRow)), 0), 0)
}
const paidAheadCents = (q: HouseholdQuote): number =>
  q.credits.filter(c => c.kind === 'paid_ahead').reduce((t, c) => t + toCents(c.amountRemaining), 0)

async function nameOf(client: PoolClient, tenantId: string): Promise<string> {
  const r = await client.query<{ n: string | null }>(
    `SELECT NULLIF(btrim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS n
       FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
  return r.rows[0]?.n ?? tenantId
}

/**
 * The late fees on this household's bills, decided per the header: zero (a)
 * or (b), or list. Paid-ahead money is lease-bound, so each lease's bills are
 * walked oldest first against that lease's money, each credit counting only
 * for bills issued on or after the day it was received, and never more than
 * the lease's monthly draw limit leaves for the bill's month.
 */
async function decideLateFees(client: PoolClient, tenantId: string, leaseIds: readonly string[], zeroExempt: boolean): Promise<{
  zero: HouseholdFix['zeroed']; list: HouseholdFix['listed']
}> {
  const zero: HouseholdFix['zeroed'] = []
  const list: HouseholdFix['listed'] = []
  for (const leaseId of leaseIds) {
    const credits = (await client.query<{ id: string; remaining: string; received_at: Date }>(
      `SELECT c.id, c.amount_remaining::text AS remaining, c.received_at
         FROM lease_prepaid_credits c
        WHERE c.lease_id = $1 AND c.voided_at IS NULL AND c.amount_remaining > 0
        ORDER BY c.received_at, c.created_at, c.id`, [leaseId])).rows
      .map(c => ({ id: c.id, left: toCents(c.remaining), receivedAt: new Date(c.received_at).getTime() }))
    if (credits.length === 0) continue
    // The lease's monthly draw limit (NULL: none), and what money paid ahead
    // already drew per billing month — the live rule's own figures.
    const cap = (await client.query<{ cap: string | null }>(
      `SELECT prepaid_monthly_draw::text AS cap FROM leases WHERE id = $1`, [leaseId])).rows[0]?.cap ?? null
    const drawn = await paidAheadDrawnByMonth(client, [leaseId])
    const capSpent = new Map<string, number>()
    const bills = (await client.query<{ id: string; created_at: Date; late_fee_exempt: boolean; due_date: string; month: string }>(
      `SELECT DISTINCT i.id, i.created_at, i.late_fee_exempt, i.due_date::text AS due_date,
              to_char(date_trunc('month', i.due_date), 'YYYY-MM-DD') AS month
         FROM invoices i JOIN payments p ON p.invoice_id = i.id
        WHERE i.lease_id = $1 AND ${payableRowSql('p')}
        ORDER BY due_date, i.created_at, i.id`, [leaseId])).rows
    for (const b of bills) {
      // Every line of the bill as issued — paid or not, at its full amount (a
      // rent split by a part payment counts both halves) — so money the tenant
      // paid later never makes the credit look like it would have covered it.
      const rows = (await client.query<{
        id: string; type: string; amount: string; due_date: string; payable: boolean; eligible: boolean; kind_eligible: boolean
        on_it: string; intent: string | null; issued: string; held: string
      }>(
        `SELECT p.id, p.type, p.amount::text AS amount, p.due_date::text AS due_date,
                ${payableRowSql('p')} AS payable,
                ${creditEligibleRowSql('p')} AS eligible,
                (p.revenue_owner = 'landlord' AND p.type IN ('rent','utility','fee')
                 AND p.entry_description NOT IN ('FLEXPAY','HOMEPMT')
                 AND p.unit_id IS NOT NULL AND p.lease_id IS NOT NULL) AS kind_eligible,
                (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'applied')::text AS on_it,
                (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'held')::text AS held,
                p.stripe_payment_intent_id AS intent, p.issued_credit_amount::text AS issued
           FROM payments p
          WHERE p.invoice_id = $1 AND p.reversal_id IS NULL AND p.amount > 0
            AND p.status IN ('pending','failed','processing','settled','paid_via_deposit')
            AND p.type <> 'carried_balance'
            AND (p.tenant_id = $2 OR EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = $3 AND lt.tenant_id = $2
                                               AND lt.status IN ('active','pending_add','pending_remove')))
          ORDER BY p.due_date, p.created_at, p.id`, [b.id, tenantId, leaseId])).rows
      const fees = rows.filter(r => r.type === 'late_fee' && r.payable)
      const base = rows.filter(r => r.type !== 'late_fee')
      // What the bill asked, less only credit already applied to it.
      const baseOwed = base.reduce((t, r) => t + Math.max(0, toCents(r.amount) - toCents(r.on_it)), 0)
      // What the money received by the day this bill was issued could still
      // pay, within what the monthly limit leaves for the bill's month.
      const issued = new Date(b.created_at).getTime()
      let avail = credits.filter(c => c.receivedAt <= issued).reduce((t, c) => t + c.left, 0)
      if (cap != null) {
        const key = `${leaseId}|${b.month}`
        const capLeft = Math.max(0, toCents(cap) - toCents(drawn.get(key) ?? 0) - (capSpent.get(b.month) ?? 0))
        avail = Math.min(avail, capLeft)
      }
      const wouldHavePaid = base.length > 0 && base.every(r => (r.payable ? r.eligible : r.kind_eligible)) && avail >= baseOwed
      // Spend it on this bill (oldest bill first), so a later bill sees what is left.
      let need = Math.min(baseOwed, avail)
      capSpent.set(b.month, (capSpent.get(b.month) ?? 0) + need)
      for (const c of credits) {
        if (need <= 0) break
        if (c.receivedAt > issued) continue
        const take = Math.min(c.left, need)
        c.left -= take
        need -= take
      }
      for (const f of fees) {
        const untouched = f.intent === null && toCents(f.on_it) === 0 && toCents(f.held) === 0 && toCents(f.issued) === 0
        const fee = { paymentId: f.id, invoiceId: b.id, dueDate: f.due_date.slice(0, 10), amount: toDollars(toCents(f.amount)) }
        if (!untouched) {
          list.push({ ...fee, why: 'money or credit is already on it' })
        } else if (b.late_fee_exempt && zeroExempt) {
          zero.push({ ...fee, why: 'exempt_bill' })
        } else if (wouldHavePaid) {
          zero.push({ ...fee, why: 'credit_would_have_paid' })
        } else if (b.late_fee_exempt) {
          list.push({ ...fee, why: 'the bill is marked late-fee exempt, but not for a reason Nic named — look before taking it off' })
        } else {
          list.push({ ...fee, why: 'the bill would still have owed money after the money paid ahead' })
        }
      }
    }
  }
  return { zero, list }
}

/**
 * Inside the caller's transaction. `only` narrows to these tenants (tests and
 * a careful first run); otherwise every household the header describes.
 */
export async function applyCreditToWholeBalance(client: PoolClient, only?: {
  tenantIds?: readonly string[]
  /** The households rule (b) applies to (late-fee-exempt bills Nic named). None by default. */
  zeroExemptFor?: readonly string[]
}): Promise<ApplyCreditReport> {
  const households = (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT DISTINCT c.tenant_id, l.landlord_id
       FROM lease_prepaid_credits c
       JOIN leases l ON l.id = c.lease_id
      WHERE c.voided_at IS NULL AND c.amount_remaining > 0
        AND ($1::uuid[] IS NULL OR c.tenant_id = ANY($1::uuid[]))
        AND EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = c.lease_id AND ${creditEligibleRowSql('p')})
      ORDER BY c.tenant_id, l.landlord_id`, [only?.tenantIds ? [...only.tenantIds] : null])).rows
  const report: ApplyCreditReport = { households: [], otherCredit: [] }
  for (const h of households) {
    await lockHousehold(client, h.tenant_id, h.landlord_id)
    const before = await householdQuote(client, { tenantId: h.tenant_id, landlordId: h.landlord_id, lock: true, includeReleasable: false })
    const paidAheadLeases = [...new Set(before.credits.filter(c => c.kind === 'paid_ahead' && c.leaseId).map(c => c.leaseId!))]
    const { zero, list } = await decideLateFees(client, h.tenant_id, paidAheadLeases, (only?.zeroExemptFor ?? []).includes(h.tenant_id))
    for (const z of zero) {
      const u = await client.query(
        `UPDATE payments
            SET amount = 0, status = 'settled', settled_at = NOW(), next_retry_at = NULL,
                notes = COALESCE(notes || ' — ', '') || $2
          WHERE id = $1 AND type = 'late_fee' AND status IN ('pending','failed') AND stripe_payment_intent_id IS NULL
            AND issued_credit_amount = 0
            AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = payments.id AND u.status IN ('held','applied'))`,
        [z.paymentId, z.why === 'exempt_bill' ? EXEMPT_BILL_NOTE : CREDIT_SHOULD_HAVE_PAID_NOTE])
      if ((u.rowCount ?? 0) !== 1) throw new Error(`late fee ${z.paymentId} changed while it was being zeroed`)
    }
    const owedMid = await householdQuote(client, { tenantId: h.tenant_id, landlordId: h.landlord_id, lock: true, includeReleasable: false })
    const usesBefore = new Map<string, number>()
    for (const l of owedMid.leases) for (const r of l.rows) usesBefore.set(r.id, toCents(r.appliedOnRow))
    // The live rule, no email and no admin alert (a data fix tells nobody
    // anything by itself, and a dry run must leave nothing behind: alerts are
    // written outside this transaction).
    const wb = await settleWholeBillIfCovered(client, { tenantId: h.tenant_id, landlordId: h.landlord_id, receipt: false, alerts: false })
    const after = await householdQuote(client, { tenantId: h.tenant_id, landlordId: h.landlord_id, lock: true, includeReleasable: false })
    const midRows = owedMid.leases.flatMap(l => l.rows)
    const applied: HouseholdFix['applied'] = []
    if (midRows.length > 0) {
      const now = await client.query<{ id: string; on_it: string; type: string; amount: string }>(
        `SELECT p.id, p.type, p.amount::text AS amount,
                (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'applied')::text AS on_it
           FROM payments p WHERE p.id = ANY($1::uuid[]) ORDER BY p.due_date, p.created_at, p.id`, [midRows.map(r => r.id)])
      for (const r of now.rows) {
        const add = toCents(r.on_it) - (usesBefore.get(r.id) ?? 0)
        if (add <= 0) continue
        applied.push({
          paymentId: r.id, label: r.type, amount: toDollars(add), rowAmount: toDollars(toCents(r.amount)),
          nowOwed: toDollars(Math.max(0, toCents(r.amount) - toCents(r.on_it))),
        })
      }
    }
    if (zero.length === 0 && applied.length === 0 && wb.settledIds.length === 0 && list.length === 0) continue
    report.households.push({
      tenantId: h.tenant_id, landlordId: h.landlord_id, name: await nameOf(client, h.tenant_id),
      owedBefore: toDollars(owedCents(before)), owedAfter: toDollars(owedCents(after)),
      paidAheadBefore: toDollars(paidAheadCents(before)), paidAheadAfter: toDollars(paidAheadCents(after)),
      applied, settledIds: wb.settledIds, zeroed: zero, listed: list,
    })
  }

  // Step 3: other credit beside an open bill — listed only.
  const others = (await client.query<{ tenant_id: string; landlord_id: string; credit: string }>(
    `SELECT tc.tenant_id, tc.landlord_id, SUM(tc.amount_remaining)::text AS credit
       FROM tenant_credits tc
      WHERE tc.status = 'active' AND tc.amount_remaining > 0
        AND ($1::uuid[] IS NULL OR tc.tenant_id = ANY($1::uuid[]))
        AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.landlord_id = tc.landlord_id AND ${creditEligibleRowSql('p')}
                       AND (p.tenant_id = tc.tenant_id OR p.lease_id = tc.lease_id))
      GROUP BY tc.tenant_id, tc.landlord_id
      ORDER BY tc.tenant_id, tc.landlord_id`, [only?.tenantIds ? [...only.tenantIds] : null])).rows
  for (const o of others) {
    const q = await householdQuote(client, { tenantId: o.tenant_id, landlordId: o.landlord_id, includeReleasable: false })
    const owed = owedCents(q)
    if (owed <= 0) continue
    report.otherCredit.push({
      tenantId: o.tenant_id, landlordId: o.landlord_id, name: await nameOf(client, o.tenant_id),
      credit: toDollars(toCents(o.credit)), owed: toDollars(owed),
    })
  }
  return report
}

export function printApplyCreditReport(r: ApplyCreditReport, log: (s: string) => void = console.log): void {
  log(`${r.households.length} household(s) with money paid ahead beside an open bill.`)
  for (const h of r.households) {
    log(`\n${h.name} (tenant ${h.tenantId}, company ${h.landlordId})`)
    log(`  owed ${money(toCents(h.owedBefore))} → ${money(toCents(h.owedAfter))}; paid ahead ${money(toCents(h.paidAheadBefore))} → ${money(toCents(h.paidAheadAfter))}`)
    for (const z of h.zeroed) {
      log(`  late fee ${z.paymentId} (due ${z.dueDate}, bill ${z.invoiceId}): ${money(toCents(z.amount))} ZEROED — ` +
        (z.why === 'exempt_bill' ? 'the bill is late-fee exempt' : 'the money paid ahead would have paid this bill in full'))
    }
    for (const a of h.applied) {
      log(`  ${a.label} ${a.paymentId}: ${money(toCents(a.amount))} of paid-ahead money applied (line ${money(toCents(a.rowAmount))}, still owed ${money(toCents(a.nowOwed))})`)
    }
    if (h.settledIds.length) log(`  paid in full: ${h.settledIds.join(', ')}`)
    for (const l of h.listed) {
      log(`  LISTED, not touched — late fee ${l.paymentId} (due ${l.dueDate}, bill ${l.invoiceId}) ${money(toCents(l.amount))}: ${l.why}`)
    }
  }
  if (r.otherCredit.length) {
    log(`\nCredit the landlord gave (or deposit interest) beside an open bill — not spent here; it is offered when they pay:`)
    for (const o of r.otherCredit) log(`  ${o.name} (tenant ${o.tenantId}): ${money(toCents(o.credit))} credit, ${money(toCents(o.owed))} owed`)
  }
}

if (require.main === module) {
  ;(async () => {
    const apply = process.argv.includes('--apply')
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    try {
      await c.query('BEGIN')
      const named = process.argv.find(a => a.startsWith('--zero-exempt-for='))
      const zeroExemptFor = named
        ? named.slice('--zero-exempt-for='.length).split(',').map(x => x.trim()).filter(Boolean)
        : NIC_NAMED_EXEMPT_BILL_TENANTS
      const r = await applyCreditToWholeBalance(c, { zeroExemptFor })
      printApplyCreditReport(r)
      if (apply) { await c.query('COMMIT'); console.log('\nCOMMITTED') }
      else { await c.query('ROLLBACK'); console.log('\nDRY RUN — rolled back. --apply to commit.') }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      console.error(e instanceof Error ? e.message : e)
      code = 1
    } finally {
      c.release()
    }
    process.exit(code)
  })()
}
