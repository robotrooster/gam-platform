/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P6: A REPAIR CLOSED WITH A COST BECOMES A BILL (L6)
 *
 *   Nic, 10/12 (L6): "a repair closed with a cost → LANDLORD'S CHOICE (auto
 *   unpaid bill vs 'Record as bill' button)." And: "some expenses may be cash
 *   that never went through the bank and need to be manually logged" — the
 *   bill is paid like any other expense (cash, check, card, the bank line).
 *
 * The owner chooses on the Books settings page (landlords.books_repair_bills,
 * BOOKS_REPAIR_BILL_MODES):
 *   automatic  completing a repair with a cost makes an UNPAID expense (a bill)
 *              for it under Repairs, on the repair's unit, dated the day it was
 *              completed — and keeps it in step (amount, day) while nothing has
 *              been paid on it
 *   button     nothing by itself; "Record as bill" on the Maintenance costs
 *              page makes it
 *   (not chosen) as 'button' — GAM never decides how a company's money is kept
 * Either way one repair has at most one live bill
 * (landlord_expenses_one_per_repair), and the repair's cost then counts once,
 * on the bill (lib/liveExpense maintenanceCostNotBilledSql).
 */
import type { PoolClient } from 'pg'
import { BOOKS_REPAIR_BILL_MODES, booksCents, type BooksRepairBillMode } from '@gam/shared'
import { db, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { createMoneyOutExpense } from './landlordExpenses'

type Runner = Pick<PoolClient, 'query'>

export async function repairBillMode(run: Runner, landlordId: string): Promise<BooksRepairBillMode | null> {
  const r = (await run.query<{ m: string | null }>(`SELECT books_repair_bills AS m FROM landlords WHERE id = $1`, [landlordId])).rows[0]
  return (BOOKS_REPAIR_BILL_MODES as readonly string[]).includes(r?.m ?? '') ? r!.m as BooksRepairBillMode : null
}

interface RepairRow {
  id: string; landlord_id: string; unit_id: string | null; property_id: string | null; title: string | null
  status: string; actual_cost: string | null; day: string | null
}

async function loadRepair(run: Runner, requestId: string, lock = false): Promise<RepairRow | null> {
  return (await run.query<RepairRow>(
    `SELECT mr.id, mr.landlord_id, mr.unit_id, u.property_id, mr.title, mr.status, mr.actual_cost::text AS actual_cost,
            to_char((mr.completed_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS day
       FROM maintenance_requests mr
       LEFT JOIN units u ON u.id = mr.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
      WHERE mr.id = $1${lock ? ' FOR UPDATE OF mr' : ''}`, [requestId])).rows[0] ?? null
}

async function liveBill(run: Runner, requestId: string): Promise<{ id: string; amount: string; day: string; paid: string } | null> {
  return (await run.query<{ id: string; amount: string; day: string; paid: string }>(
    `SELECT e.id, e.amount::text AS amount, e.expense_date::text AS day,
            COALESCE((SELECT sum(p.amount) FROM landlord_expense_payments p WHERE p.expense_id = e.id AND p.voided_at IS NULL), 0)::text AS paid
       FROM landlord_expenses e WHERE e.maintenance_request_id = $1 AND e.status = 'active' FOR UPDATE`, [requestId])).rows[0] ?? null
}

async function makeBill(run: Runner, r: RepairRow, by: string | null): Promise<string> {
  const made = await createMoneyOutExpense(run, {
    landlordId: r.landlord_id, categoryKey: 'repairs', amount: booksCents(r.actual_cost) / 100,
    expenseDate: r.day!, dueDate: null,
    description: `Repair: ${(r.title || 'maintenance request').slice(0, 180)}`,
    createdBy: by, unitId: r.unit_id, propertyId: r.unit_id ? null : r.property_id,
    maintenanceRequestId: r.id,
  })
  return made.id
}

/**
 * "Record as bill" (the button): an unpaid expense for a completed repair's
 * cost. Refused when the repair has no cost yet or already has its bill.
 */
export async function recordRepairBill(landlordId: string, requestId: string, by: string | null): Promise<{ expenseId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await loadRepair(c, requestId, true)
    if (!r || r.landlord_id !== landlordId) throw new AppError(404, 'Repair not found')
    if (r.status !== 'completed' || !r.day) throw new AppError(409, 'This repair is not completed yet. Its bill is recorded once it is done.')
    if (!(booksCents(r.actual_cost) > 0)) throw new AppError(409, 'This repair has no cost recorded, so there is nothing to bill.')
    if (await liveBill(c, requestId)) throw new AppError(409, 'This repair already has its bill on Expenses.')
    const id = await makeBill(c, r, by)
    await c.query('COMMIT')
    return { expenseId: id }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/**
 * After a repair changes (completed, or its cost corrected): with the
 * company's 'automatic' choice, make its bill, or keep an unpaid one in step.
 * Never throws — the repair is already saved; a failure is logged for an admin.
 */
export async function syncRepairBill(requestId: string, by: string | null): Promise<string | null> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await loadRepair(c, requestId, true)
    if (!r || r.status !== 'completed' || !r.day || !(booksCents(r.actual_cost) > 0)) { await c.query('ROLLBACK'); return null }
    if (await repairBillMode(c, r.landlord_id) !== 'automatic') { await c.query('ROLLBACK'); return null }
    const bill = await liveBill(c, requestId)
    let id: string | null = null
    if (!bill) {
      id = await makeBill(c, r, by)
    } else if (booksCents(bill.paid) === 0 && (booksCents(bill.amount) !== booksCents(r.actual_cost) || bill.day !== r.day)
               // 10/13: never rewrite a bill a live fixed asset was made from —
               // the asset carries its cost (a person's edit is refused the same way).
               && !(await c.query(`SELECT 1 FROM books_fixed_assets WHERE source_expense_id = $1 AND voided_at IS NULL LIMIT 1`, [bill.id])).rows.length) {
      await c.query(
        `UPDATE landlord_expenses SET amount = $2, expense_date = $3, updated_at = now() WHERE id = $1`,
        [bill.id, (booksCents(r.actual_cost) / 100).toFixed(2), r.day])
      id = bill.id
    }
    await c.query('COMMIT')
    return id
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    logger.error({ err: e, requestId }, '[books] a completed repair\'s bill was not made')
    return null
  } finally {
    c.release()
  }
}

/** The repair a request id names, for a route's scope check. */
export async function repairCompany(requestId: string): Promise<{ landlordId: string; propertyId: string | null } | null> {
  const r = await queryOne<{ landlord_id: string; property_id: string | null }>(
    `SELECT mr.landlord_id, u.property_id FROM maintenance_requests mr LEFT JOIN units u ON u.id = mr.unit_id WHERE mr.id = $1`,
    [requestId])
  return r ? { landlordId: r.landlord_id, propertyId: r.property_id } : null
}
