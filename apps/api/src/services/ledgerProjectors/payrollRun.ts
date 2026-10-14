/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: PAYROLL POSTS ON THE PAY DATE
 * (gam-ledger-design-2026-10-12 §6 J3)
 *
 * Source 'payroll_run' = one payroll_runs row and its paychecks
 * (payroll_run_lines). An APPROVED run posts once, dated its pay date (the
 * company's calendar day the wages are paid — wages belong to the day they are
 * paid, the same day year-to-date counts them):
 *
 *   Dr Payroll (5120)                       gross pay
 *   Dr Employer payroll taxes (5125)        the employer's Social Security and
 *                                           Medicare, federal and state
 *                                           unemployment tax (recorded on each
 *                                           paycheck, migration 20261014200100)
 *   Cr Payroll liabilities: federal withholding (2031)   federal income tax withheld
 *   Cr Payroll liabilities: state withholding (2032)     state income tax withheld
 *   Cr Payroll liabilities: Social Security and Medicare (2033)
 *                                           both halves: withheld + the employer's
 *   Cr Payroll liabilities: federal unemployment tax (2034)
 *   Cr Payroll liabilities: state unemployment tax (2036)
 *   Cr Payroll liabilities (2030)           any other deduction withheld
 *   Cr Net pay payable (2035)               the take-home pay
 *
 * Each paycheck must add up (gross = everything withheld + take-home); a run
 * that does not is refused by name rather than posted crooked.
 *
 * WHERE IT LANDS (companyCosts): 10/13 (Nic) — "each expense is chosen on the
 * split or specific unit or property at the time of logging", and payroll is
 * logged by a person, so the run says where its two expense lines go when it
 * is logged (payroll_runs.cost_place): split across the properties by units on
 * the pay date, one property, or one unit. A run approved before 10/13 (no
 * place) stays in the Company column, as it posted. What is owed stays
 * company level (one tax account, one payroll).
 * 10/14 (Nic): "an employee at one property goes to that property ... if
 * they work at multiple properties it would be at the company level" — each
 * paycheck carries its employee's place (payroll_run_lines.pay_place,
 * services/booksEmployeePayPlace): its property, or the Company column for
 * company level. Paychecks are grouped by place and each group's wages and
 * employer taxes land there. A paycheck with no place (a run approved before
 * 10/14) is placed by the run's own cost_place, so those runs post exactly as
 * they did.
 *
 * WHAT CLEARS IT: the run's take-home pay and each tax it left owed become
 * unpaid expenses on the Expenses record when the run is approved
 * (services/payrollMoneyOut, phase P6's record): their posting moves the
 * liability to Accounts payable, and the bank line that pays one clears it.
 *
 * A draft posts nothing. A voided run posts nothing: an approved run that is
 * voided is taken back by the engine (a correction — its own day when the
 * month is closed). A business's payroll waits for the business portal's own
 * books (a later phase).
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr } from './registerBookingPayoutKit'
import { cSql, isUuid } from './tenantShared'
import type { BooksCostPlace } from '@gam/shared'
import { costPlaceSpread, drSpread, COMPANY_COLUMN, type CostSpread } from './companyCosts'

// 10/13 (Nic): 2 — the run's own cost_place says where its wages go, never a setting.
// 10/14 (Nic): 3 — each paycheck's own place (its employee's) wins; runs before it post as they did.
export const PAYROLL_RULE_VERSION = 3

interface RunRow {
  landlord_id: string | null
  status: string
  voided_at: string | null
  pay_date: string
  /** 10/13 (Nic): where the person logging the run said its wages go (null: approved before 10/13). */
  cost_place: BooksCostPlace | null
  /** 10/13 review: when the run was logged (a split reads the units in GAM by then too). */
  logged_at: string
  property_id: string | null
  unit_id: string | null
}

interface LineSums {
  n: number
  gross: string; fed: string; state: string; ss: string; med: string; other: string; net: string
  er_ss: string; er_med: string; futa: string; suta: string
  /** Paychecks that do not add up (gross ≠ withheld + take-home), cents. */
  crooked: number
}

export const payrollRunProjector: LedgerProjector = {
  sourceType: 'payroll_run',
  ruleVersion: PAYROLL_RULE_VERSION,

  async project(client: PoolClient, runId: string): Promise<DesiredPosting[]> {
    if (!isUuid(runId)) return []
    const run = (await client.query<RunRow>(
      `SELECT r.landlord_id, r.status, r.voided_at::text AS voided_at, r.pay_date::text AS pay_date,
              r.cost_place, r.property_id, r.unit_id, r.created_at::text AS logged_at
         FROM payroll_runs r WHERE r.id = $1`, [runId])).rows[0]
    // A business's payroll waits for the business portal's books (a later phase).
    if (!run || !run.landlord_id) return []
    if (run.status !== 'approved' || run.voided_at) return []

    const s = (await client.query<LineSums>(
      `SELECT count(*)::int AS n,
              ${cSql('COALESCE(sum(gross_pay), 0)')} AS gross,
              ${cSql('COALESCE(sum(federal_tax), 0)')} AS fed,
              ${cSql('COALESCE(sum(state_tax), 0)')} AS state,
              ${cSql('COALESCE(sum(ss_tax), 0)')} AS ss,
              ${cSql('COALESCE(sum(medicare_tax), 0)')} AS med,
              ${cSql('COALESCE(sum(COALESCE(other_deductions, 0)), 0)')} AS other,
              ${cSql('COALESCE(sum(net_pay), 0)')} AS net,
              ${cSql('COALESCE(sum(employer_ss_tax), 0)')} AS er_ss,
              ${cSql('COALESCE(sum(employer_medicare_tax), 0)')} AS er_med,
              ${cSql('COALESCE(sum(futa_tax), 0)')} AS futa,
              ${cSql('COALESCE(sum(suta_tax), 0)')} AS suta,
              count(*) FILTER (WHERE gross_pay <> federal_tax + state_tax + ss_tax + medicare_tax
                                                 + COALESCE(other_deductions, 0) + net_pay)::int AS crooked
         FROM payroll_run_lines WHERE run_id = $1`, [runId])).rows[0]
    if (!s || s.n === 0) return []
    if (s.crooked > 0) {
      throw new LedgerSourceError('projector_error',
        `Payroll run ${runId}: ${s.crooked} paycheck(s) do not add up (gross pay is not the withholding plus the take-home pay). Fix the run before it can post.`)
    }
    const c = (v: string) => Number(v)
    const landlordId = run.landlord_id
    // 10/14 (Nic): the wages and employer taxes by paycheck place. A paycheck
    // with no place of its own (a run approved before 10/14) is placed by the
    // run, as it posted.
    const groups = (await client.query<{ pay_place: string | null; pay_property_id: string | null; gross: string; er: string }>(
      `SELECT pay_place, pay_property_id,
              ${cSql('COALESCE(sum(gross_pay), 0)')} AS gross,
              ${cSql('COALESCE(sum(employer_ss_tax), 0) + COALESCE(sum(employer_medicare_tax), 0) + COALESCE(sum(futa_tax), 0) + COALESCE(sum(suta_tax), 0)')} AS er
         FROM payroll_run_lines WHERE run_id = $1
        GROUP BY pay_place, pay_property_id
        ORDER BY (pay_place IS NOT NULL), pay_place, pay_property_id`, [runId])).rows
    const memo = `Payroll paid ${run.pay_date}`
    const owed = { propertyId: null }
    const wages: DesiredLine[] = []
    const employerTaxLines: DesiredLine[] = []
    for (const g of groups) {
      const spread: CostSpread = g.pay_place === 'property' && g.pay_property_id
        ? [{ propertyId: g.pay_property_id, weight: 1 }]
        : g.pay_place === 'company'
          ? COMPANY_COLUMN
          : await costPlaceSpread(client, landlordId, run.pay_date,
            { costPlace: run.cost_place, propertyId: run.property_id, unitId: run.unit_id, loggedAt: run.logged_at })
      wages.push(...drSpread('payroll_expense', c(g.gross), spread, { memo: 'Gross wages' }))
      employerTaxLines.push(...drSpread('employer_payroll_taxes', c(g.er), spread, { memo: 'Employer Social Security, Medicare and unemployment tax' }))
    }
    const lines: DesiredLine[] = [
      ...wages,
      ...employerTaxLines,
      ...cr('payroll_federal_withholding', c(s.fed), { ...owed, memo: 'Federal income tax withheld' }),
      ...cr('payroll_state_withholding', c(s.state), { ...owed, memo: 'State income tax withheld' }),
      ...cr('payroll_fica', c(s.ss) + c(s.med) + c(s.er_ss) + c(s.er_med), { ...owed, memo: 'Social Security and Medicare, withheld and the employer\'s' }),
      ...cr('payroll_futa', c(s.futa), { ...owed, memo: 'Federal unemployment tax' }),
      ...cr('payroll_suta', c(s.suta), { ...owed, memo: 'State unemployment tax' }),
      ...cr('payroll_liabilities', c(s.other), { ...owed, memo: 'Other deductions withheld' }),
      ...cr('net_pay_payable', c(s.net), { ...owed, memo: 'Take-home pay' }),
    ]
    if (!lines.length) return []
    return [{ owner: { landlordId }, intendedDate: run.pay_date, memo, lines }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT r.id::text AS id, r.pay_date::text AS day FROM payroll_runs r
        WHERE r.landlord_id = $1 AND r.status <> 'draft' AND ($2::date IS NULL OR r.pay_date >= $2::date)
        ORDER BY r.pay_date, r.id`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
