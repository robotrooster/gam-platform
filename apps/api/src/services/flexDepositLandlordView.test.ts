/**
 * ── 10/28 (Nic): THE LANDLORD'S VIEW OF A FLEXDEPOSIT DEPOSIT ───────────────
 *
 *   "The deposit on the landlord's books is going to show paid in full when the
 *    tenant pays their first installment of flex deposit. On our books, they
 *    still owe. On the landlord's books, it's paid in full. That's the
 *    difference they need to see. The tenant still sees that they owe. We still
 *    see that they owe. The landlord sees a paid in full situation. But they
 *    only get that when the first payment happens."
 *
 * Three views of one deposit, and this file is the landlord's. It is the view
 * that has to LIE BY OMISSION without ever lying about an amount: the deposit
 * reads in full and reads settled from the first installment, and the plan's
 * other collections — which are the same dollars arriving later, plus GAM's own
 * revenue — are not theirs to see or to count.
 *
 * Both of the landlord's money surfaces are asserted together on purpose. The
 * bill they print (openBillsFor) and the Outstanding list the front desk works
 * from (listOpenTenantBalances) are separate definitions, and a plan that reads
 * paid in full on one and still owing on the other is the bug this guards.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant,
} from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'
import { openBillsFor, OWED_TO_GAM, NOT_ON_A_BILL } from './openBills'
import { listOpenTenantBalances } from './openBalances'

beforeEach(async () => { await cleanupAllSchema() })

const DEPOSIT_TOTAL = 2000      // the whole deposit the landlord is owed
const INSTALLMENT = 500         // four of them
const SERVICE_FEE = 124         // GAM's, whole, riding installment 1
let seq = 0

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A move-in exactly as jobs/moveInBundle writes it under FlexDeposit: rent and
 * fees in full, the deposit's ONLY invoice line is installment 1, and the
 * plan's other collections carry no invoice_id.
 */
async function flexDepositMoveIn(opts: { settleInstallment1?: boolean; installment1Status?: string } = {}) {
  return inTx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number='RV 44' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const due = todayIn(null)

    const dep = await c.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by,
          flex_deposit_enabled, installment_count, installment_amount, installments_remaining,
          flex_deposit_plan_status, flex_deposit_service_fee)
       VALUES ($1,$2,$3,$4,0,'pending','gam_escrow',TRUE,4,$5,4,'active',$6) RETURNING id`,
      [unitId, leaseId, tenantId, DEPOSIT_TOTAL, INSTALLMENT, SERVICE_FEE])
    const depositId = dep.rows[0].id

    const inv = await c.query<{ id: string }>(
      // The stored total is what the TENANT owes today: rent + fees + installment 1.
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-FD-${++seq}`, due, 440 + 75 + INSTALLMENT])
    const invoiceId = inv.rows[0].id

    const charge = async (o: {
      type: string; amount: number; entry: string; notes?: string | null
      onInvoice?: boolean; gam?: boolean; names?: boolean; status?: string
    }) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO payments
           (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            due_date, entry_description, notes, revenue_owner, flex_deposit_security_deposit_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$9::date) RETURNING id`,
        [o.onInvoice ? invoiceId : null, unitId, leaseId, tenantId, ll.landlordId,
         o.type, o.amount, o.status ?? 'pending', due, o.entry, o.notes ?? null,
         o.gam ? 'gam' : 'landlord', o.names ? depositId : null])
      return r.rows[0].id
    }

    // The landlord's own charges, untouched by the plan.
    await charge({ type: 'rent', amount: 440, entry: 'RENT', onInvoice: true })
    await charge({ type: 'fee', amount: 75, entry: 'OTHERFEE', notes: 'Pet fee', onInvoice: true })
    // The deposit's one line on the bill — installment 1, naming its deposit.
    const inst1 = await charge({
      type: 'deposit', amount: INSTALLMENT, entry: 'DEPOSIT', onInvoice: true, names: true,
      notes: 'Security deposit — installment 1 of 4',
      status: opts.installment1Status ?? (opts.settleInstallment1 ? 'settled' : 'pending'),
    })
    // GAM's whole service fee, riding the first collection. Off the invoice.
    await charge({ type: 'fee', amount: SERVICE_FEE, entry: 'FLEXDEP', gam: true, names: true,
      notes: `FlexDeposit service fee (deposit ${depositId})` })
    // Installments 2..4, as the cron writes them when each comes due. Off the invoice.
    for (const n of [2, 3, 4]) {
      await charge({ type: 'deposit', amount: INSTALLMENT, entry: 'DEPOSIT', names: true,
        notes: `FlexDeposit installment primary pull (deposit ${depositId}) — ${n} of 4` })
    }
    return { ...ll, propertyId, unitId, leaseId, tenantId, invoiceId, depositId, inst1 }
  })
}

const landlordsBill = (m: Awaited<ReturnType<typeof flexDepositMoveIn>>) =>
  openBillsFor({
    tenantIds: [m.tenantId], landlordIds: [m.landlordId],
    scopedPropertyIds: null, seesWorkTrade: true,
  })

describe("the deposit on a landlord's bill", () => {
  it('reads the WHOLE deposit, not the installment, before anything is paid', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const bill = bills.find(b => b.id === m.invoiceId)!
    const deposit = bill.lines.find(l => l.type === 'deposit')!

    expect(Number(deposit.amount)).toBe(DEPOSIT_TOTAL)
    expect(deposit.label).toBe('Security deposit')
    // Their bill is the whole move-in: rent + fee + the full deposit.
    expect(bill.balance).toBe(440 + 75 + DEPOSIT_TOTAL)
    expect(bill.total_amount).toBe(440 + 75 + DEPOSIT_TOTAL)
  })

  it('reads PAID IN FULL the moment the FIRST installment settles', async () => {
    const m = await flexDepositMoveIn({ settleInstallment1: true })
    const { bills } = await landlordsBill(m)
    const bill = bills.find(b => b.id === m.invoiceId)!
    const deposit = bill.lines.find(l => l.type === 'deposit')!

    expect(deposit.open).toBe(false)
    expect(deposit.paid).toBe(DEPOSIT_TOTAL)
    // Nothing of the deposit is still owed them — only the rent and the fee.
    expect(bill.balance).toBe(440 + 75)
    expect(bill.amount_paid).toBe(DEPOSIT_TOTAL)
  })

  it('says nothing about installments, plans or deferrals', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const deposit = bills.find(b => b.id === m.invoiceId)!.lines.find(l => l.type === 'deposit')!

    // The row's own note says "installment 1 of 4"; chargeDetail would print it.
    expect(deposit.detail).toBeNull()
    const words = JSON.stringify(bills).toLowerCase()
    for (const w of ['installment', 'flexdeposit', 'flex deposit', 'deferral', 'plan']) {
      expect(words).not.toContain(w)
    }
  })

  it('counts one deposit, however many collections the plan writes', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const deposits = bills.flatMap(b => b.lines).filter(l => l.type === 'deposit')

    expect(deposits).toHaveLength(1)
    const owed = bills.reduce((t, b) => t + b.balance, 0)
    expect(owed).toBe(440 + 75 + DEPOSIT_TOTAL)
  })
})

describe("GAM's own charge on a landlord's bill", () => {
  it('is worded generically and names no product', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const gam = bills.flatMap(b => b.lines).filter(l => l.gam)

    expect(gam).toHaveLength(1)
    expect(gam[0].label).toBe(OWED_TO_GAM)
    expect(gam[0].detail).toBeNull()
    expect(Number(gam[0].amount)).toBe(SERVICE_FEE)
  })

  /**
   * 10/29 (Nic, after saying it four times): the wording names the RESIDENT as
   * the one who owes it. "Owed to GAM" let a landlord read their own bill two
   * wrong ways — as money coming to them, or as money GAM was about to take
   * off them. Asserted as the literal string, not through the constant, so a
   * re-word that loses "Tenant" fails here instead of in front of a landlord.
   */
  it('says the TENANT owes it, not the landlord', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const gam = bills.flatMap(b => b.lines).filter(l => l.gam)

    expect(gam[0].label).toBe('Tenant owes GAM')
    expect(OWED_TO_GAM).toBe('Tenant owes GAM')
  })

  /**
   * 10/29 (Nic, on FlexCredit): the same wording carries every Flex line a
   * landlord can see — "Anything owed to GAM is going to say the same thing" —
   * and a line that is not a FlexDeposit collection may say what it is
   * underneath: "the little sub description can say something else, like
   * having this payment reported on your credit... As long as there's both
   * things on there". FlexDeposit's own rows stay silent (above); nothing else
   * does.
   */
  it('lets a non-FlexDeposit GAM line keep its description', async () => {
    const m = await flexDepositMoveIn()
    await db.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          due_date, entry_description, notes, revenue_owner, created_at)
       VALUES ($1,$2,$3,$4,$5,'fee',9.99,'pending',$6,'SUBSCRIP',$7,'gam',$6::date)`,
      [m.invoiceId, m.unitId, m.leaseId, m.tenantId, m.landlordId, todayIn(null),
       'FlexCredit reporting fee 2026-10'])

    const { bills } = await landlordsBill(m)
    const gam = bills.flatMap(b => b.lines).filter(l => l.gam)
    const credit = gam.find(l => Number(l.amount) === 9.99)!

    expect(credit.label).toBe('Tenant owes GAM')
    expect(credit.detail).toBe('FlexCredit reporting fee 2026-10')
    // And it is still none of the landlord's money.
    expect(bills.reduce((t, b) => t + b.balance, 0)).toBe(440 + 75 + DEPOSIT_TOTAL)
    expect(bills.reduce((t, b) => t + b.gam_owed, 0)).toBe(SERVICE_FEE + 9.99)
  })

  it('is never part of what the landlord is owed', async () => {
    const m = await flexDepositMoveIn()
    const { bills } = await landlordsBill(m)
    const loose = bills.find(b => b.invoice_number === NOT_ON_A_BILL)!

    expect(loose.gam_owed).toBe(SERVICE_FEE)
    expect(loose.balance).toBe(0)
    expect(loose.total_amount).toBe(0)
    // And not a cent of it anywhere in their balance.
    expect(bills.reduce((t, b) => t + b.balance, 0)).toBe(440 + 75 + DEPOSIT_TOTAL)
    expect(bills.reduce((t, b) => t + b.gam_owed, 0)).toBe(SERVICE_FEE)
  })
})

describe('the Outstanding list agrees with the bill', () => {
  it('counts the whole deposit once, and none of GAM money', async () => {
    const m = await flexDepositMoveIn()
    const rows = await listOpenTenantBalances({ landlordIds: [m.landlordId] })

    expect(rows).toHaveLength(1)
    expect(Number(rows[0].balance)).toBe(440 + 75 + DEPOSIT_TOTAL)
  })

  it('drops the deposit from the balance once the first installment settles', async () => {
    const m = await flexDepositMoveIn({ settleInstallment1: true })
    const rows = await listOpenTenantBalances({ landlordIds: [m.landlordId] })

    expect(Number(rows[0].balance)).toBe(440 + 75)
  })
})

/**
 * 10/28 (Nic): WHILE THE MONEY IS ON ITS WAY, SAY SO AND SAY NOTHING ELSE.
 *
 *   "Just have it not show an amount. Just have it stay still clearing."
 *
 * An ACH takes three to five business days, so this is the state the landlord's
 * screen sits in for most of a week after a move-in. The amount is the thing
 * that cannot be stated plainly for that week — the charge arriving is a part of
 * a deposit their bill already reads in full, so a figure beside it either
 * contradicts the bill or overstates what is moving. The mark carries the only
 * thing they need: it is paid and it is coming. Same shape as work trade, which
 * is a mark and never an amount.
 */
describe('while the first installment clears', () => {
  it('says clearing, with no amount, and nothing owed', async () => {
    const m = await flexDepositMoveIn({ installment1Status: 'processing' })
    const rows = await listOpenTenantBalances({ landlordIds: [m.landlordId], includeClearing: true })

    expect(rows).toHaveLength(1)
    expect(rows[0].clearing_unpriced).toBe(true)
    // Not a figure — not the installment's $500, not the deposit's $2,000.
    expect(rows[0].clearing).toBe(0)
    // The deposit is not owed while its money is moving; the rest still is.
    expect(Number(rows[0].balance)).toBe(440 + 75)
  })

  it('still shows the deposit in full on the bill itself', async () => {
    const m = await flexDepositMoveIn({ installment1Status: 'processing' })
    const { bills } = await landlordsBill(m)
    const deposit = bills.find(b => b.id === m.invoiceId)!.lines.find(l => l.type === 'deposit')!

    // Their bill is the one place the whole figure belongs, clearing or not.
    expect(Number(deposit.amount)).toBe(DEPOSIT_TOTAL)
    expect(deposit.open).toBe(false)
  })

  it('never marks the landlord clearing for GAM\'s own fee', async () => {
    // GAM's fee clearing is not their money arriving, so it is not their mark.
    const m = await flexDepositMoveIn()
    await db.query(
      `UPDATE payments SET status='processing' WHERE entry_description='FLEXDEP' AND landlord_id=$1`,
      [m.landlordId])
    const rows = await listOpenTenantBalances({ landlordIds: [m.landlordId], includeClearing: true })

    expect(rows[0].clearing_unpriced).toBe(false)
    expect(rows[0].clearing).toBe(0)
  })
})
