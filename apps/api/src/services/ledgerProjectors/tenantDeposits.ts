/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY D: DEPOSITS, MOVE-OUT AND
 * REFUNDS (gam-ledger-design-2026-10-12 §6 D1-D4)
 *
 *   Nic 10/12: "security deposits = liability, income only when kept";
 *   G10: a refunded card sale gives the guest the card fee back and the
 *   landlord eats it ("Card fees refunded").
 *
 * 2020 Security deposits payable is what the landlord owes back. It rises
 * when a deposit is billed (tenantCharges A4) or, for a deposit GAM collects
 * from the tenant in installments, by the FULL deposit at enrollment (D2 —
 * the landlord's books show the whole deposit and never the installments);
 * the money itself sits where it was paid (1070 GAM holds it, the bank, the
 * drawer — tenantReceipts B1/B3, D1 needs no posting of its own).
 *
 * At move-out everything the move-out settles draws on 2020:
 *   D3 (`deposit_return:<id>`, the day it was finalized)
 *       deductions kept (cleaning, damage, other)   Dr 2020 / Cr 4800 Deposit
 *                                                   deductions kept (income)
 *       the move-out balance billed (gap row)        Dr receivables / Cr 2020
 *       deposit interest GAM adds to what is owed    Dr 1070 / Cr 2020 (GAM
 *                                                   pays it; worked out from
 *                                                   the return's own figures)
 *       a deposit collected in installments that came up short
 *                                                   Dr 2020 / Cr 1070 "Deposit
 *                                                   adjustment at move-out"
 *       Liability and income only: what GAM releases from 1070 to the landlord
 *       is posted by the released held items (P5, design G4).
 *   bills the deposit paid (status paid_via_deposit, key `payment:<id>`, kind
 *       'paid_from_deposit')                         Dr 2020 / Cr receivables
 *   credit used at move-out (tenantCredits C10)      Cr 2020
 *   D4 refund parts (`refund_part:<id>`, the day refunded): the deposit,
 *       paid-ahead money or stay money going back —
 *         what it takes back   deposit: 2020; paid-ahead the landlord holds:
 *                              2050 (paid-ahead GAM holds: nothing, L13);
 *                              stay: 4400 Stay income (lease rent: 4010) less
 *                              the lodging tax share (2042)
 *         the card fee given back   Dr 5115 (the landlord's cost, Nic G10)
 *         how it went back      card or bank (GAM sent it): 1050 for what
 *                              comes off the payout, 1070 for deposit money
 *                              GAM held; cash: 1040; check or money order:
 *                              2015 until the bank shows it; left as credit:
 *                              2050
 *       A failed, replaced or reversed part posts nothing (a correction).
 *
 * NOT POSTED (refused, so it waits with a reason an admin sees): a deposit
 * carried forward to another lease (sent_carried_forward) — its record is
 * moved to the new lease in place (services/depositPortability), so there is
 * no fact to post the hand-over from yet; and a refund back onto a store
 * charge account (gated, design F7).
 */
import type { PoolClient } from 'pg'
import type { LedgerAccountRole } from '@gam/shared'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  type PaymentFacts, Lines, rowDims, cSql, centsOf, localDaySql, propertyTzSql, leasePropertySql, companyTzSql, isUuid,
  loadPaymentFacts, incomePartsFor,
} from './tenantShared'
import { loadStay, stayParts, rentParts, type IncomePart } from './incomeLines'

// 2 — 10/14 (Nic I1, I2): money refunded for nights not stayed comes off the stay's own line (incomeLines).
export const TENANT_DEPOSITS_RULE_VERSION = 2

// ─── A bill the deposit paid ────────────────────────────────────────────────

export function projectPaidFromDeposit(f: PaymentFacts): DesiredPosting | null {
  if (f.voided || f.exclusion || f.status !== 'paid_via_deposit') return null
  const money = f.moneyCents
  if (money === 0) return null
  const d = rowDims(f)
  const L = new Lines()
  L.dr('security_deposits_payable', money, { ...d, reportCategory: 'deposits', memo: 'Paid from the deposit' })
  L.cr('ar_tenants', money, { ...d, reportCategory: f.category })
  return { owner: { landlordId: f.landlordId }, postingKind: 'paid_from_deposit', intendedDate: f.settledDay ?? f.dueDate,
    memo: 'Paid from the deposit at move-out', lines: L.lines }
}

// ─── D2: a deposit collected in installments, in full at enrollment ─────────

export const securityDepositProjector: LedgerProjector = {
  sourceType: 'security_deposit',
  ruleVersion: TENANT_DEPOSITS_RULE_VERSION,
  async project(client, sourceId) {
    if (!isUuid(sourceId)) return []
    const s = (await client.query<{
      landlord_id: string; lease_id: string; tenant_id: string; unit_id: string; property_id: string | null
      installments: boolean; voided: boolean; c: string; day: string | null
    }>(
      `SELECT l.landlord_id, sd.lease_id, sd.tenant_id, sd.unit_id, u.property_id,
              sd.flex_deposit_enabled IS TRUE AS installments, (sd.voided_at IS NOT NULL OR sd.status = 'voided') AS voided,
              ${cSql('sd.total_amount')} AS c,
              ${localDaySql('(SELECT min(f.created_at) FROM flex_deposit_installments f WHERE f.security_deposit_id = sd.id)',
                            propertyTzSql('u.property_id', 'l.landlord_id'))} AS day
         FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id LEFT JOIN units u ON u.id = sd.unit_id
        WHERE sd.id = $1`, [sourceId])).rows[0]
    if (!s || !s.installments || s.voided || !s.day) return []
    const d = { propertyId: s.property_id, unitId: s.unit_id, leaseId: s.lease_id, tenantId: s.tenant_id }
    const L = new Lines()
    L.dr('deposits_gam_holds', centsOf(s.c), { ...d, memo: 'Deposit GAM holds for you (the full deposit at move-in)' })
    L.cr('security_deposits_payable', centsOf(s.c), { ...d, reportCategory: 'deposits' })
    if (L.empty) return []
    return [{ owner: { landlordId: s.landlord_id }, intendedDate: s.day, memo: 'Deposit held for you', lines: L.lines }]
  },
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT sd.id::text AS id,
              ${localDaySql('(SELECT min(f.created_at) FROM flex_deposit_installments f WHERE f.security_deposit_id = sd.id)', companyTzSql('$1::uuid'))} AS day
         FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id
        WHERE l.landlord_id = $1 AND sd.flex_deposit_enabled IS TRUE
          AND ($2::date IS NULL OR sd.created_at >= ($2::date - 1)
               OR EXISTS (SELECT 1 FROM flex_deposit_installments f WHERE f.security_deposit_id = sd.id AND f.created_at >= ($2::date - 1)))`,
      [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}

// ─── D3: the move-out ───────────────────────────────────────────────────────

const LINES_TOTAL = (col: string) =>
  `COALESCE((SELECT sum((x->>'amount')::numeric) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END) x), 0)`

export async function projectDepositReturn(client: PoolClient, returnId: string): Promise<DesiredPosting[]> {
  if (!isUuid(returnId)) return []
  const r = (await client.query<any>(
    `SELECT dr.landlord_id, dr.lease_id, dr.tenant_id, dr.status, dr.gap_payment_id,
            ${leasePropertySql('dr.lease_id')} AS property_id,
            ${localDaySql('dr.finalized_at', propertyTzSql(leasePropertySql('dr.lease_id'), 'dr.landlord_id'))} AS day,
            ${cSql('dr.total_deposit')} AS deposit_c, ${cSql('dr.cleaning_fee_amount')} AS cleaning_c,
            ${cSql(LINES_TOTAL('dr.damage_lines'))} AS damage_c, ${cSql(LINES_TOTAL('dr.other_deductions'))} AS other_c,
            ${cSql('dr.total_deductions')} AS ded_c, ${cSql('dr.refund_amount')} AS refund_c, ${cSql('dr.gap_amount')} AS gap_c,
            ${cSql(`COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                               WHERE cu.deposit_return_id = dr.id AND cu.status = 'applied' AND cu.prepaid_credit_id IS NOT NULL), 0)`)} AS used_prepaid_c,
            ${cSql(`COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                               WHERE cu.deposit_return_id = dr.id AND cu.status = 'applied' AND cu.tenant_credit_id IS NOT NULL), 0)`)} AS used_credit_c,
            sd.flex_deposit_enabled IS TRUE AS installments, ${cSql('COALESCE(sd.total_amount, 0)')} AS sd_total_c,
            ${cSql(`COALESCE((SELECT sum(f.amount) FROM flex_deposit_installments f
                               WHERE f.security_deposit_id = sd.id AND f.status = 'settled'
                                 AND (dr.finalized_at IS NULL OR f.settled_at IS NULL OR f.settled_at <= dr.finalized_at)), 0)`)} AS installments_paid_c
       FROM deposit_returns dr LEFT JOIN security_deposits sd ON sd.id = dr.security_deposit_id
      WHERE dr.id = $1`, [returnId])).rows[0]
  if (!r || !r.day || r.status === 'draft' || r.status === 'awaiting_approval') return []
  if (r.status === 'sent_carried_forward') {
    throw new LedgerSourceError('missing_fact',
      'A deposit carried forward to another lease is not posted yet: its record is moved to the new lease in place, so the hand-over has no record to post from.')
  }
  const dims = { propertyId: r.property_id as string | null, leaseId: r.lease_id as string, tenantId: r.tenant_id as string }
  const L = new Lines()
  const kept = centsOf(r.cleaning_c) + centsOf(r.damage_c) + centsOf(r.other_c)
  L.dr('security_deposits_payable', kept, { ...dims, reportCategory: 'deposits', memo: 'Kept from the deposit at move-out' })
  L.cr('deposit_deductions_kept', kept, { ...dims, reportCategory: 'other_fees', memo: 'Deposit deductions kept' })

  const gap = centsOf(r.gap_c)
  if (gap > 0) {
    if (!r.gap_payment_id) {
      throw new LedgerSourceError('missing_fact', `Move-out ${returnId} left a balance of ${gap} cents with no charge for it.`)
    }
    L.dr('ar_tenants', gap, { ...dims, paymentId: r.gap_payment_id, reportCategory: 'other_fees', memo: 'Move-out balance owed' })
    L.cr('security_deposits_payable', gap, { ...dims, reportCategory: 'deposits' })
  }

  // Deposit interest GAM adds to what is owed back (not yet credited as a
  // credit): the deposit side the move-out settled (refund + what the deposit
  // covered) less the deposit itself and the interest already credited.
  const fromDeposit = centsOf(r.ded_c) - gap - centsOf(r.used_prepaid_c)
  const interest = centsOf(r.refund_c) + fromDeposit - centsOf(r.deposit_c) - centsOf(r.used_credit_c)
  if (interest > 0) {
    L.dr('deposits_gam_holds', interest, { ...dims, memo: 'Interest on the deposit, paid by GAM' })
    L.cr('security_deposits_payable', interest, { ...dims, reportCategory: 'deposits' })
  }

  if (r.installments) {
    const short = centsOf(r.sd_total_c) - centsOf(r.installments_paid_c)
    if (short > 0) {
      L.dr('security_deposits_payable', short, { ...dims, reportCategory: 'deposits', memo: 'Deposit adjustment at move-out' })
      L.cr('deposits_gam_holds', short, { ...dims, memo: 'Deposit adjustment at move-out' })
    }
  }
  if (L.empty) return []
  return [{ owner: { landlordId: r.landlord_id }, intendedDate: r.day, memo: 'Move-out', lines: L.lines }]
}

export const depositReturnProjector: LedgerProjector = {
  sourceType: 'deposit_return',
  ruleVersion: TENANT_DEPOSITS_RULE_VERSION,
  project: (client, sourceId) => projectDepositReturn(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT dr.id::text AS id, ${localDaySql('dr.finalized_at', companyTzSql('$1::uuid'))} AS day FROM deposit_returns dr
        WHERE dr.landlord_id = $1 AND dr.finalized_at IS NOT NULL
          AND ($2::date IS NULL OR dr.finalized_at >= ($2::date - 1))`, [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}

// ─── D4: refund parts ───────────────────────────────────────────────────────

/**
 * 10/14 (Nic I1-I7): rent paid for nights a stay no longer has, taken back
 * off the lines its rent bill was charged to (tenantCharges: the bill's space
 * as it stood when billed): the rent bill the refunded money paid, else the
 * latest rent bill of the stay's lease made before the refund. No such bill:
 * the stay's space.
 */
async function rentRefundParts(client: PoolClient, p: { booking_id: string | null; remittance_id: string | null; made_at: string },
  cents: number): Promise<IncomePart[]> {
  const bill = (await client.query<{ id: string }>(
    `SELECT pb.id::text AS id FROM payments pb
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM remittance_applications ra
                                          WHERE ra.remittance_id = $2::uuid AND ra.payment_id = pb.id) AS paid_by) x
      WHERE pb.type = 'rent'
        AND (x.paid_by OR (pb.created_at <= $3::timestamptz
                           AND pb.lease_id IN (SELECT sl.id FROM leases sl WHERE sl.source_booking_id = $1::uuid)))
      ORDER BY x.paid_by DESC, pb.created_at DESC, pb.id DESC LIMIT 1`, [p.booking_id, p.remittance_id, p.made_at])).rows[0]
  const f = bill ? (await loadPaymentFacts(client, [bill.id])).get(bill.id) : undefined
  if (f && f.category === 'space_rent') return incomePartsFor(f, cents)
  return rentParts((await loadStay(client, p.booking_id))?.space ?? null, cents, 'space_rent')
}


export async function projectRefundPart(client: PoolClient, partId: string): Promise<DesiredPosting[]> {
  if (!isUuid(partId)) return []
  const p = (await client.query<any>(
    `SELECT rp.landlord_id, rp.kind, rp.status, rp.reversed_at IS NOT NULL AS reversed,
            rp.decision_id, rp.paid_ahead_choice_id, rp.deposit_return_id, rp.stay_payment_id, rp.remittance_id,
            rp.prepaid_credit_id, rp.booking_id, rp.created_at::text AS made_at,
            ${cSql('rp.toward_amount')} AS toward_c, ${cSql('rp.card_fee_back')} AS cfb_c, ${cSql('rp.amount')} AS amount_c,
            ${cSql('rp.payout_drop')} AS drop_c, ${cSql('rp.lodging_tax_share')} AS tax_c,
            pc.funded_by, COALESCE(src.payment_method IN ('card', 'ach') AND src.stripe_payment_intent_id IS NOT NULL, FALSE) AS src_online,
            COALESCE(pc.received_lease_id, pc.lease_id) AS credit_lease, pc.tenant_id AS credit_tenant,
            dr.lease_id AS return_lease, dr.tenant_id AS return_tenant,
            x.property_id, ${localDaySql('rp.refunded_at', propertyTzSql('x.property_id', 'rp.landlord_id'))} AS day
       FROM stay_refund_parts rp
       LEFT JOIN lease_prepaid_credits pc ON pc.id = rp.prepaid_credit_id
       LEFT JOIN tenant_remittances src ON src.id = pc.source_remittance_id
       LEFT JOIN deposit_returns dr ON dr.id = rp.deposit_return_id
       CROSS JOIN LATERAL (SELECT COALESCE(
                             ${leasePropertySql('dr.lease_id')},
                             (SELECT u.property_id FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = rp.booking_id),
                             ${leasePropertySql('COALESCE(pc.received_lease_id, pc.lease_id)')}) AS property_id) x
      WHERE rp.id = $1`, [partId])).rows[0]
  if (!p || p.reversed || !p.day || !['refunded', 'handed_back', 'credited'].includes(p.status)) return []
  if (p.kind === 'charge') {
    throw new LedgerSourceError('missing_fact', 'A refund back onto a store charge account is not posted: store charge accounts are gated (design F7).')
  }
  const toward = centsOf(p.toward_c)
  const cfb = centsOf(p.cfb_c)
  const amount = centsOf(p.amount_c)
  const tax = centsOf(p.tax_c)
  const prop: string | null = p.property_id
  const gamHeldPaidAhead = !!p.prepaid_credit_id && (p.funded_by ? p.funded_by === 'gam' : !!p.src_online)
  const L = new Lines()

  // What the refund takes back: a deposit, paid-ahead money, or stay money for
  // nights not stayed (an early check-out — whatever paid those nights, the
  // nights are no longer income).
  // 10/12 (Nic, ledger review): a part that draws on paid-ahead money
  // (prepaid_credit_id) refunds PAID-AHEAD money, whatever decision it belongs
  // to. A long stay's early check-out refunds from the credit the shortened
  // stay's rent was moved to — that move already took the nights out of rent
  // (tenantCredits C8: Dr rent / Cr 2050) — so the refund comes off 2050, never
  // off rent a second time.
  const what: 'deposit' | 'paid_ahead' | 'stay' | null =
    p.deposit_return_id ? 'deposit' : p.prepaid_credit_id ? 'paid_ahead' : p.decision_id ? 'stay'
      : p.paid_ahead_choice_id ? 'paid_ahead' : null
  if (!what) throw new LedgerSourceError('missing_fact', `Refund part ${partId} names nothing it refunds.`)
  const left = p.kind === 'credit'
  if (what === 'paid_ahead' && left) {
    // Back to account credit. When the money simply stays on its paid-ahead
    // credit (nothing was spent from it: a long stay's credit back to credit,
    // or paid-ahead money that came from paid-ahead money), nothing moves. When
    // the refund spent the credit and gave the landlord's own credit back
    // instead (paidAheadChoice: a refund of what a credit the landlord gave
    // paid), the paid-ahead money becomes credit given: Dr 2050 / Cr 4095
    // Credits given — and that credit, used later, books Dr 4095 (C2), so the
    // two meet. Paid-ahead money GAM held is not on the books (L13): nothing.
    const drawn = (await client.query<{ c: string }>(
      `SELECT ${cSql(`COALESCE(sum(cu.amount), 0)`)} AS c FROM credit_uses cu
        WHERE cu.refund_part_id = $1 AND cu.status IN ('applied', 'reversed') AND cu.applied_at IS NOT NULL`,
      [partId])).rows[0]
    const spent = centsOf(drawn?.c)
    if (spent === 0 || gamHeldPaidAhead) return []
    L.dr('tenant_prepayments', spent, {
      propertyId: prop, leaseId: p.credit_lease, tenantId: p.credit_tenant, reportCategory: 'paid_ahead',
      memo: 'Paid-ahead money refunded as account credit',
    })
    L.cr('credits_given', spent, { propertyId: prop, tenantId: p.credit_tenant, reportCategory: 'credits_given', memo: 'Refunded as account credit' })
    return [{ owner: { landlordId: p.landlord_id }, intendedDate: p.day, memo: 'Refund to account credit', lines: L.lines }]
  }
  if (what === 'deposit') {
    L.dr('security_deposits_payable', toward, {
      propertyId: prop, leaseId: p.return_lease, tenantId: p.return_tenant, reportCategory: 'refunds',
      cashEffect: left ? null : 'in', memo: 'Deposit refunded',
    })
  } else if (what === 'paid_ahead') {
    // The landlord's liability, unless GAM held the money (L13: never on the books).
    if (!gamHeldPaidAhead) {
      L.dr('tenant_prepayments', toward, {
        propertyId: prop, leaseId: p.credit_lease, tenantId: p.credit_tenant, reportCategory: 'refunds', cashEffect: 'in',
        memo: 'Paid-ahead money refunded',
      })
    }
  } else {
    const income: LedgerAccountRole = p.stay_payment_id ? 'stay_income' : 'space_rent'
    const t = Math.max(0, Math.min(tax, toward))
    L.dr('lodging_tax_payable', t, { propertyId: prop, reportCategory: 'tax_collected', memo: 'Lodging tax refunded' })
    // 10/14 (Nic I1, I2): off the line it was earned on — stay money as the
    // stay earned it; rent paid for its nights as the rent bill was charged
    // (the bill the refunded money paid, else the stay's lease's latest rent
    // bill before the refund), so each line nets alike.
    const parts = income === 'stay_income'
      ? stayParts(await loadStay(client, p.booking_id), toward - t)
      : await rentRefundParts(client, p, toward - t)
    for (const x of parts) {
      L.dr(x.role, x.cents, {
        propertyId: prop, reportCategory: 'refunds', cashEffect: left ? null : 'in', sub: x.sub, memo: 'Refunded for nights not stayed',
      })
    }
  }
  // The card fee given back is the landlord's cost (Nic G10) — its own line,
  // "Card fees refunded" (5117), as the register's refunds post it, so the
  // P&L counts every card fee given back in one place.
  L.dr('card_fees_refunded', cfb, { propertyId: prop, memo: 'Card fee refunded to the guest' })

  // How it went back (amount = toward + card fee back, a CHECK on the table).
  const owed = toward + cfb
  switch (p.kind) {
    case 'card':
    case 'bank': {
      if (what === 'deposit') {
        // GAM sends deposit money it holds (1070); what comes off the
        // landlord's payout is money already released to them (1050).
        const drop = Math.max(0, Math.min(centsOf(p.drop_c), owed))
        L.cr('due_from_gam', drop, { propertyId: prop, memo: 'Refund sent by GAM' })
        L.cr('deposits_gam_holds', owed - drop, { propertyId: prop, leaseId: p.return_lease, memo: 'Refund sent by GAM' })
      } else if (what === 'paid_ahead' && gamHeldPaidAhead) {
        L.cr('due_from_gam', cfb, { propertyId: prop, memo: 'Card fee refunded to the guest' })
      } else {
        L.cr('due_from_gam', owed, { propertyId: prop, memo: 'Refund sent by GAM' })
      }
      break
    }
    case 'cash':
      L.cr('undeposited_funds', owed, { propertyId: prop, memo: 'Handed back in cash' })
      break
    case 'check':
    case 'money_order':
      L.cr('outstanding_checks', owed, { propertyId: prop, memo: p.kind === 'check' ? 'Refund check' : 'Refund money order' })
      break
    case 'credit':
      // Given back onto the tenant's account the way it was paid: money paid
      // ahead goes back to paid-ahead money (the landlord's liability, or off
      // the books again when GAM holds it, L13); a credit the landlord gave
      // goes back as such credit — the nights are no longer income and the
      // credit given is taken back with them (it books again when used, C2).
      if (p.prepaid_credit_id && gamHeldPaidAhead) {
        L.cr('due_from_gam', owed, { propertyId: prop, memo: 'Back to money paid ahead' })
      } else if (what === 'deposit') {
        L.cr('tenant_prepayments', owed, { propertyId: prop, leaseId: p.return_lease ?? p.credit_lease,
          tenantId: p.return_tenant ?? p.credit_tenant, reportCategory: 'paid_ahead', memo: 'Back to money paid ahead' })
      } else {
        L.cr('credits_given', owed, { propertyId: prop, reportCategory: 'credits_given', memo: 'Back to account credit' })
      }
      break
    default:
      throw new LedgerSourceError('projector_error', `Unknown refund kind ${p.kind}`)
  }
  if (L.empty) return []
  return [{ owner: { landlordId: p.landlord_id }, intendedDate: p.day, memo: 'Refund', lines: L.lines }]
}

export const refundPartProjector: LedgerProjector = {
  sourceType: 'refund_part',
  ruleVersion: TENANT_DEPOSITS_RULE_VERSION,
  project: (client, sourceId) => projectRefundPart(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT rp.id::text AS id, ${localDaySql('rp.refunded_at', companyTzSql('$1::uuid'))} AS day FROM stay_refund_parts rp
        WHERE rp.landlord_id = $1 AND rp.refunded_at IS NOT NULL
          AND ($2::date IS NULL OR rp.refunded_at >= ($2::date - 1))`, [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}
