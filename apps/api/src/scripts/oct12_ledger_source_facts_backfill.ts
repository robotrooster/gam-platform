/**
 * 10/12 (Nic) — the stored money facts, worked out for rows that existed
 * before their writers recorded them (gam-ledger-design-2026-10-12 §P1, M2).
 *
 * Since 10/12 each of these facts is written by its writer at the moment the
 * money moves. Rows written earlier have none, and the ledger rebuild needs
 * them. This fills each one from what is on record — and names every value it
 * fills in ledger_derived_facts (table, row, column, how), so a value it worked
 * out is never mistaken for one recorded at the time:
 *
 *   allocation_splits          one per owner share booked before the table
 *     (column '*')             existed: the owner, manager and PM rows as
 *                              booked; the fee withheld = what GAM held on the
 *                              row less those rows, supersedence and markup
 *                              (production 10/12: $0 on all 95); the cuts due,
 *                              the fee and any shortfall from the admin notice
 *                              allocation wrote when it had to cap them.
 *   payments.deposit_collected_by   settled deposit payments, by the one
 *                              definition (leaseFeesSync.depositCollectedBySql).
 *   tenant_remittances.undone_at/by receipts closed by Undo match: the bank
 *                              line's undo marker when it is still there, else
 *                              the receipt's updated_at (and nobody).
 *   held_payout_items.property_id   from the thing the line's source names: a
 *                              sale, booking, payment, dispute record, credit
 *                              spend, refund part, move-out, refund, dispute or
 *                              charge (heldPayouts.heldItemPropertySql). A line
 *                              nothing resolves is listed, never guessed.
 *   stay_payments.lodging_tax_amount booking-site deposits, at the rate in
 *                              force now (stayPayments.siteDepositLodgingTax).
 *   pos_refunds.tax_refunded   by the refund rule (earlyCheckOut.saleRefundTax).
 *   pos_transactions.voided_at the void's restock (pos_inventory_log 'Sale
 *                              voided') when there is one, else the sale's time.
 *   payments.work_trade_credit 10/12 (G-P1): the dollars a work-trade month
 *                              close took off each row, from the change
 *                              journal: the close credits a bill in one
 *                              transaction, so the invoice's rise in
 *                              work_trade_credit_amount and its rows' falls in
 *                              amount share one changed_at. Written only when
 *                              the rows' falls add up to the invoice's rise; a
 *                              bill that does not reconcile (or was credited
 *                              when written, before S634, with no journal) is
 *                              listed, never guessed.
 *   payments.work_trade_settlement_id  the carried-balance row a period's
 *                              unworked hours were billed on ('Work-trade hours
 *                              not completed for <Month YYYY>'): the one billed
 *                              period of that space and tenant for that month.
 *                              None or several: listed, never guessed.
 *   home_sale_contracts.activated_at   active and paid-off contracts, and a
 *                              cancelled one that billed or was journaled
 *                              active: the journal's move to 'active' when
 *                              there is one, else created_at. A cancelled sale
 *                              that never went active stays NULL.
 *
 * Idempotent: every step touches only rows still missing their fact, so a
 * second run writes nothing. Run at deploy (migrate, then this) and again
 * once the new code is live — a payment that settled on the old code in
 * between is caught by the second run. Never run against production by an
 * agent: Nic or deploy runs it.
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back,
 * and what WOULD be written is printed. --apply commits.
 *   cd apps/api && npx ts-node -T src/scripts/oct12_ledger_source_facts_backfill.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct12_ledger_source_facts_backfill.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { depositCollectedBySql } from '../services/leaseFeesSync'
import { heldItemPropertySql, type HeldItemProperty } from '../services/heldPayouts'
import { siteDepositLodgingTax } from '../services/stayPayments'
import { saleRefundTax } from '../services/earlyCheckOut'

const round2 = (n: number) => Math.round(n * 100) / 100
const cents = (x: string | number | null | undefined) => Math.round((Number(x) || 0) * 100)
const dollars = (c: number) => (c / 100).toFixed(2)

export interface BackfillReport {
  allocationSplits: number
  /**
   * 10/12 (ledger P1 review): owner shares whose payment names no property
   * (no split written, listed — never guessed). The projector refuses these
   * payments, so a run must say which they are.
   */
  allocationSplitsUnresolved: Array<{ paymentId: string; ownerShare: string }>
  depositCollectedBy: number
  remittancesUndone: number
  heldItemProperties: number
  /** Held lines nothing on record ties to a property (left NULL, listed). */
  heldItemsUnresolved: Array<{ id: string; sourceType: string; sourceId: string }>
  stayLodgingTax: number
  refundTax: number
  salesVoidedAt: number
  /** 10/12 (G-P1): rows given their work-trade credit from the journal. */
  workTradeCredit: number
  /** Bills whose work-trade credit the journal does not explain (left 0, listed). */
  workTradeCreditUnresolved: Array<{ invoiceId: string; credit: string; explained: string }>
  workTradeSettlementLinks: number
  /** Carried-balance rows for unworked hours with no single billed period to name (left NULL, listed). */
  workTradeSettlementUnresolved: Array<{ paymentId: string; note: string }>
  homeSaleActivatedAt: number
}

/** Name one worked-out value (ON CONFLICT: a re-run never writes it twice). */
async function noteDerived(
  c: PoolClient, table: string, rowId: string, column: string, method: string, value: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO ledger_derived_facts (table_name, row_id, column_name, method, value)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (table_name, row_id, column_name) DO NOTHING`,
    [table, rowId, column, method, JSON.stringify(value ?? null)])
}

// ── allocation_splits ────────────────────────────────────────────────────────

const ALLOC_ALERT = 'allocation_fees_exceed_held'

async function backfillAllocationSplits(c: PoolClient): Promise<{ n: number; unresolved: BackfillReport['allocationSplitsUnresolved'] }> {
  const rows = (await c.query<{
    payment_id: string; landlord_id: string; property_id: string | null; at: Date
    owner_share: string; manager_paid: string; pm_paid: string
    supersedence: string; sublease_markup: string; gam_held_part: string | null
    stripe_payment_intent_id: string | null; manual_method: string | null
    alert: Record<string, unknown> | null
  }>(
    `WITH booked AS (
       SELECT l.reference_id AS payment_id,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'allocation_owner_share'), 0) AS owner_share,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'allocation_manager_fee'), 0) AS manager_paid,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'allocation_pm_company_fee'), 0) AS pm_paid,
              (array_agg(l.property_id ORDER BY l.created_at) FILTER (WHERE l.type = 'allocation_owner_share' AND l.property_id IS NOT NULL))[1] AS property_id,
              MIN(l.created_at) FILTER (WHERE l.type = 'allocation_owner_share') AS at
         FROM user_balance_ledger l
        WHERE l.reference_type = 'payment'
          AND l.type IN ('allocation_owner_share', 'allocation_manager_fee', 'allocation_pm_company_fee')
        GROUP BY l.reference_id
       HAVING COUNT(*) FILTER (WHERE l.type = 'allocation_owner_share') > 0)
     SELECT b.payment_id, p.landlord_id, COALESCE(b.property_id, u.property_id) AS property_id, b.at,
            b.owner_share::text, b.manager_paid::text, b.pm_paid::text,
            COALESCE(p.gam_supersedence_amount, 0)::text AS supersedence,
            COALESCE(p.sublease_markup_amount, 0)::text AS sublease_markup,
            vm.gam_held_part::text AS gam_held_part,
            p.stripe_payment_intent_id, p.manual_method,
            (SELECT n.context FROM (
               SELECT context, created_at FROM admin_notifications
                WHERE category = '${ALLOC_ALERT}' AND context->>'payment_id' = p.id::text
               UNION ALL
               SELECT context, created_at FROM admin_notifications_archive
                WHERE category = '${ALLOC_ALERT}' AND context->>'payment_id' = p.id::text
             ) n ORDER BY n.created_at LIMIT 1) AS alert
       FROM booked b
       JOIN payments p ON p.id = b.payment_id
       LEFT JOIN units u ON u.id = p.unit_id
       LEFT JOIN v_payment_money vm ON vm.payment_id = p.id
      WHERE NOT EXISTS (SELECT 1 FROM allocation_splits s WHERE s.payment_id = b.payment_id)
      ORDER BY b.at, b.payment_id`)).rows

  let n = 0
  const unresolved: BackfillReport['allocationSplitsUnresolved'] = []
  for (const r of rows) {
    if (!r.property_id) {
      // No space to put it on: left for a person (never guessed), and listed.
      unresolved.push({ paymentId: r.payment_id, ownerShare: dollars(cents(r.owner_share)) })
      continue
    }
    const owner = cents(r.owner_share), mgrPaid = cents(r.manager_paid), pmPaid = cents(r.pm_paid)
    const sup = cents(r.supersedence), mk = cents(r.sublease_markup)
    let gross: number, withheld: number, uncovered = 0, pmDue = pmPaid, mgrDue = mgrPaid, shortBy = 0
    let method: string
    const a = r.alert
    if (a && a.gam_held_part != null) {
      // The admin notice allocation wrote when the cuts were more than GAM held
      // carries every figure of that split.
      gross = cents(a.gam_held_part as number)
      const fee = cents(a.landlord_fee as number)
      withheld = Math.min(fee, gross)
      uncovered = fee - withheld
      pmDue = cents(a.pm_company_fee as number)
      mgrDue = cents(a.manager_fee as number)
      shortBy = cents(a.short_by as number)
      method = 'from the admin notice allocation wrote when it capped the cuts (allocation_fees_exceed_held)'
    } else {
      // Nothing was short: what GAM holds on the row less the rows booked from
      // it, supersedence and markup is the landlord-paid fee it withheld.
      const held = cents(r.gam_held_part)
      const parts = owner + mgrPaid + pmPaid + sup + mk
      withheld = Math.max(0, held - parts)
      gross = parts + withheld
      method = held >= parts
        ? 'what GAM holds on the row (v_payment_money.gam_held_part, today) less the owner, manager and PM rows booked, supersedence and markup'
        : 'the owner, manager and PM rows booked plus supersedence and markup (GAM now holds less on the row than was split: no fee read as withheld)'
    }
    const ins = await c.query<{ id: string }>(
      `INSERT INTO allocation_splits
         (payment_id, landlord_id, property_id, remittance_id, credit_use_id,
          gross_held, landlord_fee_withheld, landlord_fee_uncovered, supersedence, sublease_markup,
          pm_fee_due, pm_paid, manager_fee_due, manager_paid, short_by, owner_share, created_at)
       VALUES ($1, $2, $3,
               CASE WHEN $4::text IS NULL THEN NULL ELSE
                 (SELECT tr.id FROM tenant_remittances tr WHERE tr.stripe_payment_intent_id = $4::text
                   ORDER BY tr.created_at, tr.id LIMIT 1) END,
               (SELECT CASE WHEN COUNT(*) = 1 THEN (array_agg(v.id))[1] END
                  FROM v_credit_uses v WHERE v.payment_id = $1 AND v.status = 'applied' AND v.gam_held),
               $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       -- 10/12 (ledger P1 review): one split per payment (allocation_splits_one_per_payment):
       -- a run overlapping another, or the writer, never adds a second.
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING id`,
      [r.payment_id, r.landlord_id, r.property_id,
       r.stripe_payment_intent_id && !r.manual_method ? r.stripe_payment_intent_id : null,
       dollars(gross), dollars(withheld), dollars(uncovered), dollars(sup), dollars(mk),
       dollars(pmDue), dollars(pmPaid), dollars(mgrDue), dollars(mgrPaid), dollars(shortBy), dollars(owner), r.at])
    if (!ins.rows[0]) continue
    await noteDerived(c, 'allocation_splits', ins.rows[0].id, '*', method, {
      payment_id: r.payment_id, gross_held: dollars(gross), landlord_fee_withheld: dollars(withheld),
      landlord_fee_uncovered: dollars(uncovered), short_by: dollars(shortBy), owner_share: dollars(owner),
    })
    n++
  }
  return { n, unresolved }
}

// ── payments.deposit_collected_by ────────────────────────────────────────────

async function backfillDepositCollectedBy(c: PoolClient): Promise<number> {
  // A deposit payment that ever settled (a later return or a move-out does not
  // change who collected it — depositCollectedBySql reads the stamp a finalize
  // leaves for exactly that reason).
  const rows = (await c.query<{ id: string; v: string }>(
    `UPDATE payments p SET deposit_collected_by = ${depositCollectedBySql('p')}
      WHERE p.type = 'deposit' AND p.settled_at IS NOT NULL AND p.deposit_collected_by IS NULL
        AND ${depositCollectedBySql('p')} IS NOT NULL
      RETURNING p.id, p.deposit_collected_by AS v`)).rows
  for (const r of rows) {
    await noteDerived(c, 'payments', r.id, 'deposit_collected_by',
      'leaseFeesSync.depositCollectedBySql, read on 10/12 or later', r.v)
  }
  return rows.length
}

// ── tenant_remittances.undone_at / undone_by ─────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function backfillRemittancesUndone(c: PoolClient): Promise<number> {
  // Only Undo match moves a SETTLED receipt to failed (a declined card or a
  // returned bank payment fails while still processing, never settled).
  const rows = (await c.query<{ id: string; updated_at: Date; marker_at: string | null; marker_by: string | null }>(
    `SELECT r.id, r.updated_at,
            m.undo->>'undoneAt' AS marker_at, m.undo->>'undoneBy' AS marker_by
       FROM tenant_remittances r
       LEFT JOIN LATERAL (
         SELECT bt.auto_settle_undo AS undo FROM bank_transactions bt
          WHERE bt.auto_settle_undo->>'undone' = 'true'
            AND bt.auto_settle_undo->'was'->>'receiptId' = r.id::text
          ORDER BY bt.updated_at DESC LIMIT 1) m ON TRUE
      WHERE r.status = 'failed' AND r.settled_at IS NOT NULL AND r.undone_at IS NULL
      ORDER BY r.created_at, r.id`)).rows
  let n = 0
  for (const r of rows) {
    const by = r.marker_by && UUID_RE.test(r.marker_by)
      ? (await c.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [r.marker_by])).rows[0]?.id ?? null
      : null
    const at = r.marker_at ?? r.updated_at
    const u = await c.query(
      `UPDATE tenant_remittances SET undone_at = $2, undone_by = $3 WHERE id = $1 AND undone_at IS NULL`,
      [r.id, at, by])
    if (!u.rowCount) continue
    const method = r.marker_at
      ? "the bank line's Undo marker (bank_transactions.auto_settle_undo undoneAt / undoneBy)"
      : "the receipt's updated_at (no Undo marker left on any bank line; who pressed it is not on record)"
    await noteDerived(c, 'tenant_remittances', r.id, 'undone_at', method, at)
    await noteDerived(c, 'tenant_remittances', r.id, 'undone_by', method, by)
    n++
  }
  return n
}

// ── held_payout_items.property_id ────────────────────────────────────────────

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** What a uuid inside a source id can name, in the order tried. */
const UUID_KINDS = ['saleId', 'bookingId', 'reversalId', 'paymentId', 'creditUseId', 'refundPartId', 'depositReturnId'] as const
const KIND_WORDS: Record<string, string> = {
  saleId: 'the register sale', bookingId: 'the booking', reversalId: 'the dispute / return record',
  paymentId: 'the payment', creditUseId: 'the paid-ahead spend', refundPartId: 'the refund part',
  depositReturnId: 'the move-out', charge: 'the Stripe charge',
}

async function propertyOf(c: PoolClient, p: HeldItemProperty, landlordId: string): Promise<string | null> {
  const { sql, key } = heldItemPropertySql(p, '$1', '$2')
  const params = 'charge' in p || 'disputeFeeLine' in p ? [key, landlordId] : [key]
  return (await c.query<{ pid: string | null }>(`SELECT ${sql} AS pid`, params)).rows[0]?.pid ?? null
}

/**
 * The property a held line written before 10/12 belongs to, from what its
 * source names (heldItemPropertySql — the writers' own rules): every uuid in
 * the source id, tried as each thing a line can be about; then a Stripe refund
 * (a stay / move-out refund part, a held pay-link payment), a Stripe dispute
 * (its payment, else its charge) and a Stripe charge (the one property it paid
 * for this landlord). null: nothing on record ties it to one property.
 *
 * 10/12 (ledger P1 review): a rent dispute's fee line ('stripe_fee_kept:…')
 * first and only by its own rule (heldPayouts disputeFeeLine — the reports'
 * incomeBasis.disputeFeePropertySql), the same one its writer now uses.
 */
export async function heldItemPropertyFromSource(
  c: PoolClient, item: { landlordId: string; sourceId: string; sourceType?: string },
): Promise<{ propertyId: string; method: string } | null> {
  if ((item.sourceType ?? 'dispute') === 'dispute' && item.sourceId.startsWith('stripe_fee_kept:')) {
    const pid = await propertyOf(c, { disputeFeeLine: item.sourceId }, item.landlordId)
    return pid
      ? { propertyId: pid, method: "the dispute fee line's own rule (incomeBasis.disputeFeePropertySql, the reports' placement)" }
      : null
  }
  for (const u of item.sourceId.match(UUID_IN) ?? []) {
    for (const kind of UUID_KINDS) {
      const pid = await propertyOf(c, { [kind]: u.toLowerCase() } as HeldItemProperty, item.landlordId)
      if (pid) return { propertyId: pid, method: `${KIND_WORDS[kind]} its source names (${u})` }
    }
  }
  for (const token of item.sourceId.split(':')) {
    if (/^re_/.test(token)) {
      const part = (await c.query<{ id: string }>(
        `SELECT id FROM stay_refund_parts WHERE stripe_refund_id = $1 ORDER BY created_at LIMIT 1`, [token])).rows[0]
      const pid = part ? await propertyOf(c, { refundPartId: part.id }, item.landlordId) : null
      if (pid) return { propertyId: pid, method: `the refund part its Stripe refund paid (${token})` }
      const held = (await c.query<{ property_id: string | null }>(
        `SELECT property_id FROM pos_held_payments WHERE stripe_refund_id = $1 AND landlord_id = $2 LIMIT 1`,
        [token, item.landlordId])).rows[0]
      if (held?.property_id) return { propertyId: held.property_id, method: `the held pay-link payment its Stripe refund paid (${token})` }
    }
    if (/^(du|dp)_/.test(token)) {
      const d = (await c.query<{ payment_id: string | null; pi: string | null }>(
        `SELECT payment_id, stripe_payment_intent_id AS pi FROM connect_disputes WHERE stripe_dispute_id = $1`, [token])).rows[0]
      const pid = d?.payment_id ? await propertyOf(c, { paymentId: d.payment_id }, item.landlordId)
        : d?.pi ? await propertyOf(c, { charge: d.pi }, item.landlordId) : null
      if (pid) return { propertyId: pid, method: `the disputed payment or charge (${token})` }
    }
    if (/^pi_/.test(token)) {
      const pid = await propertyOf(c, { charge: token }, item.landlordId)
      if (pid) return { propertyId: pid, method: `${KIND_WORDS.charge} (${token})` }
    }
  }
  return null
}

async function backfillHeldItemProperties(c: PoolClient): Promise<{ n: number; unresolved: BackfillReport['heldItemsUnresolved'] }> {
  // A business has no properties: its lines stay company-level (NULL).
  const items = (await c.query<{ id: string; landlord_id: string; source_type: string; source_id: string }>(
    `SELECT id, landlord_id, source_type, source_id FROM held_payout_items
      WHERE property_id IS NULL AND landlord_id IS NOT NULL
      ORDER BY created_at, id`)).rows
  let n = 0
  const unresolved: BackfillReport['heldItemsUnresolved'] = []
  for (const it of items) {
    const found = await heldItemPropertyFromSource(c, { landlordId: it.landlord_id, sourceId: it.source_id, sourceType: it.source_type })
    if (!found) { unresolved.push({ id: it.id, sourceType: it.source_type, sourceId: it.source_id }); continue }
    const u = await c.query(
      `UPDATE held_payout_items SET property_id = $2 WHERE id = $1 AND property_id IS NULL`, [it.id, found.propertyId])
    if (!u.rowCount) continue
    await noteDerived(c, 'held_payout_items', it.id, 'property_id', found.method, found.propertyId)
    n++
  }
  return { n, unresolved }
}

// ── stay_payments.lodging_tax_amount ─────────────────────────────────────────

async function backfillStayLodgingTax(c: PoolClient): Promise<number> {
  // Booking-site deposits only: a register sale's row keeps its tax on the sale.
  const rows = (await c.query<{ id: string; booking_id: string; toward: string }>(
    `SELECT id, booking_id, toward_stay::text AS toward FROM stay_payments
      WHERE kind = 'site_deposit' AND lodging_tax_amount IS NULL
      ORDER BY created_at, id`)).rows
  let n = 0
  for (const r of rows) {
    const tax = await siteDepositLodgingTax(c, r.booking_id, Number(r.toward))
    const u = await c.query(
      `UPDATE stay_payments SET lodging_tax_amount = $2 WHERE id = $1 AND lodging_tax_amount IS NULL`, [r.id, tax.toFixed(2)])
    if (!u.rowCount) continue
    await noteDerived(c, 'stay_payments', r.id, 'lodging_tax_amount',
      "priced by priceStay at the property's short-stay tax rate in force when backfilled (the rate the day it was paid is not on record)",
      tax.toFixed(2))
    n++
  }
  return n
}

// ── pos_refunds.tax_refunded ─────────────────────────────────────────────────

async function backfillRefundTax(c: PoolClient): Promise<number> {
  const rows = (await c.query<{ id: string; transaction_id: string; amount: string; fee: string }>(
    `SELECT id, transaction_id, amount::text, card_fee_refunded::text AS fee FROM pos_refunds
      WHERE tax_refunded IS NULL ORDER BY created_at, id`)).rows
  let n = 0
  for (const r of rows) {
    const tax = await saleRefundTax(c, r.transaction_id, Number(r.amount), Number(r.fee))
    const u = await c.query(`UPDATE pos_refunds SET tax_refunded = $2 WHERE id = $1 AND tax_refunded IS NULL`, [r.id, tax.toFixed(2)])
    if (!u.rowCount) continue
    await noteDerived(c, 'pos_refunds', r.id, 'tax_refunded',
      "the refund rule (earlyCheckOut.saleRefundTax) on the sale's totals as they stand when backfilled", tax.toFixed(2))
    n++
  }
  return n
}

// ── pos_transactions.voided_at ───────────────────────────────────────────────

async function backfillSalesVoidedAt(c: PoolClient): Promise<number> {
  const rows = (await c.query<{ id: string; at: Date; from_restock: boolean }>(
    `UPDATE pos_transactions t
        SET voided_at = COALESCE(x.restock_at, t.created_at)
       FROM (SELECT t2.id,
                    (SELECT MIN(l.created_at) FROM pos_inventory_log l
                      WHERE l.reference_id = t2.id AND l.reason = 'return' AND l.notes = 'Sale voided') AS restock_at
               FROM pos_transactions t2
              WHERE t2.status = 'voided' AND t2.voided_at IS NULL) x
      WHERE t.id = x.id AND t.voided_at IS NULL
      RETURNING t.id, t.voided_at AS at, (x.restock_at IS NOT NULL) AS from_restock`)).rows
  for (const r of rows) {
    await noteDerived(c, 'pos_transactions', r.id, 'voided_at', r.from_restock
      ? "the restock the void wrote (pos_inventory_log 'Sale voided')"
      : "the sale's own time (the void wrote no restock; when it was voided is not on record)", r.at)
  }
  return rows.length
}

// ── payments.work_trade_credit ───────────────────────────────────────────────

async function backfillWorkTradeCredit(c: PoolClient): Promise<{ n: number; unresolved: BackfillReport['workTradeCreditUnresolved'] }> {
  // Every rise in a bill's work-trade credit the journal holds, with the falls
  // in its rows' amounts made in the same transaction (one changed_at).
  const events = (await c.query<{ invoice_id: string; at: string; rise: string }>(
    `SELECT a.row_id AS invoice_id, a.changed_at::text AS at,
            ((a.new_row->>'work_trade_credit_amount')::numeric - (a.old_row->>'work_trade_credit_amount')::numeric)::text AS rise
       FROM audit_row_changes a
      WHERE a.table_name = 'invoices' AND a.op = 'UPDATE'
        AND (a.new_row->>'work_trade_credit_amount')::numeric > (a.old_row->>'work_trade_credit_amount')::numeric
      ORDER BY a.changed_at, a.id`)).rows
  const takes = new Map<string, number>()       // payment id → cents
  const explainedBy = new Map<string, number>() // invoice id → cents explained
  for (const e of events) {
    const falls = (await c.query<{ payment_id: string; fall: string }>(
      `SELECT a.row_id AS payment_id,
              ((a.old_row->>'amount')::numeric - (a.new_row->>'amount')::numeric)::text AS fall
         FROM audit_row_changes a
        WHERE a.table_name = 'payments' AND a.op = 'UPDATE'
          AND a.changed_at = $2::timestamptz
          AND a.old_row->>'invoice_id' = $1
          AND (a.new_row->>'amount')::numeric < (a.old_row->>'amount')::numeric`,
      [e.invoice_id, e.at])).rows
    const fallCents = falls.reduce((s, f) => s + cents(f.fall), 0)
    // Only a close whose rows' falls are exactly the bill's rise is the close's.
    if (fallCents !== cents(e.rise)) continue
    for (const f of falls) takes.set(f.payment_id, (takes.get(f.payment_id) ?? 0) + cents(f.fall))
    explainedBy.set(e.invoice_id, (explainedBy.get(e.invoice_id) ?? 0) + fallCents)
  }
  let n = 0
  for (const [paymentId, take] of takes) {
    const u = await c.query(
      `UPDATE payments SET work_trade_credit = $2::numeric
        WHERE id = $1 AND work_trade_credit = 0
          AND NOT EXISTS (SELECT 1 FROM ledger_derived_facts d
                           WHERE d.table_name = 'payments' AND d.row_id = $1 AND d.column_name = 'work_trade_credit')`,
      [paymentId, dollars(take)])
    if (!u.rowCount) continue
    await noteDerived(c, 'payments', paymentId, 'work_trade_credit',
      "the change journal: the amount the work-trade month close took off this row, in the transaction that raised its bill's work_trade_credit_amount by the same total",
      dollars(take))
    n++
  }
  // A bill with work-trade credit the journal does not (fully) explain.
  const unresolved = (await c.query<{ id: string; credit: string }>(
    `SELECT i.id, i.work_trade_credit_amount::text AS credit FROM invoices i
      WHERE i.work_trade_credit_amount > 0
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.work_trade_credit > 0
                          AND NOT EXISTS (SELECT 1 FROM ledger_derived_facts d
                                           WHERE d.table_name = 'payments' AND d.row_id = p.id AND d.column_name = 'work_trade_credit'))
      ORDER BY i.due_date, i.id`)).rows
    .filter(r => (explainedBy.get(r.id) ?? 0) !== cents(r.credit))
    .map(r => ({ invoiceId: r.id, credit: dollars(cents(r.credit)), explained: dollars(explainedBy.get(r.id) ?? 0) }))
  return { n, unresolved }
}

// ── payments.work_trade_settlement_id ────────────────────────────────────────

const UNWORKED_NOTE_RE = /^Work-trade hours not completed for ([A-Za-z]+ \d{4}) — billed when the agreement ended/

async function backfillWorkTradeSettlementLinks(c: PoolClient): Promise<{ n: number; unresolved: BackfillReport['workTradeSettlementUnresolved'] }> {
  const rows = (await c.query<{ id: string; unit_id: string | null; tenant_id: string | null; notes: string }>(
    `SELECT id, unit_id, tenant_id, notes FROM payments
      WHERE type = 'carried_balance' AND entry_description = 'BALANCE'
        AND work_trade_settlement_id IS NULL
        AND notes LIKE 'Work-trade hours not completed for %'
      ORDER BY created_at, id`)).rows
  let n = 0
  const unresolved: BackfillReport['workTradeSettlementUnresolved'] = []
  for (const r of rows) {
    const month = UNWORKED_NOTE_RE.exec(r.notes ?? '')?.[1] ?? null
    const found = month && r.unit_id && r.tenant_id ? (await c.query<{ id: string }>(
      `SELECT s.id FROM work_trade_settlements s
         JOIN work_trade_agreements a ON a.id = s.agreement_id
        WHERE a.unit_id = $1 AND a.tenant_id = $2 AND s.status = 'billed'
          AND to_char(s.period_month, 'FMMonth YYYY') = $3`, [r.unit_id, r.tenant_id, month])).rows : []
    if (found.length !== 1) { unresolved.push({ paymentId: r.id, note: r.notes }); continue }
    const u = await c.query(
      `UPDATE payments SET work_trade_settlement_id = $2 WHERE id = $1 AND work_trade_settlement_id IS NULL`,
      [r.id, found[0].id])
    if (!u.rowCount) continue
    await noteDerived(c, 'payments', r.id, 'work_trade_settlement_id',
      `the billed work-trade period of this space and tenant for ${month}, named in the row's note`, found[0].id)
    n++
  }
  return { n, unresolved }
}

// ── home_sale_contracts.activated_at ─────────────────────────────────────────

async function backfillHomeSaleActivatedAt(c: PoolClient): Promise<number> {
  const rows = (await c.query<{ id: string; at: Date; from_journal: boolean }>(
    `WITH went AS (
       SELECT a.row_id AS id, MIN(a.changed_at) AS at FROM audit_row_changes a
        WHERE a.table_name = 'home_sale_contracts' AND a.op = 'UPDATE'
          AND a.new_row->>'status' = 'active' AND a.old_row->>'status' IS DISTINCT FROM 'active'
        GROUP BY a.row_id)
     UPDATE home_sale_contracts h
        SET activated_at = COALESCE(w.at, h.created_at)
       FROM home_sale_contracts h2 LEFT JOIN went w ON w.id = h2.id
      WHERE h.id = h2.id AND h.activated_at IS NULL
        AND (h.status IN ('active', 'paid_off')
             OR (h.status = 'cancelled' AND (h.installments_billed > 0 OR w.at IS NOT NULL)))
      RETURNING h.id, h.activated_at AS at, (w.at IS NOT NULL) AS from_journal`)).rows
  for (const r of rows) {
    await noteDerived(c, 'home_sale_contracts', r.id, 'activated_at', r.from_journal
      ? "the change journal's move of the contract to 'active'"
      : "the contract's created_at (no record of when it went active; a contract written active is active from when it was written)",
      r.at)
  }
  return rows.length
}

/** Every step, inside the caller's transaction. See the header. */
export async function backfillLedgerSourceFacts(c: PoolClient): Promise<BackfillReport> {
  const splits = await backfillAllocationSplits(c)
  const depositCollectedBy = await backfillDepositCollectedBy(c)
  const remittancesUndone = await backfillRemittancesUndone(c)
  const held = await backfillHeldItemProperties(c)
  const stayLodgingTax = await backfillStayLodgingTax(c)
  const refundTax = await backfillRefundTax(c)
  const salesVoidedAt = await backfillSalesVoidedAt(c)
  const wtCredit = await backfillWorkTradeCredit(c)
  const wtLinks = await backfillWorkTradeSettlementLinks(c)
  const homeSaleActivatedAt = await backfillHomeSaleActivatedAt(c)
  return {
    allocationSplits: splits.n, allocationSplitsUnresolved: splits.unresolved, depositCollectedBy, remittancesUndone,
    heldItemProperties: held.n, heldItemsUnresolved: held.unresolved,
    stayLodgingTax, refundTax, salesVoidedAt,
    workTradeCredit: wtCredit.n, workTradeCreditUnresolved: wtCredit.unresolved,
    workTradeSettlementLinks: wtLinks.n, workTradeSettlementUnresolved: wtLinks.unresolved,
    homeSaleActivatedAt,
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await backfillLedgerSourceFacts(c)
    const db = (await c.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d
    console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${db}:`)
    console.log(`  allocation_splits written ............ ${r.allocationSplits}`)
    console.log(`  payments.deposit_collected_by ........ ${r.depositCollectedBy}`)
    console.log(`  tenant_remittances undone_at/by ...... ${r.remittancesUndone}`)
    console.log(`  held_payout_items.property_id ........ ${r.heldItemProperties}`)
    console.log(`  stay_payments.lodging_tax_amount ..... ${r.stayLodgingTax}`)
    console.log(`  pos_refunds.tax_refunded ............. ${r.refundTax}`)
    console.log(`  pos_transactions.voided_at ........... ${r.salesVoidedAt}`)
    console.log(`  payments.work_trade_credit ........... ${r.workTradeCredit}`)
    console.log(`  payments.work_trade_settlement_id .... ${r.workTradeSettlementLinks}`)
    console.log(`  home_sale_contracts.activated_at ..... ${r.homeSaleActivatedAt}`)
    if (r.workTradeCreditUnresolved.length) {
      console.log(`  bills whose work-trade credit the journal does not explain (rows left at 0, ${r.workTradeCreditUnresolved.length}):`)
      for (const u of r.workTradeCreditUnresolved) console.log(`    invoice ${u.invoiceId}  credit $${u.credit}  explained $${u.explained}`)
    }
    if (r.workTradeSettlementUnresolved.length) {
      console.log(`  unworked-hours rows with no single billed period to name (left NULL, ${r.workTradeSettlementUnresolved.length}):`)
      for (const u of r.workTradeSettlementUnresolved) console.log(`    payment ${u.paymentId}  ${u.note}`)
    }
    if (r.allocationSplitsUnresolved.length) {
      console.log(`  owner shares with no property on record (no split written, ${r.allocationSplitsUnresolved.length}):`)
      for (const u of r.allocationSplitsUnresolved) console.log(`    payment ${u.paymentId}  owner share $${u.ownerShare}`)
    }
    if (r.heldItemsUnresolved.length) {
      console.log(`  held lines with no property on record (left company-level, ${r.heldItemsUnresolved.length}):`)
      for (const u of r.heldItemsUnresolved) console.log(`    ${u.id}  ${u.sourceType}  ${u.sourceId}`)
    }
    const withheld = (await c.query<{ n: string; s: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(s.landlord_fee_withheld), 0)::text AS s
         FROM allocation_splits s JOIN ledger_derived_facts d
           ON d.table_name = 'allocation_splits' AND d.row_id = s.id AND d.column_name = '*'`)).rows[0]
    console.log(`  derived splits on record: ${withheld.n}, landlord fee withheld on them $${round2(Number(withheld.s)).toFixed(2)}`)
    await c.query(apply ? 'COMMIT' : 'ROLLBACK')
    console.log(apply ? 'Committed.' : 'Rolled back (dry run). Re-run with --apply to write.')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
