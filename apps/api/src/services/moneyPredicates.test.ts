/**
 * S655 money plan, Step 1: the shared money predicates and the household lock.
 *
 * Each predicate exists twice, as a SQL fragment and as a function over a row
 * already read; and creditEligible exists a third time, as the credit_uses
 * trigger. These tests hold all of them to the same answer on the same rows,
 * so no path can quietly disagree about what is owed or what credit may pay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { sortForAllocation } from '@gam/shared'
import {
  payableRowSql, requiredRowSql, bankPayableRowSql, creditEligibleRowSql, depositOrMoveOutRowSql,
  allocationOrderSql, isPayableRow, isBankPayableRow, isCreditEligibleRow, isDepositOrMoveOutRow,
  lockHousehold, lockPaymentRowsById, householdLockKey, leaseLockKey,
  flexDepositFactSql, deskPayableRowSql, creditEligibleRowForCreditSql, isCreditEligibleRowForCredit,
  disputeGaveBackCreditIdsSql,
} from './moneyPredicates'
import { deskQuote, settleManualRentPayment } from './manualPaymentSettle'
import type { MoneyRowFacts } from './moneyPredicates'
import {
  cleanupAllSchema, withRollback, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedLeaseFee,
} from '../test/dbHelpers'

interface Household { landlordId: string; userId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string }

async function household(c: PoolClient, o: { landlord?: { landlordId: string; userId: string }; propertyId?: string } = {}): Promise<Household> {
  const ll = o.landlord ?? await seedLandlord(c)
  const propertyId = o.propertyId ?? await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
  const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: 'active' })
  await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
  return { ...ll, propertyId, unitId, tenantId, leaseId }
}

type Row = {
  label: string; type?: string; amount?: number; status?: string; entry?: string; owner?: string
  intent?: string | null; workTrade?: boolean; leaseFeeId?: string | null; reversalId?: string | null
  leaseId?: string | null; unitId?: string | null; invoiceId?: string | null; due?: string; createdAt?: string
}
// Rent is unique per lease and due date, so rows get their own day unless named.
let dueSeq = 0
function nextDue(): string {
  return new Date(Date.UTC(2027, 0, 1) + (dueSeq++) * 86_400_000).toISOString().slice(0, 10)
}
async function insertRow(c: PoolClient, f: Household, r: Row): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, revenue_owner, stripe_payment_intent_id, work_trade_suspended_at,
                           lease_fee_id, reversal_id, invoice_id, created_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz, now()),$17) RETURNING id`,
    [r.unitId === undefined ? f.unitId : r.unitId, r.leaseId === undefined ? f.leaseId : r.leaseId,
     f.tenantId, f.landlordId, r.type ?? 'rent', r.amount ?? 100, r.status ?? 'pending', r.entry ?? 'RENT',
     r.due ?? nextDue(), r.owner ?? 'landlord', r.intent ?? null, r.workTrade ? new Date() : null,
     r.leaseFeeId ?? null, r.reversalId ?? null, r.invoiceId ?? null, r.createdAt ?? null, r.label])
  return res.rows[0].id
}

/** label → [sql says, ts says] for one predicate over every row. */
async function bothSides(
  c: PoolClient, ids: string[], sqlFn: (a: string) => string, tsFn: (r: any) => boolean,
): Promise<Record<string, [boolean, boolean]>> {
  const res = await c.query(
    `SELECT p.*, p.amount::float AS amount, ${sqlFn('p')} AS sql_says FROM payments p WHERE p.id = ANY($1)`, [ids])
  return Object.fromEntries(res.rows.map(r => [r.notes as string, [r.sql_says as boolean, tsFn(r)] as [boolean, boolean]]))
}

beforeAll(async () => { await cleanupAllSchema() })
afterAll(async () => { await cleanupAllSchema() })

describe('S655 money predicates', () => {
  it('payable excludes rows with a retry in flight', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rows: Row[] = [
        { label: 'pending, nothing moving' },
        { label: 'failed, retry scheduled', status: 'failed', intent: 'pi_bounced' },
        { label: 'retry in flight', status: 'processing', intent: 'pi_retry' },
        { label: 'pending with an intent', intent: 'pi_new' },
        { label: 'settled', status: 'settled' },
        { label: 'returned', status: 'returned' },
        { label: 'work trade', workTrade: true },
        { label: 'flexpay pull', type: 'fee', entry: 'FLEXPAY', owner: 'gam' },
        { label: 'zero', amount: 0 },
        { label: 'move-out refund', type: 'fee', entry: 'DEPOSIT', amount: -200 },
      ]
      const ids = []
      for (const r of rows) ids.push(await insertRow(c, f, r))
      const got = await bothSides(c, ids, payableRowSql, isPayableRow)
      for (const [label, [sql, ts]] of Object.entries(got)) expect(ts, label).toBe(sql)
      expect(Object.entries(got).filter(([, [sql]]) => sql).map(([l]) => l).sort())
        .toEqual(['failed, retry scheduled', 'pending, nothing moving'])
    })
  })

  it('bank-payable includes home payments and carried balances, excludes GAM rows', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rows: Row[] = [
        { label: 'rent' },
        { label: 'home payment', type: 'home_payment', entry: 'HOMEPMT' },
        { label: 'carried balance', type: 'carried_balance', entry: 'BALANCE' },
        { label: 'prepaid move-in box', type: 'fee', entry: 'OTHERFEE', owner: 'held' },
        { label: 'move-out shortfall', type: 'fee', entry: 'DEPOSIT' },
        { label: 'gam return fee', type: 'fee', entry: 'RETURNFEE', owner: 'gam' },
        { label: 'gam platform fee', type: 'platform_fee', entry: 'SUBSCRIP', owner: 'gam' },
        { label: 'in flight', status: 'processing', intent: 'pi_x' },
        { label: 'move-out refund', type: 'fee', entry: 'DEPOSIT', amount: -50 },
      ]
      const ids = []
      for (const r of rows) ids.push(await insertRow(c, f, r))
      const got = await bothSides(c, ids, bankPayableRowSql, isBankPayableRow)
      for (const [label, [sql, ts]] of Object.entries(got)) expect(ts, label).toBe(sql)
      expect(Object.entries(got).filter(([, [sql]]) => sql).map(([l]) => l).sort()).toEqual(
        ['carried balance', 'home payment', 'move-out shortfall', 'prepaid move-in box', 'rent'])
    })
  })

  it('credit-eligible agrees with the database trigger on every kind of row', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const petFee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'pet_deposit', amount: 100, dueTiming: 'move_in' })
      const original = await insertRow(c, f, { label: 'original', status: 'returned' })
      const reversal = (await c.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
         VALUES ($1,'card_dispute',100,'evt_pred','{}'::jsonb) RETURNING id`, [original])).rows[0].id
      const rows: Row[] = [
        { label: 'rent' }, { label: 'utility', type: 'utility', entry: 'UTILITY' },
        { label: 'late fee', type: 'late_fee', entry: 'LATEFEE' }, { label: 'lease fee', type: 'fee', entry: 'OTHERFEE' },
        { label: 'pet deposit fee', type: 'fee', entry: 'DEPOSIT', leaseFeeId: petFee },
        { label: 'move-out shortfall', type: 'fee', entry: 'DEPOSIT' },
        { label: 'security deposit', type: 'deposit', entry: 'DEPOSIT' },
        { label: 'home payment', type: 'home_payment', entry: 'HOMEPMT' },
        { label: 'carried balance', type: 'carried_balance', entry: 'BALANCE' },
        { label: 'gam fee', type: 'fee', entry: 'RETURNFEE', owner: 'gam' },
        { label: 'held box', type: 'fee', entry: 'OTHERFEE', owner: 'held' },
        { label: 'flexpay', type: 'fee', entry: 'FLEXPAY' },
        { label: 'reopened', reversalId: reversal },
        { label: 'work trade', workTrade: true },
        { label: 'no unit', unitId: null },
        { label: 'settled', status: 'settled' },
      ]
      const ids: string[] = []
      for (const r of rows) ids.push(await insertRow(c, f, r))
      const got = await bothSides(c, ids, creditEligibleRowSql, isCreditEligibleRow)
      const credit = (await c.query<{ id: string }>(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining)
         VALUES ($1,$2,$3,10000,10000) RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])).rows[0].id
      for (const [i, id] of ids.entries()) {
        await c.query('SAVEPOINT try_use')
        let accepted = true
        try {
          await c.query(
            `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
             VALUES ($1,$2,$3,1,'2026-10-01','desk','applied',now())`, [credit, id, f.leaseId])
        } catch { accepted = false }
        await c.query('ROLLBACK TO SAVEPOINT try_use')
        const [sql, ts] = got[rows[i].label]
        expect(sql, rows[i].label).toBe(accepted)
        expect(ts, rows[i].label).toBe(accepted)
      }
      expect(Object.entries(got).filter(([, [sql]]) => sql).map(([l]) => l).sort())
        .toEqual(['late fee', 'lease fee', 'pet deposit fee', 'rent', 'utility'])
    })
  })

  it('a deposit or move-out row is DEPOSIT with no lease fee; a pet-deposit fee is an ordinary fee', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const petFee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'pet_deposit', amount: 100, dueTiming: 'move_in' })
      const ids = [
        await insertRow(c, f, { label: 'security deposit', type: 'deposit', entry: 'DEPOSIT' }),
        await insertRow(c, f, { label: 'move-out refund', type: 'fee', entry: 'DEPOSIT', amount: -10 }),
        await insertRow(c, f, { label: 'pet deposit fee', type: 'fee', entry: 'DEPOSIT', leaseFeeId: petFee }),
      ]
      const got = await bothSides(c, ids, depositOrMoveOutRowSql, isDepositOrMoveOutRow)
      expect(got).toEqual({
        'security deposit': [true, true], 'move-out refund': [true, true], 'pet deposit fee': [false, false],
      })
    })
  })

  it("required takes the lease's rows and its invoices' rows, never a carried balance", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const neighbor = await seedLandlord(c)
      const neighborProperty = await seedProperty(c, { landlordId: neighbor.landlordId, ownerUserId: neighbor.userId, managedByUserId: neighbor.userId })
      const neighborUnit = await seedUnit(c, { propertyId: neighborProperty, landlordId: neighbor.landlordId })
      const other = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId })
      const invoice = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, unit_id, lease_id, invoice_number, due_date, total_amount)
         VALUES ($1,$2,$3,'INV-PRED-1','2026-10-01',600) RETURNING id`, [f.landlordId, f.unitId, f.leaseId])).rows[0].id
      const ids = [
        await insertRow(c, f, { label: 'rent', invoiceId: invoice }),
        await insertRow(c, f, { label: 'older late fee', type: 'late_fee', entry: 'LATEFEE', due: '2026-09-06' }),
        await insertRow(c, f, { label: 'gam fee', type: 'fee', entry: 'RETURNFEE', owner: 'gam' }),
        await insertRow(c, { ...f, landlordId: neighbor.landlordId }, { label: "neighbor's water on the invoice",
          type: 'utility', entry: 'UTILITY', leaseId: null, unitId: neighborUnit, invoiceId: invoice }),
        await insertRow(c, f, { label: 'carried balance', type: 'carried_balance', entry: 'BALANCE' }),
        await insertRow(c, f, { label: 'in flight', status: 'processing', intent: 'pi_y' }),
        await insertRow(c, { ...other, tenantId: f.tenantId }, { label: 'another lease' }),
      ]
      const res = await c.query(`SELECT p.notes FROM payments p WHERE p.id = ANY($1) AND ${requiredRowSql('p', '$2')} ORDER BY p.notes`, [ids, f.leaseId])
      expect(res.rows.map(r => r.notes)).toEqual(['gam fee', "neighbor's water on the invoice", 'older late fee', 'rent'])
      // A column works as the lease reference too (one query over many leases).
      const byColumn = await c.query(
        `SELECT count(*)::int AS n FROM leases l JOIN payments p ON ${requiredRowSql('p', 'l.id')} WHERE l.id = $1 AND p.id = ANY($2)`,
        [f.leaseId, ids])
      expect(byColumn.rows[0].n).toBe(4)
    })
  })

  it('a GAM-owned row is never bank-payable or credit-eligible', async () => {
    const facts: MoneyRowFacts = {
      status: 'pending', amount: '6.00', stripe_payment_intent_id: null, work_trade_suspended_at: null,
      entry_description: 'RETURNFEE', revenue_owner: 'gam', type: 'fee', lease_fee_id: null, reversal_id: null,
      unit_id: '00000000-0000-0000-0000-0000000000a1', lease_id: '00000000-0000-0000-0000-0000000000b1',
    }
    expect(isPayableRow(facts)).toBe(true)          // owed: an online payment settles it
    expect(isBankPayableRow(facts)).toBe(false)
    expect(isCreditEligibleRow(facts)).toBe(false)
    // The same as the SQL side, on a real row.
    await withRollback(async c => {
      const f = await household(c)
      const ids = [
        await insertRow(c, f, { label: 'gam return fee', type: 'fee', entry: 'RETURNFEE', owner: 'gam', amount: 6 }),
        await insertRow(c, f, { label: 'gam platform fee', type: 'platform_fee', entry: 'SUBSCRIP', owner: 'gam', amount: 2 }),
      ]
      for (const [sqlFn, tsFn] of [[bankPayableRowSql, isBankPayableRow], [creditEligibleRowSql, isCreditEligibleRow]] as const) {
        const got = await bothSides(c, ids, sqlFn, tsFn)
        expect(Object.values(got)).toEqual([[false, false], [false, false]])
      }
    })
  })

  it('a row read without a column a rule needs is refused, never answered', () => {
    const full: MoneyRowFacts = {
      status: 'pending', amount: 100, stripe_payment_intent_id: 'pi_live', work_trade_suspended_at: null,
      entry_description: 'RETURNFEE', revenue_owner: 'gam', type: 'fee', lease_fee_id: null, reversal_id: null,
      unit_id: 'u', lease_id: 'l',
    }
    // Each omission used to fail OPEN: a GAM fee read as the landlord's, a row
    // with an intent read as payable, a work-trade row read as owed.
    const { revenue_owner: _o, ...noOwner } = full
    const { stripe_payment_intent_id: _i, ...noIntent } = full
    const { work_trade_suspended_at: _w, ...noWorkTrade } = full
    expect(() => isBankPayableRow(noOwner as any)).toThrow(/no revenue_owner; add payments.revenue_owner to the SELECT list/)
    expect(() => isCreditEligibleRow(noOwner as any)).toThrow(/no revenue_owner/)
    expect(() => isPayableRow(noIntent as any)).toThrow(/no stripe_payment_intent_id/)
    expect(() => isPayableRow(noWorkTrade as any)).toThrow(/no work_trade_suspended_at/)
    const { lease_fee_id: _f, ...noFee } = full
    expect(() => isDepositOrMoveOutRow(noFee as any)).toThrow(/no lease_fee_id/)
    // tsc refuses the same omission in a typed query result.
    // @ts-expect-error revenue_owner is required
    const typed: MoneyRowFacts = { ...noOwner }
    expect(typed.status).toBe('pending')
  })

  it('only an alias and a placeholder or column are ever written into the SQL', () => {
    expect(() => payableRowSql("p; DROP TABLE payments")).toThrow(/not a table alias/)
    expect(() => requiredRowSql('p', "1 OR 1=1")).toThrow(/not a placeholder or column/)
    expect(requiredRowSql('pay', '$3::uuid')).toContain('pay.lease_id = $3::uuid')
  })

  it('the SQL allocation order matches the shared comparator', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const t = (s: number) => `2026-09-01T07:00:${String(s).padStart(2, '0')}.000Z`
      const day = '2026-10-01'
      const rows: Row[] = [
        { label: 'carried', type: 'carried_balance', entry: 'BALANCE', due: '2026-01-01', createdAt: t(1) },
        { label: 'propane', type: 'utility', entry: 'PROPANE', due: '2026-08-20', createdAt: t(1) },
        { label: 'home', type: 'home_payment', entry: 'HOMEPMT', due: day, createdAt: t(1) },
        { label: 'fee', type: 'fee', entry: 'OTHERFEE', due: day, createdAt: t(1) },
        { label: 'late', type: 'late_fee', entry: 'LATEFEE', due: day, createdAt: t(1) },
        { label: 'water-2', type: 'utility', entry: 'UTILITY', due: day, createdAt: t(2) },
        { label: 'water-1', type: 'utility', entry: 'UTILITY', due: day, createdAt: t(1) },
        { label: 'rent', due: day, createdAt: t(3) },
        { label: 'old fee', type: 'fee', entry: 'OTHERFEE', due: '2026-09-01', createdAt: t(9) },
        { label: 'deposit', type: 'deposit', entry: 'DEPOSIT', due: day, createdAt: t(1) },
        { label: 'same-a', type: 'utility', entry: 'UTILITY', due: day, createdAt: t(5) },
        { label: 'same-b', type: 'utility', entry: 'UTILITY', due: day, createdAt: t(5) },
        // payments.created_at is nullable: such rows sort after the dated ones
        // (NULLS LAST), then by id, on both sides.
        { label: 'undated-1', type: 'utility', entry: 'UTILITY', due: day },
        { label: 'undated-2', type: 'utility', entry: 'UTILITY', due: day },
        { label: 'undated-3', type: 'utility', entry: 'UTILITY', due: day },
      ]
      const ids = []
      for (const r of rows) ids.push(await insertRow(c, f, r))
      await c.query(`UPDATE payments SET created_at = NULL WHERE id = ANY($1) AND notes LIKE 'undated-%'`, [ids])
      const res = await c.query(
        `SELECT p.id, p.notes, p.type, p.entry_description, p.amount::float AS amount,
                p.due_date::text AS due_date, p.created_at
           FROM payments p WHERE p.id = ANY($1) ORDER BY ${allocationOrderSql('p')}`, [ids])
      const sqlOrder = res.rows.map(r => r.notes)
      const tsOrder = sortForAllocation([...res.rows].reverse()).map(r => r.notes)
      expect(tsOrder).toEqual(sqlOrder)
      expect(sqlOrder.slice(0, 3)).toEqual(['old fee', 'rent', 'water-1'])
      expect(sqlOrder.slice(-2)).toEqual(['propane', 'carried'])
      const utilities = sqlOrder.filter(n => /^(water|same|undated)/.test(n))
      expect(utilities.slice(0, 2)).toEqual(['water-1', 'water-2'])
      expect(utilities.slice(2, 4).sort()).toEqual(['same-a', 'same-b'])
      expect(utilities.slice(4).sort()).toEqual(['undated-1', 'undated-2', 'undated-3'])
    })
  })
})

describe('S655 the household lock', () => {
  it('lockHousehold serializes co-tenants on one lease', async () => {
    const setup = await db.connect()
    let f: Household, coTenant: string, stranger: Household
    try {
      await setup.query('BEGIN')
      f = await household(setup)
      coTenant = await seedTenant(setup)
      await seedLeaseTenant(setup, { leaseId: f.leaseId, tenantId: coTenant, role: 'co_tenant' })
      stranger = await household(setup, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId })
      await setup.query('COMMIT')
    } finally { setup.release() }

    const a = await db.connect(), b = await db.connect(), s = await db.connect()
    try {
      await a.query('BEGIN'); await b.query('BEGIN'); await s.query('BEGIN')
      expect(await lockHousehold(a, f.tenantId, f.landlordId)).toEqual([f.leaseId])
      // A different household with the landlord is not held up.
      expect(await lockHousehold(s, stranger.tenantId, f.landlordId)).toEqual([stranger.leaseId])
      await s.query('COMMIT')

      const bPid = (await b.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid
      let bDone = false
      const bLock = lockHousehold(b, coTenant, f.landlordId).then(ids => { bDone = true; return ids })
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await db.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [bPid])
        waiting = w.rows[0]?.wait_event_type === 'Lock' && w.rows[0]?.wait_event === 'advisory'
        if (!waiting) await new Promise(r => setTimeout(r, 20))
      }
      expect(waiting).toBe(true)
      expect(bDone).toBe(false)
      await a.query('COMMIT')
      expect(await bLock).toEqual([f.leaseId])
      await b.query('COMMIT')
    } finally {
      a.release(); b.release(); s.release()
      await cleanupAllSchema()
    }
  })

  it('lockHousehold refuses to run outside a transaction', async () => {
    const c = await db.connect()
    try {
      await expect(lockHousehold(c, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'))
        .rejects.toThrow(/inside a transaction/)
    } finally { c.release() }
  })

  it('locks rows in id order and names its keys plainly', async () => {
    expect(householdLockKey('t', 'l')).toBe('household:t:l')
    expect(leaseLockKey('x')).toBe('lease:x')
    await withRollback(async c => {
      const f = await household(c)
      const one = await insertRow(c, f, { label: 'one' })
      const two = await insertRow(c, f, { label: 'two' })
      expect(await lockPaymentRowsById(c, [two, one, two])).toEqual([one, two].sort())
      expect(await lockPaymentRowsById(c, [])).toEqual([])
    })
  })
})

// Leftovers (charges5): only the bank-deposit match used to leave out a
// FlexDeposit payment — GAM's custody collection, paid online to GAM. The desk,
// the agent's cash tool and Record payment treated it as the landlord's, so a
// landlord could take cash for GAM's custody money.
describe('a FlexDeposit payment is never the landlord\'s to take', () => {
  async function flexDepositLease(c: PoolClient) {
    const f = await household(c)
    await c.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status, flex_deposit_enabled)
       VALUES ($1,$2,$3,600,0,'gam_escrow','pending',TRUE)`, [f.unitId, f.leaseId, f.tenantId])
    return f
  }

  it('bank-payable and desk-payable leave out a FlexDeposit installment; the in-memory rule agrees when it reads the fact', async () => {
    await withRollback(async c => {
      const flex = await flexDepositLease(c)
      const plain = await household(c)
      const ids = [
        await insertRow(c, flex, { label: 'flexdeposit installment', type: 'deposit', entry: 'DEPOSIT', amount: 150 }),
        await insertRow(c, flex, { label: 'rent on the flexdeposit lease' }),
        await insertRow(c, plain, { label: 'ordinary security deposit', type: 'deposit', entry: 'DEPOSIT', amount: 300 }),
      ]
      const res = await c.query(
        `SELECT p.*, p.amount::float AS amount, ${flexDepositFactSql('p')} AS flex_deposit,
                ${bankPayableRowSql('p')} AS bank_sql, ${deskPayableRowSql('p')} AS desk_sql, ${payableRowSql('p')} AS payable_sql
           FROM payments p WHERE p.id = ANY($1)`, [ids])
      const by = Object.fromEntries(res.rows.map(r => [r.notes, r]))
      expect(by['flexdeposit installment'].flex_deposit).toBe(true)
      expect(by['flexdeposit installment'].payable_sql).toBe(true)      // owed — paid online to GAM
      expect(by['flexdeposit installment'].bank_sql).toBe(false)
      expect(by['flexdeposit installment'].desk_sql).toBe(false)
      for (const label of ['rent on the flexdeposit lease', 'ordinary security deposit']) {
        expect(by[label].bank_sql, label).toBe(true)
        expect(by[label].desk_sql, label).toBe(true)
      }
      for (const r of res.rows) expect(isBankPayableRow(r), r.notes).toBe(r.bank_sql)
    })
  })

  it('the desk never takes a FlexDeposit installment: Record payment on it is refused and nothing settles', async () => {
    await withRollback(async c => {
      const f = await flexDepositLease(c)
      const id = await insertRow(c, f, { label: 'flexdeposit installment', type: 'deposit', entry: 'DEPOSIT', amount: 150, due: '2026-10-01' })
      await lockHousehold(c, f.tenantId, f.landlordId)
      const q = await deskQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId, lock: true })
      expect(q.rows.map(r => r.id)).not.toContain(id)
      await c.query('SAVEPOINT desk')
      await expect(settleManualRentPayment(c, {
        payment: { id, landlord_id: f.landlordId, tenant_id: f.tenantId, unit_id: f.unitId, lease_id: f.leaseId, due_date: '2026-10-01' },
        method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 150,
      })).rejects.toThrow(/paid online, not at the desk/)
      await c.query('ROLLBACK TO SAVEPOINT desk')
      expect((await c.query(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status).toBe('pending')
    })
  })
})

// decisions #48.7: a bill reopened by a dispute may be paid with the credit
// that same dispute gave back — and with no other credit.
describe('a bill a dispute reopened takes only the credit that dispute gave back', () => {
  async function disputed(c: PoolClient) {
    const f = await household(c)
    const credit = async (amount: number) => (await c.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
       VALUES ($1,$2,$3,$3,'gam') RETURNING id`, [f.leaseId, f.tenantId, amount])).rows[0].id
    const given = await credit(200)      // the disputed charge's paid-ahead money
    const other = await credit(200)      // somebody else's paid-ahead money on the lease
    // October rent was paid from it ($60), then the charge that funded it was disputed:
    // the spend is undone ('reversed') and the bill reopens for $60.
    const original = await insertRow(c, f, { label: 'october rent', amount: 60 })
    await c.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,60,'2026-10-01','whole_bill','applied',now())`, [given, original, f.leaseId])
    await c.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [original])
    await c.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [original])
    await c.query(`UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed' WHERE payment_id = $1`, [original])
    const reversal = (await c.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,'card_dispute',60,'evt_reopen_credit','{}'::jsonb) RETURNING id`, [original])).rows[0].id
    const reopened = await insertRow(c, f, { label: 'october rent, reopened', amount: 100, reversalId: reversal })
    const issued = (await c.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining)
       VALUES ($1,$2,$3,500,500) RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])).rows[0].id
    return { f, given, other, issued, reopened, reversal }
  }
  async function tryUse(c: PoolClient, col: 'prepaid_credit_id' | 'tenant_credit_id', creditId: string, paymentId: string, leaseId: string, amount: number) {
    await c.query('SAVEPOINT try_use')
    try {
      await c.query(
        `INSERT INTO credit_uses (${col}, payment_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,$4,'2026-10-01','portal','applied',now())`, [creditId, paymentId, leaseId, amount])
      await c.query('RELEASE SAVEPOINT try_use')
      return true
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT try_use')
      return false
    }
  }

  it('the database takes the dispute\'s own credit on the reopened bill, up to what it gave back, and refuses every other credit', async () => {
    await withRollback(async c => {
      const d = await disputed(c)
      expect(await tryUse(c, 'prepaid_credit_id', d.other, d.reopened, d.f.leaseId, 10)).toBe(false)
      expect(await tryUse(c, 'tenant_credit_id', d.issued, d.reopened, d.f.leaseId, 10)).toBe(false)
      expect(await tryUse(c, 'prepaid_credit_id', d.given, d.reopened, d.f.leaseId, 61)).toBe(false)   // more than it gave back
      expect(await tryUse(c, 'prepaid_credit_id', d.given, d.reopened, d.f.leaseId, 60)).toBe(true)
      expect(await tryUse(c, 'prepaid_credit_id', d.given, d.reopened, d.f.leaseId, 1)).toBe(false)    // already used all of it
      expect((await c.query(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [d.given])).rows[0].r)
        .toBe(200 - 60 + 60 - 60)
    })
  })

  it('the per-credit rule agrees with the database for each credit; the any-credit rule still says no', async () => {
    await withRollback(async c => {
      const d = await disputed(c)
      const row = (await c.query(
        `SELECT p.*, ${disputeGaveBackCreditIdsSql('p')}::text[] AS dispute_credit_ids,
                ${creditEligibleRowForCreditSql('p', '$2')} AS given_sql,
                ${creditEligibleRowForCreditSql('p', '$3')} AS other_sql,
                ${creditEligibleRowForCreditSql('p', 'NULL')} AS issued_sql,
                ${creditEligibleRowSql('p')} AS any_sql
           FROM payments p WHERE p.id = $1`, [d.reopened, d.given, d.other])).rows[0]
      expect(row.dispute_credit_ids).toEqual([d.given])
      expect([row.given_sql, row.other_sql, row.issued_sql, row.any_sql]).toEqual([true, false, false, false])
      expect(isCreditEligibleRowForCredit(row, d.given)).toBe(true)
      expect(isCreditEligibleRowForCredit(row, d.other)).toBe(false)
      expect(isCreditEligibleRowForCredit(row, null)).toBe(false)
      expect(isCreditEligibleRow(row)).toBe(false)
      const { dispute_credit_ids: _x, ...withoutFact } = row
      expect(() => isCreditEligibleRowForCredit(withoutFact, d.given)).toThrow(/no dispute_credit_ids/)
    })
  })
})
