/**
 * 10/12 (Nic) — GAM Books ledger: projectors read FACTS, never current state
 * (gam-ledger-design-2026-10-12 §8, "Projector rule (lint test
 * ledgerProjectorPurity.test.ts)").
 *
 * A projector turns a source's committed rows into the postings it wants, and
 * a rebuild must come out the same tomorrow as today. So a projector never
 * reads what changes for reasons that are not this source's money:
 *   - v_payment_money.gam_held_part, payments.platform_held,
 *     released_by_deposit_return_id (where GAM's copy of the money sits now)
 *   - landlord_gam_charges.collected_amount (use the collections table)
 *   - books_accounts (accounts come from the map, by role, on the line's day)
 *   - today's property settings (who pays the fee, the tax rate)
 * and it never writes, and never locks a money row (a poster must hold no lock
 * a money write could wait on, §3).
 *
 * The files checked: every services/ledger*Projector*.ts and anything under
 * services/ledgerProjectors/ (where the P4-P7 projectors go).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { registerProductionLedgerProjectors } from './ledgerProjectors'
import { registeredLedgerSourceTypes, ledgerProjectorFor } from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'

const SERVICES = __dirname

function projectorFiles(): string[] {
  const out = fs.readdirSync(SERVICES)
    .filter(f => /^ledger\w*Projector\w*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .map(f => path.join(SERVICES, f))
  const dir = path.join(SERVICES, 'ledgerProjectors')
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.ts') && !f.endsWith('.test.ts')) out.push(path.join(dir, f))
  }
  return out
}

/** Comment-free source: the rules are about what the code does, not what a comment explains. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const FORBIDDEN: [RegExp, string][] = [
  [/gam_held_part/, 'reads where GAM\'s copy of the money sits now (v_payment_money.gam_held_part)'],
  [/platform_held/, 'reads payments.platform_held (current state)'],
  [/released_by_deposit_return_id/, 'reads a release stamp (current state)'],
  [/collected_amount/, 'reads landlord_gam_charges.collected_amount (use landlord_gam_charge_collections)'],
  [/books_accounts/, 'reads the chart directly (lines name a posting role; the map resolves it)'],
  [/fee_payer/, 'reads today\'s fee-payer setting'],
  [/short_term_tax_rate|lodging_tax_rate/, 'reads today\'s tax rate (use the stored tax amount)'],
  [/\bFOR\s+(NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(KEY\s+)?SHARE\b|pg_advisory/i, 'locks a row'],
  [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i, 'writes'],
]

describe('ledger projector purity', () => {
  it('finds the projector files', () => {
    expect(projectorFiles().map(f => path.basename(f))).toContain('ledgerTestProjector.ts')
  })

  it('no projector reads current state, locks a row, or writes', () => {
    const offences: string[] = []
    for (const f of projectorFiles()) {
      const src = code(f)
      for (const [re, why] of FORBIDDEN) if (re.test(src)) offences.push(`${path.relative(SERVICES, f)}: ${why}`)
    }
    expect(offences).toEqual([])
  })

  // 10/12 (Nic, ledger integrate): P4 (tenant money, opening) and P5 (register,
  // bookings, payout chain) post in production; one projector per source type
  // (bank_match is P4's part, merged once P6 adds its own). Never the test
  // projector, and never the card reader order while Nic has not said whether
  // the reader is equipment the landlord owns or an expense per piece (design Q11).
  it('production registers the P4 and P5 projectors, one per source type, and never the test one', () => {
    registerProductionLedgerProjectors()
    expect([...registeredLedgerSourceTypes()].sort()).toEqual([
      'allocation', 'bank_match', 'booking', 'connect_payout', 'credit_use', 'deposit_return', 'deposit_slip',
      'disbursement',
      // 10/12 (Nic, ledger P6): money out is one record — an expense and each payment on it (design I1, I2).
      'expense', 'expense_payment',
      // 10/12 (Nic, ledger P6 — vendors, loans and assets): a fixed asset, a loan and each loan payment.
      'fixed_asset',
      'gam_charge', 'gam_debit', 'held_item', 'home_installment', 'home_sale', 'instant_margin', 'loan', 'loan_payment',
      // 10/12 (Nic, ledger P7): a bookkeeper's journal entry and a payroll run (design J3, J4).
      'manual_journal',
      // 10/12 (Nic, ledger P6): money in filed as other income (design I4).
      'opening', 'other_income', 'payment', 'payment_reversal', 'payroll_run',
      'pos_eod', 'pos_held', 'pos_refund', 'pos_sale', 'prepaid_credit',
      // 10/12 (Nic, ledger review): a property sold to another company (design G5).
      'property_transfer',
      'refund_part', 'remittance', 'security_deposit', 'transfer_intent',
      // 10/12 (Nic): work-trade extra hours drain and post nothing themselves —
      // they post as what paid them (an expense, a payroll run).
      'work_trade_hours',
    ])
    // 10/12 (ledger P6): other income posts through its production projector, never the engine's test one.
    expect(ledgerProjectorFor('other_income')).not.toBe(otherIncomeTestProjector)
    expect(registeredLedgerSourceTypes()).not.toContain('reader_order')
    expect(code(path.join(SERVICES, 'ledgerProjectors.ts'))).not.toMatch(/ledgerTestProjector/)
  })
})
