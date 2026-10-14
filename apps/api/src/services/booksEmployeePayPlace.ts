/**
 * 10/14 (Nic) — PAYROLL IS PLACED PER EMPLOYEE, SET ONCE
 *
 *   Nic, 10/14: "an employee at one property goes to that property ... once
 *   you set it it shouldnt change. if they work at multiple properties it
 *   would be at the company level". Each paycheck follows its employee's
 *   place.
 *
 * An employee of a landlord company says where their pay (the gross wages and
 * the employer's taxes on them) goes — books_employees.pay_place
 * (BOOKS_EMPLOYEE_PAY_PLACES, migration 20261016153000):
 *   property  the one property they work at (pay_property_id)
 *   company   company level — someone who works at several properties (the
 *             Company column, property NULL)
 * Asked on the employee form (routes/books.ts POST/PATCH /employees). An
 * employee with no place yet is asked before their next paycheck — a payroll
 * run naming them is refused until it is set.
 *
 * 10/14 afternoon (Nic): "Payroll place: the owner can change it; only future
 * paychecks follow." Set by anyone who keeps the books; CHANGED only by the
 * owner (a mistake, or the person moved) — a bookkeeper's or manager's
 * different answer is refused in words. Their next paychecks follow: the
 * paychecks on a payroll run still in draft move with it (not paid, never
 * posted). Every approved run stays exactly as it posted.
 *
 * Each paycheck copies its employee's place onto its own line
 * (payroll_run_lines.pay_place / pay_property_id) when the run is calculated,
 * so a posted run never moves. Runs approved before 10/14 keep the run's own
 * place (payroll_runs.cost_place) and post as they did.
 *
 * A business's books have no properties: nothing is asked of a business.
 */
import type { PoolClient } from 'pg'
import { BOOKS_EMPLOYEE_PAY_PLACES, BOOKS_EMPLOYEE_PAY_PLACE_LABEL, type BooksEmployeePayPlace } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'

type Q = Pick<PoolClient, 'query'>

/** Where an employee's pay goes, as saved. */
export interface EmployeePayPlace { place: BooksEmployeePayPlace; propertyId: string | null }

/** What the form is told when it saves a landlord company's employee with no place. */
export const EMPLOYEE_PAY_PLACE_REQUIRED =
  'Choose where this employee\'s pay goes: the one property they work at, or company level if they work at several.'

/** The run's refusal while employees on it have no place yet, naming them. */
export function payPlaceMissingRefusal(names: string[]): string {
  return `Set where ${names.length === 1 ? 'this employee\'s' : 'these employees\''} pay goes on the Employees page before `
    + `running payroll: ${names.join(', ')}.`
}

/**
 * The place the employee form sent (`payPlace`, `payPropertyId`), checked:
 * one of BOOKS_EMPLOYEE_PAY_PLACES; a property is this company's; company
 * level names none. `given` false when the form sent neither.
 */
export async function employeePayPlaceFrom(q: Q, landlordId: string | null, body: any): Promise<{ given: boolean; value: EmployeePayPlace | null }> {
  const sent = body && (Object.prototype.hasOwnProperty.call(body, 'payPlace') || Object.prototype.hasOwnProperty.call(body, 'payPropertyId'))
  if (!sent) return { given: false, value: null }
  const place = body.payPlace ?? null
  const propertyId = body.payPropertyId || null
  if (place === null && propertyId === null) return { given: true, value: null }
  if (!landlordId) throw new AppError(400, 'A business\'s books have no properties.')
  if (!(BOOKS_EMPLOYEE_PAY_PLACES as readonly unknown[]).includes(place)) throw new AppError(400, EMPLOYEE_PAY_PLACE_REQUIRED)
  if (place === 'company') {
    if (propertyId) throw new AppError(400, 'Company level names no one property.')
    return { given: true, value: { place, propertyId: null } }
  }
  if (!propertyId) throw new AppError(400, 'Choose the property this employee works at.')
  const p = (await q.query(`SELECT 1 FROM properties WHERE id = $1 AND landlord_id = $2`, [propertyId, landlordId])).rows[0]
  if (!p) throw new AppError(404, 'That property is not this company\'s.')
  return { given: true, value: { place, propertyId } }
}

/** The place in words, for a refusal ("Sunset Palms", "company level"). */
async function placeWords(q: Q, place: string, propertyId: string | null): Promise<string> {
  if (place === 'company') return 'company level'
  const name = (await q.query<{ name: string }>(`SELECT name FROM properties WHERE id = $1`, [propertyId])).rows[0]?.name
  return name ?? BOOKS_EMPLOYEE_PAY_PLACE_LABEL.property.toLowerCase()
}

/** What a bookkeeper or manager is told when they try to change a place already set. */
export const PAY_PLACE_OWNER_CHANGES = 'Only the owner can change where an employee\'s pay goes.'

/**
 * Sets an employee's place when it has none; the same answer again changes
 * nothing. A different one: 10/14 afternoon (Nic), "the owner can change it;
 * only future paychecks follow" — the owner's (`opts.owner`) is saved and the
 * employee's paychecks on runs still in draft move with it; anyone else's is
 * refused. `employee` is the row as read (pay_place, pay_property_id). Inside
 * the caller's transaction: the draft runs are locked before the employee,
 * the order an approval takes them (its run, then its employees' totals), so
 * a run approved at the same moment either posted first — and keeps its
 * place — or is still a draft and moves. Returns how many draft paychecks
 * moved.
 */
export async function setEmployeePayPlace(q: Q, employee: { id: string; pay_place: string | null; pay_property_id: string | null },
  value: EmployeePayPlace, by: string | null, opts: { owner?: boolean } = {}): Promise<{ draftPaychecksMoved: number }> {
  if (!employee.pay_place) {
    const set = await q.query(
      `UPDATE books_employees SET pay_place = $2, pay_property_id = $3, pay_place_set_at = NOW(), pay_place_set_by = $4,
              updated_at = NOW()
        WHERE id = $1 AND pay_place IS NULL`, [employee.id, value.place, value.propertyId, by])
    if (!set.rowCount) throw new AppError(409, 'This employee changed while you were saving. Reload and try again.')
    return { draftPaychecksMoved: 0 }
  }
  if (employee.pay_place === value.place && (employee.pay_property_id ?? null) === value.propertyId) return { draftPaychecksMoved: 0 }
  if (!opts.owner) {
    throw new AppError(403, `This employee's pay goes to ${await placeWords(q, employee.pay_place, employee.pay_property_id)}. `
      + PAY_PLACE_OWNER_CHANGES)
  }
  const drafts = (await q.query<{ id: string }>(
    `SELECT r.id FROM payroll_runs r
      WHERE r.status = 'draft'
        AND EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = r.id AND l.employee_id = $1)
      ORDER BY r.id FOR UPDATE OF r`, [employee.id])).rows.map(r => r.id)
  // Changed from what the person saw, or not at all: a second change made
  // meanwhile is never overwritten unseen.
  const changed = await q.query(
    `UPDATE books_employees SET pay_place = $2, pay_property_id = $3, pay_place_set_at = NOW(), pay_place_set_by = $4,
            updated_at = NOW()
      WHERE id = $1 AND pay_place = $5 AND pay_property_id IS NOT DISTINCT FROM $6::uuid`,
    [employee.id, value.place, value.propertyId, by, employee.pay_place, employee.pay_property_id])
  if (!changed.rowCount) throw new AppError(409, 'This employee changed while you were saving. Reload and try again.')
  // Only future paychecks follow: those on runs still in draft (locked above,
  // still a draft once locked). Approved and voided runs stay as they posted.
  const moved = drafts.length
    ? await q.query(
        `UPDATE payroll_run_lines l SET pay_place = $2, pay_property_id = $3
           FROM payroll_runs r
          WHERE r.id = l.run_id AND r.id = ANY($4::uuid[]) AND r.status = 'draft' AND l.employee_id = $1`,
        [employee.id, value.place, value.propertyId, drafts])
    : { rowCount: 0 }
  return { draftPaychecksMoved: moved.rowCount ?? 0 }
}

/**
 * Where a paycheck for this employee goes today: the employee's place, its
 * property still this company's. Null when the employee has no place yet
 * (the caller names them in one refusal).
 */
export async function paycheckPlaceOf(q: Q, landlordId: string,
  emp: { first_name: string; last_name: string; pay_place: string | null; pay_property_id: string | null }): Promise<EmployeePayPlace | null> {
  if (!emp.pay_place) return null
  if (emp.pay_place === 'company') return { place: 'company', propertyId: null }
  const p = (await q.query<{ name: string; landlord_id: string }>(
    `SELECT name, landlord_id FROM properties WHERE id = $1`, [emp.pay_property_id])).rows[0]
  if (!p || p.landlord_id !== landlordId) {
    throw new AppError(409, `${emp.first_name} ${emp.last_name}'s pay goes to ${p?.name ?? 'a property'}, which is no longer this company's.`)
  }
  return { place: 'property', propertyId: emp.pay_property_id }
}
