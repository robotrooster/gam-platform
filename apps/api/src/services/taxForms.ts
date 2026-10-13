/**
 * S203: tax-form catalog helper.
 *
 * Resolves which forms apply to a given landlord based on their
 * property states + employee/contractor presence. Federal forms
 * (state_code='US') with applies_to='with_employees_in_state' fire
 * when the landlord has any books_employees row; the
 * 'with_contractors_paid_600' federal form fires when the landlord
 * has 1099-NEC contractor payments. State forms (state_code='AZ',
 * 'CA', etc.) with applies_to='with_property_in_state' fire when
 * the landlord owns any properties in that state.
 *
 * Per CLAUDE.md S177 carve-out: surface deadlines, never file. The
 * catalog itself is hardcoded with annual-refresh migration cadence.
 */

import { query } from '../db'
import { form1099NecThreshold, FORM_1099_NOT_REPORTED_PAYMENT_METHODS } from '@gam/shared'

export interface TaxFormDeadline {
  state_code:     string
  form_code:      string
  form_name:      string
  agency:         string
  agency_url:     string | null
  category:       string
  frequency:      string
  due_dates:      Array<{ label: string; due: string }>
  statute:        string | null
  notes:          string | null
  filing_method:  'paper_form' | 'online_portal'
}

interface LandlordContext {
  has_employees:                 boolean
  has_contractors_paid_600_plus: boolean
  property_states:               string[]
}

/**
 * Pull the landlord's context — employees, 1099 contractors, and
 * property states — to determine which catalog rows apply.
 */
async function getLandlordContext(landlordId: string, year: number): Promise<LandlordContext> {
  const ctx = await query<{
    has_employees:        boolean
    has_contractors:      boolean
    property_states:      string[] | null
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM books_employees
          WHERE landlord_id = $1 AND status = 'active'
       ) AS has_employees,
       -- 10/12 (Nic): a vendor with the 1099 box paid at least the year's
       -- 1099-NEC threshold in the tax year (its payments, card payments left
       -- out — the card company reports those; services/booksVendorsLoans).
       -- It read books_contractors.ytd_paid, a running number nothing added to.
       EXISTS (
         SELECT 1 FROM books_vendors v
          WHERE v.landlord_id = $1 AND v.is_1099
            AND (SELECT COALESCE(sum(p.amount), 0)
                   FROM landlord_expense_payments p JOIN landlord_expenses e ON e.id = p.expense_id
                  WHERE e.vendor_id = v.id AND e.status = 'active' AND p.voided_at IS NULL
                    AND NOT (p.method = ANY($4::text[]))
                    AND p.paid_on >= make_date($2::int, 1, 1) AND p.paid_on < make_date($2::int + 1, 1, 1)) >= $3::numeric
       ) AS has_contractors,
       (
         SELECT ARRAY_AGG(DISTINCT state)
           FROM properties
          WHERE landlord_id = $1
            AND state IS NOT NULL
       ) AS property_states`,
    [landlordId, year, form1099NecThreshold(year), [...FORM_1099_NOT_REPORTED_PAYMENT_METHODS]],
  )

  const row = ctx[0]
  return {
    has_employees:                 row?.has_employees ?? false,
    has_contractors_paid_600_plus: row?.has_contractors ?? false,
    property_states:               row?.property_states ?? [],
  }
}

/**
 * Return tax-form deadlines applicable to this landlord for the
 * given calendar year. Combines federal forms (US state_code) and
 * per-state forms (matching property_states).
 */
export async function getApplicableTaxForms(
  landlordId: string,
  year: number,
): Promise<TaxFormDeadline[]> {
  const ctx = await getLandlordContext(landlordId, year)

  // Build the applies_to filter list based on landlord context.
  const appliesFilters: string[] = ['all_landlords']
  if (ctx.has_employees) appliesFilters.push('with_employees_in_state')
  if (ctx.has_contractors_paid_600_plus) appliesFilters.push('with_contractors_paid_600')

  // Property-in-state form lookup. We always include federal forms;
  // state forms only when landlord owns property in that state.
  const stateFilters = ['US', ...ctx.property_states]

  const rows = await query<{
    state_code: string
    form_code: string
    form_name: string
    agency: string
    agency_url: string | null
    category: string
    frequency: string
    due_dates: Array<{ label: string; due: string }>
    statute: string | null
    notes: string | null
    filing_method: 'paper_form' | 'online_portal'
  }>(
    `SELECT state_code, form_code, form_name, agency, agency_url,
            category, frequency, due_dates, statute, notes, filing_method
       FROM state_tax_forms
      WHERE effective_year = $1
        AND state_code = ANY($2::text[])
        AND (
          applies_to = ANY($3::text[])
          OR (applies_to = 'with_property_in_state' AND state_code = ANY($4::text[]))
        )
      ORDER BY
        CASE state_code WHEN 'US' THEN 0 ELSE 1 END,
        state_code,
        category,
        form_code`,
    [year, stateFilters, appliesFilters, ctx.property_states],
  )

  return rows.map((r) => ({
    state_code:    r.state_code,
    form_code:     r.form_code,
    form_name:     r.form_name,
    agency:        r.agency,
    agency_url:    r.agency_url,
    category:      r.category,
    frequency:     r.frequency,
    due_dates:     r.due_dates,
    statute:       r.statute,
    notes:         r.notes,
    filing_method: r.filing_method,
  }))
}
