/**
 * S550 — conditional-fee detection + the every-dollar audit.
 *
 * Pure-function tests: detectConditionalFees / auditUnattributedAmounts
 * operate on Page[] text only, so pages are faked as { items: [{ text }] }.
 *
 * The contract under test:
 *   (1) "if you don't do X, then $Y" clauses become conditional fees with
 *       the clause verbatim (lease-is-law) — the carpet clause is canonical,
 *       including the two-sentence form where the $ lands in "Failure to do
 *       so…".
 *   (2) Amounts already handled by dedicated extractors (late fee, security
 *       deposit, rent) are never re-reported.
 *   (3) The audit surfaces EVERY dollar amount not attributed to a known
 *       extraction — the "no financial liability slips through" guarantee.
 */
import { describe, it, expect } from 'vitest'
import { detectConditionalFees, auditUnattributedAmounts } from './extractors'

function pages(text: string): any[] {
  return [{ items: text.split(/\s+/).map(t => ({ text: t })) }]
}

describe('detectConditionalFees', () => {
  it('canonical carpet clause (two sentences, "Failure to do so")', () => {
    const fees = detectConditionalFees(pages(
      'Tenant shall have the carpets professionally cleaned within three (3) days of move-out and provide a receipt. ' +
      'Failure to do so will result in a charge of $150.00 deducted from the security deposit refund.'
    ))
    expect(fees).toHaveLength(1)
    expect(fees[0].label).toBe('Carpet cleaning')
    expect(fees[0].amount).toBe(150)
    expect(fees[0].conditionText.toLowerCase()).toContain('carpet')
    expect(fees[0].conditionText).toContain('$150')
  })

  it('single-sentence conditional ("if Tenant does not …")', () => {
    const fees = detectConditionalFees(pages(
      'If Tenant does not return all keys and remotes at move-out, Tenant will be charged $25.00 per missing item.'
    ))
    expect(fees).toHaveLength(1)
    expect(fees[0].label).toBe('Keys / locks')
    expect(fees[0].amount).toBe(25)
  })

  it('multiple obligations in one document each come back', () => {
    const fees = detectConditionalFees(pages(
      'Smoking is prohibited inside the unit; violation of this rule will be assessed a $250 remediation charge. ' +
      'Tenant shall maintain the yard. Failure to maintain the lawn will result in a $75.00 charge per occurrence.'
    ))
    const amounts = fees.map(f => f.amount).sort((a, b) => a - b)
    expect(amounts).toEqual([75, 250])
    expect(fees.find(f => f.amount === 250)!.label).toBe('Smoking violation')
    expect(fees.find(f => f.amount === 75)!.label).toBe('Yard upkeep')
  })

  it('late-fee and security-deposit clauses are NOT conditional fees (dedicated extractors own them)', () => {
    const fees = detectConditionalFees(pages(
      'A late charge of Five dollars ($5.00) per day applies if rent is not remitted by the 5th day. ' +
      'Security Deposit: One payment of $800.00 due at signing.'
    ))
    expect(fees).toHaveLength(0)
  })

  it('a plain dollar mention without obligation language is not a fee', () => {
    const fees = detectConditionalFees(pages(
      'The clubhouse rents for $40 per afternoon through the office.'
    ))
    expect(fees).toHaveLength(0)
  })
})

describe('auditUnattributedAmounts', () => {
  it('flags every dollar amount not attributed to a known extraction', () => {
    const out = auditUnattributedAmounts(pages(
      'Monthly rent is due in monthly installments of $900.00. ' +
      'A pet deposit of $500.00 is due prior to any animal occupying the unit. ' +
      'The clubhouse rents for $40.00 per afternoon.'
    ), [900])
    const amounts = out.map(o => o.amount).sort((a, b) => a - b)
    expect(amounts).toEqual([40, 500])
    expect(out.find(o => o.amount === 500)!.context.toLowerCase()).toContain('pet deposit')
  })

  it('attributed amounts and dedicated-extractor clauses stay silent', () => {
    const out = auditUnattributedAmounts(pages(
      'Rent is payable in monthly installments of $900.00. ' +
      'A late charge of $5.00 per day applies thereafter.'
    ), [900, 5])
    expect(out).toHaveLength(0)
  })
})
