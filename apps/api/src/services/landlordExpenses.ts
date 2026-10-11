// Landlord-entered expenses (S568, Nic). Unit-linked or common (property-level);
// common expenses can be allocated per unit for per-unit P&L. Feeds the landlord
// reports P&L. Soft-void, never hard-delete (keep-everything).
import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { EXPENSE_CATEGORIES } from '@gam/shared'

export interface CreateExpenseInput {
  landlordId: string
  createdBy?: string | null
  propertyId?: string | null
  unitId?: string | null
  category: string
  amount: number
  description?: string | null
  vendor?: string | null
  expenseDate: string          // YYYY-MM-DD
  isCommon?: boolean
  /** S613: which utility, when category = 'utilities'. Optional — an untyped
   *  utility bill still counts toward what the property spent. */
  utilityType?: string | null
}

/**
 * Book one landlord expense.
 *
 * `client` (S655 review): pass the caller's transaction to book the expense
 * inside it. The bank feed files a bank row by booking its expense and marking
 * the row filed — written on two different connections, a failure after the
 * expense left it booked with no bank row pointing at it, and the row back in
 * review to be filed (and booked) again. Without a client it runs on its own,
 * as every other caller wants.
 */
export async function createLandlordExpense(input: CreateExpenseInput, client?: Pick<PoolClient, 'query'>) {
  const one = async <T = any>(sql: string, params: any[]): Promise<T | null> =>
    client ? ((await client.query(sql, params)).rows[0] ?? null) : queryOne<T>(sql, params)
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new AppError(400, `Invalid expense category '${input.category}'`)
  }
  // Unit-linked ⇒ not common. Common ⇒ property-level (no unit). Validate + verify
  // the unit/property belong to this landlord.
  const unitId = input.unitId ?? null
  const isCommon = !!input.isCommon && !unitId
  let propertyId = input.propertyId ?? null

  if (unitId) {
    const u = await one<any>('SELECT id, property_id, landlord_id FROM units WHERE id=$1', [unitId])
    if (!u || u.landlord_id !== input.landlordId) throw new AppError(400, 'Unit does not belong to you')
    propertyId = u.property_id
  } else if (propertyId) {
    const p = await one<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [propertyId])
    if (!p || p.landlord_id !== input.landlordId) throw new AppError(400, 'Property does not belong to you')
  }
  // S603 (Nic): allocation is unconditional now — any non-unit-linked cost is
  // split across the property's units at report time. The column is retained
  // (keep-everything) and written TRUE so historical rows read consistently,
  // but nothing consults it any more.
  const allocate = isCommon

  const row = await one<any>(
    `INSERT INTO landlord_expenses
       (landlord_id, created_by, property_id, unit_id, category, amount, description, vendor,
        expense_date, is_common, allocate_per_unit, utility_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [input.landlordId, input.createdBy ?? null, propertyId, unitId, input.category,
     input.amount.toFixed(2), input.description ?? null, input.vendor ?? null,
     input.expenseDate, isCommon, allocate,
     input.category === 'utilities' ? (input.utilityType ?? null) : null])
  return row
}

/**
 * S637: takes ONE entity id or the whole set the account owns.
 *
 * The read side of "an account is not an entity" (S633): a landlord who owns
 * two companies has one book, and this list is a read. It was reached through
 * resolveLandlordTarget, a WRITE resolver, which answers "you own more than one
 * company, choose which" — correct when creating an expense, a 400 that blanks
 * the Expenses tab when merely opening it.
 */
export async function listLandlordExpenses(landlordId: string | string[], opts: {
  from?: string; to?: string; propertyId?: string; unitId?: string
  /** 10/11: a bookkeeper kept to some properties reads only theirs (null = all). */
  propertyIds?: string[] | null
} = {}) {
  const ids = Array.isArray(landlordId) ? landlordId : [landlordId]
  const conds = ['e.landlord_id = ANY($1::uuid[])', `e.status = 'active'`]
  const params: any[] = [ids]
  if (opts.propertyIds) { params.push(opts.propertyIds); conds.push(`e.property_id = ANY($${params.length}::uuid[])`) }
  if (opts.from) { params.push(opts.from); conds.push(`e.expense_date >= $${params.length}`) }
  if (opts.to)   { params.push(opts.to);   conds.push(`e.expense_date <= $${params.length}`) }
  if (opts.propertyId) { params.push(opts.propertyId); conds.push(`e.property_id = $${params.length}`) }
  if (opts.unitId) { params.push(opts.unitId); conds.push(`e.unit_id = $${params.length}`) }
  return query<any>(
    `SELECT e.id, e.category, e.amount::float AS amount, e.description, e.vendor, e.expense_date,
            e.is_common, e.allocate_per_unit, e.unit_id, e.property_id,
            e.receipt_url, e.receipt_name, e.receipt_mime, e.receipt_size,
            e.utility_type, e.created_by, e.landlord_id, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_day,
            -- 10/11: an expense the bank feed filed keeps the bank's amount and day.
            EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id) AS from_bank,
            u.unit_number, p.name AS property_name
       FROM landlord_expenses e
       LEFT JOIN units u ON u.id = e.unit_id
       LEFT JOIN properties p ON p.id = e.property_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.expense_date DESC, e.created_at DESC`, params)
}

/**
 * Attach an uploaded receipt to an existing active expense. Scoped by landlord
 * so a landlord can only stamp a receipt onto their own row. (S575)
 */
export async function attachExpenseReceipt(
  id: string, landlordId: string,
  receipt: { url: string; name: string; mime: string; size: number },
) {
  const row = await queryOne<any>(
    `UPDATE landlord_expenses
        SET receipt_url=$3, receipt_name=$4, receipt_mime=$5, receipt_size=$6, updated_at=NOW()
      WHERE id=$1 AND landlord_id=$2 AND status='active'
      RETURNING id, receipt_url, receipt_name, receipt_mime, receipt_size`,
    [id, landlordId, receipt.url, receipt.name, receipt.mime, receipt.size])
  if (!row) throw new AppError(404, 'Expense not found')
  return row
}

export interface UpdateExpenseInput {
  category?: string
  amount?: number
  description?: string | null
  vendor?: string | null
  expenseDate?: string
  utilityType?: string | null
  /** Re-file it: on a unit, or on the property (common). Omitted = where it is. */
  unitId?: string | null
  propertyId?: string | null
}

/**
 * 10/11 (Nic): edit an expense — an owner any of their company's, a
 * bookkeeper the ones they entered (the route decides who may). Scoped by
 * company like every other write here. The same placement rules as create: on
 * a unit (its property follows) or on a property (common, split per unit).
 * An expense the bank feed filed keeps the bank's amount and day — changing
 * them would leave the bank row saying one thing and the P&L another.
 */
export async function updateLandlordExpense(id: string, landlordId: string, patch: UpdateExpenseInput) {
  const cur = await queryOne<any>(
    `SELECT e.*, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_day,
            EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id) AS from_bank
       FROM landlord_expenses e WHERE e.id = $1 AND e.landlord_id = $2 AND e.status = 'active'`, [id, landlordId])
  if (!cur) throw new AppError(404, 'Expense not found')
  const category = patch.category ?? cur.category
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError(400, `Invalid expense category '${category}'`)
  }
  const amount = patch.amount ?? Number(cur.amount)
  const expenseDate = patch.expenseDate ?? cur.expense_day
  if (cur.from_bank) {
    const sameAmount = Math.abs(amount - Number(cur.amount)) < 0.005
    if (!sameAmount || expenseDate !== cur.expense_day) {
      throw new AppError(409, 'This expense came from your bank feed, so its amount and date come from the bank.')
    }
  }
  let unitId: string | null = cur.unit_id
  let propertyId: string | null = cur.property_id
  if (patch.unitId !== undefined || patch.propertyId !== undefined) {
    unitId = patch.unitId ?? null
    propertyId = patch.propertyId ?? null
    if (unitId) {
      const u = await queryOne<any>('SELECT property_id, landlord_id FROM units WHERE id=$1', [unitId])
      if (!u || u.landlord_id !== landlordId) throw new AppError(400, 'Unit does not belong to you')
      propertyId = u.property_id
    } else if (propertyId) {
      const p = await queryOne<any>('SELECT landlord_id FROM properties WHERE id=$1', [propertyId])
      if (!p || p.landlord_id !== landlordId) throw new AppError(400, 'Property does not belong to you')
    }
  }
  const isCommon = !unitId && !!propertyId
  const utilityType = category === 'utilities'
    ? (patch.utilityType !== undefined ? patch.utilityType : cur.utility_type)
    : null
  return queryOne<any>(
    `UPDATE landlord_expenses
        SET category=$3, amount=$4, description=$5, vendor=$6, expense_date=$7,
            unit_id=$8, property_id=$9, is_common=$10, allocate_per_unit=$10, utility_type=$11, updated_at=NOW()
      WHERE id=$1 AND landlord_id=$2 AND status='active'
      RETURNING *`,
    [id, landlordId, category, amount.toFixed(2),
     patch.description !== undefined ? patch.description : cur.description,
     patch.vendor !== undefined ? patch.vendor : cur.vendor,
     expenseDate, unitId, propertyId, isCommon, utilityType])
}

export async function voidLandlordExpense(id: string, landlordId: string) {
  const row = await queryOne<{ id: string }>(
    `UPDATE landlord_expenses SET status='voided', voided_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND landlord_id=$2 AND status='active' RETURNING id`, [id, landlordId])
  if (!row) throw new AppError(404, 'Expense not found or already voided')
}

/** Total active landlord-entered expenses for a landlord in a date range (P&L). */
export async function landlordExpensesTotal(landlordId: string, from: string, to: string): Promise<number> {
  const r = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM landlord_expenses
      WHERE landlord_id=$1 AND status='active' AND expense_date >= $2 AND expense_date <= $3`,
    [landlordId, from, to])
  return Math.round(parseFloat(r?.total ?? '0') * 100) / 100
}

/**
 * Expense attributable to a single UNIT in a range, for per-unit P&L:
 * unit-linked expenses in full + EVERY non-unit-linked expense on the unit's
 * property divided by that property's unit count.
 *
 * S603 (Nic): allocation is unconditional. Any cost not tied to one unit gets
 * spread across all of them — "there's no reason to just have it sit higher at a
 * property level and not get factored into a per-unit cost." Pre-S603 this
 * required the landlord to tick `allocate_per_unit`, so an un-ticked insurance
 * bill dropped out of per-unit cost entirely and made units look cheaper to run
 * than they are. Divided by ALL units, not just occupied ones — a vacant unit
 * still carries its share, and dividing by occupied would spike costs as
 * occupancy falls.
 *
 * Must stay in lockstep with services/reportEngine.ts, which applies the same
 * rule; if these two drift, a landlord's per-unit cost differs by screen.
 */
export async function unitAllocatedExpenses(unitId: string, from: string, to: string): Promise<number> {
  const direct = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM landlord_expenses
      WHERE unit_id=$1 AND status='active' AND expense_date >= $2 AND expense_date <= $3`,
    [unitId, from, to])
  const allocated = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(e.amount / NULLIF(uc.n, 0)), 0)::text AS total
       FROM landlord_expenses e
       JOIN units target ON target.id = $1
       JOIN LATERAL (SELECT COUNT(*)::int AS n FROM units u2 WHERE u2.property_id = target.property_id) uc ON TRUE
      WHERE e.property_id = target.property_id AND e.unit_id IS NULL
        AND e.status='active'
        AND e.expense_date >= $2 AND e.expense_date <= $3`,
    [unitId, from, to])
  return Math.round((parseFloat(direct?.total ?? '0') + parseFloat(allocated?.total ?? '0')) * 100) / 100
}
