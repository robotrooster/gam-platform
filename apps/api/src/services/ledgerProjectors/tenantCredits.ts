/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY C: CREDITS, PAID-AHEAD
 * MONEY AND WORK TRADE (gam-ledger-design-2026-10-12 §6 C1-C10)
 *
 *   Nic 10/12, L13: paid-ahead money GAM holds is NOT on the landlord's balance
 *   sheet until it pays a bill.  L12: work-trade hours covering rent are the
 *   LANDLORD'S CHOICE — full rent plus a labor cost, or a rent discount.
 *
 * A CREDIT SPENT (credit_uses, key `credit_use:<id>`, spent = 'applied' or
 * 'reversed' — the set the money view counts; dated when it was applied):
 *
 *   on a bill (payment_id):
 *     C1  paid-ahead money the LANDLORD holds    Dr 2050 / Cr receivables
 *                                                (counted when it arrived)
 *         paid-ahead money GAM holds (L13)        Dr 1050 Due from GAM /
 *                                                Cr receivables, RECEIVED that
 *                                                day: this is when it becomes
 *                                                the landlord's money
 *     C2  a credit the landlord gave              Dr 4095 Credits given
 *     C3  a late-fee refund credit                Dr 4020 Late fees
 *     C4  deposit interest (GAM pays it)          Dr 1050 / received
 *   at move-out (deposit_return_id, C10): the money joins what the move-out
 *       settles — Cr 2020 (the move-out's deductions, refund and balance all
 *       draw on 2020, tenantDeposits D3/D4), from 2050 or 1050 as above;
 *       deposit interest from 1070 (it goes back with the deposit GAM holds)
 *   "Keep it" on paid-ahead money left at an ended lease (paid_ahead_choice_id,
 *       C7): Cr 4900 Other income "Unclaimed paid-ahead kept", from 2050, or
 *       from 1050 for money GAM held (received then)
 *   C9  a dispute clawing back unspent paid-ahead money (payment_reversal_id):
 *       nothing — it was GAM's to hold and never on the landlord's books (L13)
 *   a refund of paid-ahead money (refund_part_id): nothing here — the refund
 *       part is the one record of that money going out (tenantDeposits D4)
 * A 'reversed' use stays spent: its bill reopens only through the dispute
 * record (tenantReversals E1, 'credit_spend'). A released use (stay
 * shortened, a late-fee credit withdrawn) re-projects to nothing.
 *
 * PAID-AHEAD MONEY ARRIVING (lease_prepaid_credits, key `prepaid_credit:<id>`):
 *   B2  money GAM holds (a card or bank surplus)  nothing (L13)
 *       money the landlord took (desk, bank deposit, posted ahead)  nothing
 *       here: its receipt books it (tenantReceipts B3/B4)
 *       typed-in money paid before GAM (no receipt) Dr 3900 / Cr 2050
 *   C8  rent of a shortened stay moved to credit  Dr 4010 / Cr 2050 — the rent
 *       rows stay as paid; the nights are no longer rent, the money is the
 *       guest's paid ahead
 *       a reservation deposit's leftover after the arrival rent  Dr 4400 Stay
 *       income / Cr 2050 (it was counted as the stay's when it arrived)
 *   C6  carried to another lease: no posting — paid-ahead money stays tagged
 *       to the lease it ARRIVED on (design §9), and a use on the new lease
 *       books inter-property clearing when the properties differ.
 *
 * THE WORK-TRADE MONTH CLOSE (key `payment:<id>`, kind 'work_trade', C5): the
 * hours applied to a bill (payments.work_trade_credit) pay it, dated the bill's
 * due date (Nic S652: work trade counts as on time) — Dr 5190 Work-trade labor
 * (rent_and_labor) or Dr 4096 Work-trade discount (rent_discount) / Cr
 * receivables. left_out (10/14): Dr the very income lines the charge credited,
 * split in the charge's own proportions, so the covered part nets to nothing
 * and only money paid shows. Waits while the owner has not chosen.
 */
import type { PoolClient } from 'pg'
import type { LedgerAccountRole } from '@gam/shared'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { STAY_SHORTENED_CREDIT_NOTE } from '../bookingLeaseBilling'
import {
  type PaymentFacts, type CompanyBooks, Lines, rowDims, loadPaymentFacts, incomePartsFor, requireWorkTradeMethod,
  splitCents, cSql, centsOf, localDaySql, propertyTzSql, leasePropertySql, companyTzSql, isUuid,
} from './tenantShared'
import { rentParts, stayParts, loadSpace, loadStay, type IncomePart } from './incomeLines'

// 2 — 10/14 (Nic I1-I7): rent and stay money taken back lands on the line it was charged to (incomeLines).
export const TENANT_CREDITS_RULE_VERSION = 2

// ─── C5: work-trade hours that paid a bill ──────────────────────────────────

export function projectWorkTrade(f: PaymentFacts, co: CompanyBooks, charge: DesiredPosting | null = null): DesiredPosting | null {
  if (f.voided || f.exclusion || f.workTradeCents === 0) return null
  const method = requireWorkTradeMethod(co)
  const d = rowDims(f)
  const L = new Lines()
  if (method === 'left_out') {
    const credited = (charge?.lines ?? []).filter(l => l.role && (l.creditCents ?? 0) > 0)
    if (credited.length === 0) {
      for (const p of incomePartsFor(f, f.workTradeCents)) {
        L.dr(p.role, p.cents, { ...d, reportCategory: f.category, sub: p.sub, memo: 'Work-trade hours (left out of the books)' })
      }
    } else {
      const parts = splitCents(f.workTradeCents, credited.map(l => l.creditCents ?? 0))
      credited.forEach((l, i) => L.dr(l.role!, parts[i], { ...l, memo: 'Work-trade hours (left out of the books)' }))
    }
  } else {
    L.dr(method === 'rent_and_labor' ? 'work_trade_labor' : 'work_trade_discount', f.workTradeCents,
      { ...d, reportCategory: 'work_trade', memo: 'Work-trade hours' })
  }
  L.cr('ar_tenants', f.workTradeCents, { ...d, reportCategory: f.category })
  return { owner: { landlordId: f.landlordId }, postingKind: 'work_trade', intendedDate: f.dueDate,
    memo: 'Paid by work-trade hours', lines: L.lines }
}

// ─── Credits spent ──────────────────────────────────────────────────────────

interface UseRow {
  status: string
  payment_id: string | null
  deposit_return_id: string | null
  payment_reversal_id: string | null
  refund_part_id: string | null
  paid_ahead_choice_id: string | null
  prepaid_credit_id: string | null
  tenant_credit_id: string | null
  c: string
  applied: boolean
  category: string | null
  funded_by: string | null
  src_online: boolean
  credit_lease: string | null
  credit_tenant: string | null
  credit_property: string | null
  tc_tenant: string | null
}

/** Paid-ahead money GAM holds (it came through Stripe), from the credit's own facts. */
function gamHeld(u: Pick<UseRow, 'funded_by' | 'src_online'>): boolean {
  if (u.funded_by) return u.funded_by === 'gam'
  return u.src_online
}

/** What a spent credit is paid FROM, and whether that counts as money received now. */
function creditSide(u: UseRow): { role: LedgerAccountRole; received: boolean; dims: Record<string, string | null> } {
  if (u.prepaid_credit_id) {
    if (gamHeld(u)) return { role: 'due_from_gam', received: true, dims: {} }
    return {
      role: 'tenant_prepayments', received: false,
      dims: { propertyId: u.credit_property, leaseId: u.credit_lease, tenantId: u.credit_tenant },
    }
  }
  switch (u.category) {
    case 'deposit_interest': return { role: 'due_from_gam', received: true, dims: {} }
    case 'late_fee_refund': return { role: 'late_fees', received: false, dims: {} }
    default: return { role: 'credits_given', received: false, dims: {} }
  }
}

export async function projectCreditUse(client: PoolClient, useId: string): Promise<DesiredPosting[]> {
  if (!isUuid(useId)) return []
  const u = (await client.query<UseRow>(
    `SELECT cu.status, cu.payment_id, cu.deposit_return_id, cu.payment_reversal_id, cu.refund_part_id,
            cu.paid_ahead_choice_id, cu.prepaid_credit_id, cu.tenant_credit_id, ${cSql('cu.amount')} AS c,
            cu.applied_at IS NOT NULL AS applied, tc.category, pc.funded_by,
            COALESCE(src.payment_method IN ('card', 'ach') AND src.stripe_payment_intent_id IS NOT NULL, FALSE) AS src_online,
            COALESCE(pc.received_lease_id, pc.lease_id) AS credit_lease, pc.tenant_id AS credit_tenant,
            ${leasePropertySql('COALESCE(pc.received_lease_id, pc.lease_id)')} AS credit_property,
            tc.tenant_id AS tc_tenant
       FROM credit_uses cu
       LEFT JOIN tenant_credits tc ON tc.id = cu.tenant_credit_id
       LEFT JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
       LEFT JOIN tenant_remittances src ON src.id = pc.source_remittance_id
      WHERE cu.id = $1`, [useId])).rows[0]
  if (!u || !['applied', 'reversed'].includes(u.status) || !u.applied) return []
  const cents = centsOf(u.c)
  if (cents === 0) return []
  // C9 (L13) and refunds (D4 owns them) book nothing here.
  if (u.payment_reversal_id || u.refund_part_id) return []
  const side = creditSide(u)

  if (u.payment_id) {
    const f = (await loadPaymentFacts(client, [u.payment_id])).get(u.payment_id)
    if (!f || f.exclusion) return []
    const day = await dayOn(client, useId, f.propertyId, f.landlordId)
    const d = rowDims(f)
    const L = new Lines()
    // Paid-ahead money the landlord holds stays on the lease it arrived on
    // (design §9); a credit given or money from GAM books on the bill's space.
    // 10/12 (Nic, ledger P8 integration): a credit given names the bill it went
    // to as well (payment_id), as its receivables side does — a report that
    // reads bills by their due month (the Books rent roll) then takes the
    // credit off that bill, the way the money records do; without it the rent
    // roll's Charged on the books was the bills before credits ($12.47 over the
    // P&L for Oak Park's October on the production copy).
    const fromDims = side.role === 'tenant_prepayments' ? side.dims
      : side.role === 'due_from_gam' ? { propertyId: f.propertyId }
      : d
    L.dr(side.role, cents, {
      ...fromDims,
      reportCategory: side.role === 'credits_given' || side.role === 'late_fees' ? 'credits_given' : null,
      memo: memoFor(u),
    })
    L.cr('ar_tenants', cents, { ...d, reportCategory: f.category, cashEffect: side.received ? 'in' : null })
    return [{ owner: { landlordId: f.landlordId }, intendedDate: day, memo: memoFor(u), lines: L.lines }]
  }

  if (u.deposit_return_id) {
    // C10: the credit joins the move-out's settlement (Cr 2020).
    const dr = (await client.query<{ landlord_id: string; lease_id: string; tenant_id: string; property_id: string | null }>(
      `SELECT landlord_id, lease_id, tenant_id, ${leasePropertySql('lease_id')} AS property_id
         FROM deposit_returns WHERE id = $1`, [u.deposit_return_id])).rows[0]
    if (!dr) return []
    const day = await dayOn(client, useId, dr.property_id, dr.landlord_id)
    const L = new Lines()
    const fromDims = side.role === 'tenant_prepayments' ? side.dims
      : { propertyId: dr.property_id, leaseId: dr.lease_id, tenantId: dr.tenant_id }
    // 10/12 (Nic, ledger review): deposit interest GAM credited and the
    // move-out used joins the deposit money GAM holds for the lease (1070), as
    // the interest the move-out adds itself does (tenantDeposits D3) — GAM sends
    // it back with the deposit refund, out of 1070. Booked to Due from GAM
    // (1050) it stayed there with no payout line to explain it, and 1070 ended
    // below zero by the interest.
    const interest = !u.prepaid_credit_id && u.category === 'deposit_interest'
    const role = interest ? 'deposits_gam_holds' : side.role === 'late_fees' ? 'credits_given' : side.role
    L.dr(role, cents, {
      ...fromDims,
      reportCategory: side.role === 'credits_given' || side.role === 'late_fees' ? 'credits_given' : null,
      memo: interest ? 'Deposit interest used at move-out (GAM holds it with the deposit)' : 'Used at move-out',
    })
    L.cr('security_deposits_payable', cents, {
      propertyId: dr.property_id, leaseId: dr.lease_id, tenantId: dr.tenant_id,
      reportCategory: 'deposits', cashEffect: side.received && !interest ? 'in' : null,
    })
    return [{ owner: { landlordId: dr.landlord_id }, intendedDate: day, memo: 'Credit used at move-out', lines: L.lines }]
  }

  if (u.paid_ahead_choice_id && u.prepaid_credit_id) {
    // C7: paid-ahead money left at an ended lease that the landlord keeps.
    const ch = (await client.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM paid_ahead_choices WHERE id = $1`, [u.paid_ahead_choice_id])).rows[0]
    if (!ch) return []
    const day = await dayOn(client, useId, u.credit_property, ch.landlord_id)
    const L = new Lines()
    L.dr(side.role, cents, { ...(side.role === 'due_from_gam' ? { propertyId: u.credit_property } : side.dims), memo: 'Unclaimed paid-ahead kept' })
    L.cr('other_income', cents, {
      propertyId: u.credit_property, leaseId: u.credit_lease, tenantId: u.credit_tenant,
      reportCategory: 'other_income', cashEffect: side.received ? 'in' : null, memo: 'Unclaimed paid-ahead kept',
    })
    return [{ owner: { landlordId: ch.landlord_id }, intendedDate: day, memo: 'Unclaimed paid-ahead kept', lines: L.lines }]
  }
  return []
}

function memoFor(u: UseRow): string {
  if (u.prepaid_credit_id) return 'Paid from money paid ahead'
  if (u.category === 'deposit_interest') return 'Deposit interest credited'
  if (u.category === 'late_fee_refund') return 'Late fee credited back'
  return 'Credit applied'
}

/** The day a credit use was applied, on the property's calendar. */
async function dayOn(client: PoolClient, useId: string, propertyId: string | null, landlordId: string): Promise<string> {
  const r = await client.query<{ d: string }>(
    `SELECT ${localDaySql('cu.applied_at', propertyTzSql('$2::uuid', '$3::uuid'))} AS d FROM credit_uses cu WHERE cu.id = $1`,
    [useId, propertyId, landlordId])
  return r.rows[0].d
}

export const creditUseProjector: LedgerProjector = {
  sourceType: 'credit_use',
  ruleVersion: TENANT_CREDITS_RULE_VERSION,
  project: (client, sourceId) => projectCreditUse(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT cu.id::text AS id, ${localDaySql('cu.applied_at', companyTzSql('$1::uuid'))} AS day
         FROM credit_uses cu
        WHERE cu.applied_at IS NOT NULL
          AND (EXISTS (SELECT 1 FROM payments p WHERE p.id = cu.payment_id AND p.landlord_id = $1)
               OR EXISTS (SELECT 1 FROM deposit_returns d WHERE d.id = cu.deposit_return_id AND d.landlord_id = $1)
               OR EXISTS (SELECT 1 FROM paid_ahead_choices c WHERE c.id = cu.paid_ahead_choice_id AND c.landlord_id = $1))
          AND ($2::date IS NULL OR cu.applied_at >= ($2::date - 1))`, [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}

// ─── Paid-ahead money arriving ──────────────────────────────────────────────

export async function projectPrepaidCredit(client: PoolClient, creditId: string): Promise<DesiredPosting[]> {
  if (!isUuid(creditId)) return []
  const c = (await client.query<{
    funded_by: string | null; has_source: boolean; anchor: string | null; note: string | null; voided: boolean
    c: string; landlord_id: string; lease_id: string; tenant_id: string; property_id: string | null; day: string | null
    made_at: string; booking_id: string | null
  }>(
    `SELECT pc.funded_by, (pc.source_remittance_id IS NOT NULL OR pc.source_payment_id IS NOT NULL) AS has_source,
            pc.source_payment_id AS anchor, pc.note, pc.voided_at IS NOT NULL AS voided, ${cSql('pc.amount_original')} AS c,
            l.landlord_id, COALESCE(pc.received_lease_id, pc.lease_id) AS lease_id, pc.tenant_id,
            pc.created_at::text AS made_at, l.source_booking_id::text AS booking_id,
            ${leasePropertySql('COALESCE(pc.received_lease_id, pc.lease_id)')} AS property_id,
            ${localDaySql('COALESCE(pc.received_at, pc.created_at)', propertyTzSql(leasePropertySql('COALESCE(pc.received_lease_id, pc.lease_id)'), 'l.landlord_id'))} AS day
       FROM lease_prepaid_credits pc
       JOIN leases l ON l.id = COALESCE(pc.received_lease_id, pc.lease_id)
      WHERE pc.id = $1`, [creditId])).rows[0]
  if (!c || c.voided || !c.day) return []
  const cents = centsOf(c.c)
  if (cents === 0) return []
  const d = { propertyId: c.property_id, leaseId: c.lease_id, tenantId: c.tenant_id }
  const L = new Lines()
  let memo: string
  if (c.funded_by === 'reclassified') {
    const stayShortened = !!c.anchor || c.note === STAY_SHORTENED_CREDIT_NOTE
    if (stayShortened) {
      // C8: rent already paid for nights the stay no longer has.
      // 10/14 (Nic I1-I7): off the line the rent was charged to — the anchor
      // bill's, else the lease's space.
      let parts: IncomePart[] | null = null
      if (c.anchor) {
        const f = (await loadPaymentFacts(client, [c.anchor])).get(c.anchor)
        if (f && !f.exclusion && f.category !== 'deposits' && f.category !== 'home_payments' && f.category !== 'balances_collected') {
          parts = incomePartsFor(f, cents)
        }
      }
      // No anchor bill: the lease's space as it stood when the credit was made.
      parts ??= rentParts(await loadSpace(client, null, c.lease_id, c.made_at), cents, 'space_rent')
      for (const p of parts) L.dr(p.role, p.cents, { ...d, reportCategory: 'space_rent', sub: p.sub, memo: 'Stay shortened: rent already paid moved to credit' })
      memo = 'Stay shortened: rent moved to credit'
    } else {
      // The reservation deposit's leftover after the arrival rent.
      // 10/14 (Nic I2): off the line the stay earned it on (bookingStay) — the
      // lease's booking; a stay a lease bills is long-term, on its space's rent
      // line. A lease with no booking named: its unit as it stood then.
      const stay = await loadStay(client, c.booking_id)
      const parts = stay ? stayParts(stay, cents) : rentParts(await loadSpace(client, null, c.lease_id, c.made_at, 'unit'), cents, 'stay_income')
      for (const p of parts) {
        L.dr(p.role, p.cents, { ...d, reportCategory: 'stays_and_pay_links', sub: p.sub, memo: 'Reservation deposit left over, moved to credit' })
      }
      memo = 'Reservation deposit moved to credit'
    }
  } else if (c.funded_by === 'landlord' && !c.has_source) {
    // Typed-in money paid ahead before GAM (no receipt behind it).
    L.dr('opening_balance_equity', cents, { ...d, reportCategory: 'opening', memo: 'Paid ahead before GAM' })
    memo = 'Paid ahead before GAM'
  } else {
    // GAM holds it (L13: not on the landlord's books until it pays a bill), or
    // its receipt already booked it.
    return []
  }
  L.cr('tenant_prepayments', cents, { ...d, reportCategory: 'paid_ahead' })
  return [{ owner: { landlordId: c.landlord_id }, intendedDate: c.day, memo, lines: L.lines }]
}

export const prepaidCreditProjector: LedgerProjector = {
  sourceType: 'prepaid_credit',
  ruleVersion: TENANT_CREDITS_RULE_VERSION,
  project: (client, sourceId) => projectPrepaidCredit(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT pc.id::text AS id, ${localDaySql('COALESCE(pc.received_at, pc.created_at)', companyTzSql('$1::uuid'))} AS day
         FROM lease_prepaid_credits pc JOIN leases l ON l.id = COALESCE(pc.received_lease_id, pc.lease_id)
        WHERE l.landlord_id = $1
          AND ($2::date IS NULL OR COALESCE(pc.received_at, pc.created_at) >= ($2::date - 1))`,
      [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}
