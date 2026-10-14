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
 * Asked on the employee form (routes/books.ts POST/PATCH /employees). Once
 * set it does not change: a different answer is refused in words. An
 * employee with no place yet is asked before their next paycheck — a payroll
 * run naming them is refused until it is set.
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

/**
 * Sets an employee's place when it has none; the same answer again changes
 * nothing; a different one is refused ("once you set it it shouldnt
 * change"). `employee` is the row as read (pay_place, pay_property_id).
 */
export async function setEmployeePayPlace(q: Q, employee: { id: string; pay_place: string | null; pay_property_id: string | null },
  value: EmployeePayPlace, by: string | null): Promise<void> {
  if (employee.pay_place) {
    if (employee.pay_place === value.place && (employee.pay_property_id ?? null) === value.propertyId) return
    throw new AppError(409, `This employee's pay goes to ${await placeWords(q, employee.pay_place, employee.pay_property_id)}. `
      + 'Once set, where an employee\'s pay goes does not change.')
  }
  await q.query(
    `UPDATE books_employees SET pay_place = $2, pay_property_id = $3, pay_place_set_at = NOW(), pay_place_set_by = $4,
            updated_at = NOW()
      WHERE id = $1 AND pay_place IS NULL`, [employee.id, value.place, value.propertyId, by])
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
