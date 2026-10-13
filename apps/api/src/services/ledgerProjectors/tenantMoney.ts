/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4: TENANT MONEY POSTS ITSELF
 * (gam-ledger-design-2026-10-12 §6 A-E and J; phase P4)
 *
 * The tenant-money projectors, one per source type, ready for the integrate
 * step to register (services/ledgerProjectors.registerProductionLedgerProjectors
 * — this lane does not edit that registry; registerTenantLedgerProjectors below
 * is the one call it needs). Each family lives in its own file:
 *
 *   tenantCharges    A  bills (A1-A9) and home installments paid outside GAM (A7b)
 *   tenantReceipts   B  receipts (B1-B5), bank lines and deposit slips reaching
 *                       the bank (B5/B6, B8), the register drawer (B9), bills
 *                       settled with no receipt (B7, B10)
 *   tenantCredits    C  credits spent (C1-C4, C7, C9, C10), paid-ahead money
 *                       arriving (B2, C8), work-trade hours (C5)
 *   tenantDeposits   D  deposits in installments (D2), move-out (D3), bills the
 *                       deposit paid, refund parts (D4)
 *   tenantReversals  E  money taken back after it settled (E1)
 *   tenantOpening    J  the opening posting (J1) and home sales (J2)
 *
 * ONE SOURCE TYPE, SEVERAL FAMILIES: a bill row (`payment:<id>`) posts its
 * charge (A, kind 'charge'), how it settled with no receipt (B7
 * 'prior_arrangement', B10 'gam_cover'), the work-trade hours on it (C5
 * 'work_trade') and the deposit paying it at move-out ('paid_from_deposit') —
 * each its own posting, so each restates on its own.
 *
 * SHARED WITH ANOTHER PHASE: 'bank_match' — this phase posts a bank line
 * matched to a tenant's bank-deposit receipt (B5/B6); phase P5 matches GAM fee
 * debits (H5) and P6 expense payments to bank lines. The engine registers one
 * projector per source type, so the integrate step registers a bank_match
 * projector that returns the concatenation of every phase's part
 * (projectBankMatchTenant here). A bank line is only ever one of those, so the
 * parts never collide on a posting kind.
 *
 * L13 (Nic 10/12) AND THE HELD PAYOUT ITEMS (phase P5, design G4): paid-ahead
 * money GAM holds is not on the landlord's balance sheet, so there is no 1055
 * here. When GAM-held paid-ahead money pays a bill (C1), is kept at an ended
 * lease (C7) or is used at move-out (C10), THIS phase books Dr 1050 Due from
 * GAM on the day it is used; P5's 'prepaid_draw' held item must therefore post
 * nothing (it only feeds the 1050 check), or the money would be counted twice.
 */
import type { PoolClient } from 'pg'
import {
  type DesiredPosting, type LedgerProjector, type LedgerSourceRef, registerLedgerProjector, unregisterLedgerProjector,
} from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { loadPaymentFacts, loadCompanyBooks, localDaySql, propertyTzSql, leasePropertySql, isUuid } from './tenantShared'
import { projectCharge, homeInstallmentProjector, TENANT_CHARGES_RULE_VERSION } from './tenantCharges'
import {
  remittanceProjector, projectRowSettlement, bankMatchTenantProjector, depositSlipProjector, posEodProjector,
  TENANT_RECEIPTS_RULE_VERSION,
} from './tenantReceipts'
import { creditUseProjector, prepaidCreditProjector, projectWorkTrade, TENANT_CREDITS_RULE_VERSION } from './tenantCredits'
import {
  securityDepositProjector, depositReturnProjector, refundPartProjector, projectPaidFromDeposit, TENANT_DEPOSITS_RULE_VERSION,
} from './tenantDeposits'
import { paymentReversalProjector } from './tenantReversals'
import { homeSaleProjector, openingProjector } from './tenantOpening'

/** Every posting a bill row wants (see the header). */
export async function projectPayment(client: PoolClient, paymentId: string): Promise<DesiredPosting[]> {
  if (!isUuid(paymentId)) return []
  const f = (await loadPaymentFacts(client, [paymentId])).get(paymentId)
  if (!f) return []
  const co = await loadCompanyBooks(client, f.landlordId)
  const out: DesiredPosting[] = []
  const charge = await projectCharge(client, f, co)
  if (charge) out.push(charge)
  out.push(...projectRowSettlement(f))
  const hours = projectWorkTrade(f, co)
  if (hours) out.push(hours)
  const deposit = projectPaidFromDeposit(f)
  if (deposit) out.push(deposit)
  return out
}

export const paymentProjector: LedgerProjector = {
  sourceType: 'payment',
  ruleVersion: Math.max(TENANT_CHARGES_RULE_VERSION, TENANT_RECEIPTS_RULE_VERSION, TENANT_CREDITS_RULE_VERSION,
    TENANT_DEPOSITS_RULE_VERSION),
  project: (client, sourceId) => projectPayment(client, sourceId),
  /**
   * A bill row's day is the earliest of its postings (its due date, or the day
   * it settled when that came first); it is listed for `since` when any of its
   * days is on or after it.
   */
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT x.id, LEAST(x.due, COALESCE(x.settled, x.due)) AS day
         FROM (SELECT p.id::text AS id, p.due_date::text AS due,
                      ${localDaySql('p.settled_at', propertyTzSql(`COALESCE((SELECT u.property_id FROM units u WHERE u.id = p.unit_id), ${leasePropertySql('p.lease_id')})`, 'p.landlord_id'))} AS settled
                 FROM payments p WHERE p.landlord_id = $1) x
        WHERE $2::text IS NULL OR GREATEST(x.due, COALESCE(x.settled, x.due)) >= $2::text`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

/** The tenant-money projectors, one per source type (bank_match: see the header). */
export const TENANT_LEDGER_PROJECTORS: readonly LedgerProjector[] = [
  paymentProjector,
  remittanceProjector,
  prepaidCreditProjector,
  creditUseProjector,
  paymentReversalProjector,
  securityDepositProjector,
  depositReturnProjector,
  refundPartProjector,
  homeSaleProjector,
  homeInstallmentProjector,
  openingProjector,
  depositSlipProjector,
  posEodProjector,
  bankMatchTenantProjector,
]

/** Source types another phase also posts from (the integrate step merges their parts). */
export const TENANT_SHARED_SOURCE_TYPES = ['bank_match'] as const

/** Registers every tenant-money projector with the engine (the integrate step; tests). */
export function registerTenantLedgerProjectors(): void {
  for (const p of TENANT_LEDGER_PROJECTORS) registerLedgerProjector(p)
}

/** Takes them back off (tests). */
export function unregisterTenantLedgerProjectors(): void {
  for (const p of TENANT_LEDGER_PROJECTORS) unregisterLedgerProjector(p.sourceType)
}
