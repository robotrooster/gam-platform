/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE PROJECTORS AND TIE-OUTS PRODUCTION RUNS WITH
 *
 * One registration per source type, added by the phase that writes it
 * (gam-ledger-design-2026-10-12 phases):
 *   P4  tenant money and the opening posting (services/ledgerProjectors/
 *       tenantMoney: bills, receipts, credits and paid-ahead money, deposits
 *       and move-out, money taken back, the opening posting and home sales)
 *   P5  the register, bookings and the payout chain (services/ledgerProjectors/
 *       registerBookingPayoutAll: sales, refunds, set-aside payments, stays,
 *       allocations, held lines, transfers, payouts, GAM's charges and debits)
 *   P7  payroll and the bookkeeper's journal entries (services/
 *       ledgerProjectors/payrollJournalAll: an approved payroll run on its pay
 *       date, a posted journal entry as entered)
 *   P6  money out is one record (services/ledgerProjectors/moneyOut: an
 *       expense incurred and each payment toward it, money in filed as other
 *       income, and a money-out bank line matched to a record GAM already has
 *       — its part of 'bank_match'), with the Accounts payable tie-out
 * Until a source type is registered here, its outbox rows wait and nothing
 * posts for it. 10/12 (Nic, ledger review): every source type the capture
 * triggers name is either posted by a projector here or listed in
 * LEDGER_SOURCE_TYPES_NOT_POSTED_YET with why (ledgerCoverage.test.ts holds
 * them together), so nothing waits without a written reason.
 *
 * ONE PROJECTOR PER SOURCE TYPE (the engine's rule). A source type more than
 * one phase posts from is registered once here, as the concatenation of each
 * phase's part: 'bank_match' — a bank line matched to a tenant's bank-deposit
 * receipt (P4, design B5/B6) today; a GAM fee debit (H5) and an expense
 * payment (P6, I2) join it when those matches exist. A bank line is only ever
 * one of those, so the parts never want the same posting. 10/12 (Nic,
 * integrate): a bank line matched to a loan (matched_kind 'loan_payment' /
 * 'loan_funding') is no part of 'bank_match' — the loan record names the line
 * and posts the bank side itself ('loan_payment', 'loan', on the bank's day),
 * so neither bank_match part posts for it.
 *
 * THE NIGHTLY TIE-OUTS are registered beside them (services/ledgerCheck):
 * the minute drain, the nightly check, a month close and the ledger:rebuild /
 * ledger:check scripts all call this first, so every one of them posts and
 * checks with the same set.
 */
import type { LedgerSourceType } from '@gam/shared'
import {
  registerLedgerProjector, unregisterLedgerProjector, type LedgerProjector, type LedgerSourceRef,
} from './ledgerEngine'
import { registerLedgerCheck, unregisterLedgerCheck, type LedgerCheck } from './ledgerCheck'
import { TENANT_LEDGER_PROJECTORS, TENANT_SHARED_SOURCE_TYPES } from './ledgerProjectors/tenantMoney'
import { P5_LEDGER_PROJECTORS, P5_LEDGER_CHECKS } from './ledgerProjectors/registerBookingPayoutAll'
import { P7_LEDGER_PROJECTORS } from './ledgerProjectors/payrollJournalAll'
// 10/12 (Nic, ledger P6): loans (the money a loan put on the books, each
// payment's principal / interest / escrow) and fixed assets (their opening and
// each month's depreciation).
import { LOANS_ASSETS_LEDGER_PROJECTORS } from './ledgerProjectors/loansAssets'
import { TENANT_LEDGER_CHECKS } from './ledgerTenantChecks'
// 10/12 (Nic, ledger P6): money out is one record — expenses, their payments,
// other income, and money-out bank lines matched to a record (design §12).
import { P6_LEDGER_PROJECTORS } from './ledgerProjectors/moneyOut'
import { P6_LEDGER_CHECKS } from './ledgerProjectors/moneyOutChecks'
import { dueFromGamCheck, soldPropertyReceiptsCheck } from './ledgerDueFromGamCheck'
import { bankAccountsCheck } from './bankReconciliation'
// 10/12 (Nic): work-trade extra hours post as what paid them (an expense, a
// payroll run), never by themselves — registered so their marks drain.
import { workTradeHoursProjector } from './ledgerProjectors/workTradeHours'

/**
 * 10/12 (Nic, ledger review): the source types no projector posts yet, and
 * why. Their outbox rows wait (the drain only works registered types) and the
 * nightly tie-outs never count them as "still posting" (services/
 * ledgerPending): they are not drained by anything yet.
 */
export const LEDGER_SOURCE_TYPES_NOT_POSTED_YET: Readonly<Partial<Record<LedgerSourceType, string>>> = {
  // 10/13 (Nic): reader_order left this list — design Q11 answered ("each
  // $87.50 → SUPPLIES, in the month GAM COLLECTED it"): the order posts
  // nothing and each piece posts when collected (ledgerProjectors/payoutGamCharges).
  // 10/12 (Nic): work_trade_hours left this list — Mark paid now records a
  // PAID expense under "Work trade labor" (services/workTradeBooksPay), so every
  // way extra hours are paid posts through its own record and the hours post
  // nothing themselves (ledgerProjectors/workTradeHours).
}

/**
 * One projector for a source type several phases post from: each part's
 * postings, one after another, and the union of the sources they list (a
 * source both list keeps its earliest day).
 */
export function composeLedgerProjector(sourceType: LedgerSourceType, parts: readonly LedgerProjector[]): LedgerProjector {
  if (parts.length === 0) throw new Error(`No parts for ${sourceType}`)
  for (const p of parts) {
    if (p.sourceType !== sourceType) throw new Error(`A ${p.sourceType} part cannot post ${sourceType}`)
  }
  if (parts.length === 1) return parts[0]
  return {
    sourceType,
    ruleVersion: Math.max(...parts.map(p => p.ruleVersion)),
    async project(client, sourceId) {
      const out = []
      for (const p of parts) out.push(...await p.project(client, sourceId))
      return out
    },
    async listSources(client, owner, opts) {
      const seen = new Map<string, LedgerSourceRef>()
      for (const p of parts) {
        for (const r of await p.listSources(client, owner, opts)) {
          const prior = seen.get(r.id)
          if (!prior || (r.day && (!prior.day || r.day < prior.day))) seen.set(r.id, r)
        }
      }
      return [...seen.values()]
    },
  }
}

/** Every phase's projectors, merged to one per source type. */
export function productionLedgerProjectors(): LedgerProjector[] {
  const byType = new Map<LedgerSourceType, LedgerProjector[]>()
  for (const p of [...TENANT_LEDGER_PROJECTORS, ...P5_LEDGER_PROJECTORS, ...P6_LEDGER_PROJECTORS, ...P7_LEDGER_PROJECTORS, ...LOANS_ASSETS_LEDGER_PROJECTORS,
                   workTradeHoursProjector]) {
    byType.set(p.sourceType, [...(byType.get(p.sourceType) ?? []), p])
  }
  const shared = new Set<string>(TENANT_SHARED_SOURCE_TYPES)
  const out: LedgerProjector[] = []
  for (const [type, parts] of byType) {
    // Two phases posting one source type is only ever a deliberate merge.
    if (parts.length > 1 && !shared.has(type)) {
      throw new Error(`Two phases post ${type}; name it as shared and merge the parts on purpose.`)
    }
    out.push(composeLedgerProjector(type, parts))
  }
  return out
}

/** Every tie-out the nightly check runs: tenant money (P4), the payout chain (P5) and Due from GAM (1050). */
export const PRODUCTION_LEDGER_CHECKS: readonly LedgerCheck[] = [
  ...TENANT_LEDGER_CHECKS,
  ...P5_LEDGER_CHECKS,
  ...P6_LEDGER_CHECKS,
  dueFromGamCheck,
  soldPropertyReceiptsCheck,
  // 10/12 (Nic, ledger P9, §8): each bank account, informational (never drift, never a block).
  bankAccountsCheck,
]

let registered = false

export function registerProductionLedgerProjectors(): void {
  if (registered) return
  registered = true
  for (const p of productionLedgerProjectors()) registerLedgerProjector(p)
  for (const c of PRODUCTION_LEDGER_CHECKS) registerLedgerCheck(c)
}

/** Tests: take the production set back off (so a test can register only its own). */
export function unregisterProductionLedgerProjectors(): void {
  registered = false
  for (const p of productionLedgerProjectors()) unregisterLedgerProjector(p.sourceType)
  for (const c of PRODUCTION_LEDGER_CHECKS) unregisterLedgerCheck(c.name)
}
