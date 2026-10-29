/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4: THE NIGHTLY TIE-OUTS FOR TENANT
 * MONEY (gam-ledger-design-2026-10-12 §8 table; phase P4)
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * Each check compares an account the tenant-money projectors post
 * (services/ledgerProjectors/tenant*) with the money records it must equal,
 * read on the nightly check's one REPEATABLE READ snapshot (ledgerCheck). A
 * difference is a finding; it is never plugged. While a record that posts to
 * the account is still waiting (an outbox row, or a source waiting on the
 * owner's choice or failing), a difference is 'pending', not drift — the books
 * are behind, not wrong. 10/12 (Nic, ledger review): only a waiting record
 * that posts to THAT account, and for receivables (per tenant and property)
 * and deposits GAM holds (per lease) only the keys it touches — never any
 * waiting row of the company (services/ledgerPending).
 *
 *   1100 receivables      per tenant and property: the money part of every
 *                         landlord bill still open (pending, processing,
 *                         failed — work-trade suspended included), never GAM's
 *                         rows, the FlexPay pull, FlexDeposit installments, the
 *                         move-out refund row or the prepaid move-in box (L13).
 *                         Its own rule, NOT payableRowSql (that drops a bank
 *                         payment in flight and keeps GAM's rows).
 *   1040 undeposited      desk receipts in cash, check or money order (not
 *                         matched to a bank line) and register cash sales at
 *                         their full total, less what matched deposit slips
 *                         carried to the bank (each item, and the slip's other
 *                         money), less cash handed back on any register refund
 *                         and on refund parts, plus or minus the drawer's over
 *                         and short — exactly what the projectors post (no
 *                         365-day window). 10/12 review: a refunded cash sale
 *                         is no longer counted net AND its refund taken off
 *                         again; a cash sale refunded by check stays in the
 *                         drawer; a card sale refunded in cash leaves it.
 *   1045 in transit       bank-deposit receipts no bank line is matched to yet
 *   2050 paid ahead       paid-ahead money the LANDLORD holds (funded by the
 *                         landlord, or rent moved to credit): what arrived less
 *                         every spend, plus paid-ahead money entered as an
 *                         opening balance. 1055 must stay empty (Nic L13: money
 *                         GAM holds is not on the landlord's balance sheet).
 *   2020 deposits owed    deposits billed (and deposits collected in
 *                         installments, in full) on leases not yet moved out,
 *                         plus what a finished move-out still has to refund,
 *                         plus deposits entered as opening balances
 *   1070 deposits GAM     per lease not yet moved out: deposit money paid
 *        holds            through GAM (less what a dispute took back) and
 *                         deposits collected in installments. After move-out
 *                         its releases are the held payout items (phase P5).
 *   1310 home notes       per contract, whole sale at signing: financed less
 *                         the principal of every installment billed or paid
 *                         outside GAM; 0 once cancelled; none for income as paid
 *   2015 outstanding      everything the books owe the bank until a bank line
 *                         clears it: tenant refunds by check or money order,
 *                         register refunds by check, and GAM fee pulls that
 *                         succeeded (design H5). No bank match clears any of
 *                         them yet (the H5 / refund-check bank match waits on
 *                         phase P6), so all of them.
 *   settled rows          every settled landlord bill is explained by its
 *                         receipts, credit spent on it, a prior arrangement,
 *                         GAM covering it, or work-trade hours (production ties
 *                         today) — an unexplained one would sit open in 1100.
 *
 * registerTenantLedgerChecks() adds them to the nightly run (the integrate
 * step calls it beside the projectors).
 */
import type { PoolClient } from 'pg'
import { registerLedgerCheck, unregisterLedgerCheck, type LedgerCheck, type LedgerFinding, type LedgerFindingSeverity } from './ledgerCheck'
import type { LedgerOwner } from './ledgerOwner'
import { loadPendingScope, waitingFor, severityOf, PAYMENT_PROPERTY, type PendingRule } from './ledgerPending'

const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0))
const C = (expr: string) => `round((${expr}) * 100)::bigint`

/**
 * 10/12 (Nic, ledger review): the source types that post to each account (and,
 * for a waiting bill row, the rows that do) — a difference is pending only
 * while one of these waits (services/ledgerPending).
 */
export const TENANT_CHECK_RULES = {
  /** 1100 per tenant and property; a waiting row-touching source makes only its own keys pending. */
  receivablesUnkeyed: { types: ['bank_match'] },
  undepositedFunds: { types: ['remittance', 'pos_sale', 'pos_refund', 'refund_part', 'deposit_slip', 'pos_eod', 'bank_match',
    // 10/12 (Nic, ledger P6): a slip's other money filed as other income, and expenses paid in cash from the drawer.
    'other_income', 'expense_payment',
    // 10/13 (Nic): a fixed asset typed in by hand, bought with cash on hand.
    'fixed_asset'] },
  depositsInTransit: { types: ['remittance', 'bank_match'] },
  paidAhead: {
    types: ['payment', 'remittance', 'credit_use', 'prepaid_credit', 'refund_part'],
    payment: p => p.revenueOwner === 'held',
  },
  depositsOwed: {
    types: ['payment', 'security_deposit', 'deposit_return', 'credit_use', 'refund_part', 'held_item', 'property_transfer'],
    payment: p => p.type === 'deposit' || p.status === 'paid_via_deposit',
  },
  homeNotes: { types: ['payment', 'home_sale', 'home_installment'], payment: p => p.type === 'home_payment' },
  outstandingChecks: { types: ['refund_part', 'pos_refund', 'gam_debit',
    // 10/12 (Nic, ledger P6): the bank line that clears one, and expenses paid by check.
    'bank_match', 'expense_payment'] },
} satisfies Record<string, PendingRule>

/** A company-level difference's severity: pending while a source posting to the account waits. */
async function severityFor(client: PoolClient, landlordId: string, rule: PendingRule): Promise<LedgerFindingSeverity> {
  return severityOf(waitingFor(await loadPendingScope(client, landlordId), rule))
}

/** Ledger balance (debits − credits, cents) of the given roles, grouped by `dims`. */
async function ledgerBy(client: PoolClient, landlordId: string, roles: string[], dims: string[], extraWhere = ''): Promise<Map<string, number>> {
  const cols = dims.length ? dims.map(d => `${d}::text`).join(`, `) : `''`
  const r = await client.query<{ k: string; n: string }>(
    `SELECT concat_ws('|', ${cols}) AS k, ${C('sum(debit - credit)')}::text AS n
       FROM ledger_posting_lines
      WHERE landlord_id = $1 AND account_role = ANY($2::text[]) ${extraWhere}
      GROUP BY 1`, [landlordId, roles])
  return new Map(r.rows.map(x => [x.k ?? '', cents(x.n)]))
}

/** Findings for every key where the ledger and the money records differ (`sev`: one severity, or one per key). */
function compare(check: string, sev: LedgerFindingSeverity | ((key: string) => LedgerFindingSeverity), ledger: Map<string, number>,
  expected: Map<string, number>, keyNames: string[], sign: 1 | -1): LedgerFinding[] {
  const out: LedgerFinding[] = []
  for (const k of new Set([...ledger.keys(), ...expected.keys()])) {
    const l = (ledger.get(k) ?? 0) * sign
    const e = expected.get(k) ?? 0
    if (l === e) continue
    const parts = k.split('|')
    const detail: Record<string, unknown> = { ledgerCents: l, expectedCents: e, differenceCents: l - e }
    keyNames.forEach((n, i) => { detail[n] = parts[i] || null })
    out.push({ check, severity: typeof sev === 'function' ? sev(k) : sev, detail })
  }
  return out
}

/** SQL: payments row `p` is a FlexDeposit installment row (custody money, never the landlord's book). */
const FLEX_ROW = `(EXISTS (SELECT 1 FROM flex_deposit_installments f WHERE f.payment_id = p.id)
   OR (p.type = 'deposit' AND p.lease_fee_id IS NULL
       AND EXISTS (SELECT 1 FROM security_deposits sd WHERE sd.lease_id = p.lease_id AND sd.flex_deposit_enabled IS TRUE AND sd.status <> 'voided')))`

function landlordOf(owner: LedgerOwner): string | null {
  return owner.landlordId ?? null
}

// ─── 1100 ───────────────────────────────────────────────────────────────────

export const receivablesCheck: LedgerCheck = {
  name: 'tenant_receivables',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const ledger = await ledgerBy(client, id, ['ar_tenants'], ['tenant_id', 'property_id'])
    const r = await client.query<{ k: string; n: string }>(
      `SELECT concat_ws('|', p.tenant_id::text, (${PAYMENT_PROPERTY})::text) AS k, ${C('sum(v.money_part)')}::text AS n
         FROM payments p JOIN v_payment_money v ON v.payment_id = p.id
        WHERE p.landlord_id = $1
          AND p.status IN ('pending', 'processing', 'failed')
          AND p.voided_at IS NULL
          AND p.revenue_owner = 'landlord'
          AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
          AND NOT ${FLEX_ROW}
          AND NOT EXISTS (SELECT 1 FROM deposit_returns d WHERE d.refund_payment_id = p.id)
        GROUP BY 1`, [id])
    const expected = new Map(r.rows.map(x => [x.k ?? '', cents(x.n)]))
    const scope = await loadPendingScope(client, id)
    const unkeyed = waitingFor(scope, TENANT_CHECK_RULES.receivablesUnkeyed)
    return compare('tenant_receivables', k => severityOf(unkeyed || scope.tenantProperty.has(k)),
      ledger, expected, ['tenantId', 'propertyId'], 1)
  },
}

// ─── 1040 ───────────────────────────────────────────────────────────────────

export const undepositedFundsCheck: LedgerCheck = {
  name: 'undeposited_funds',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const ledger = await ledgerBy(client, id, ['undeposited_funds'], [])
    // 10/12 (Nic, ledger review): each term is exactly what a projector posts
    // to 1040 — a cash sale at its FULL total (registerSale F1), every register
    // refund paid from the drawer whatever the sale was paid with
    // (registerRefund F3; an early check-out's part is its own term), and each
    // matched deposit slip's items and other money at what the slip carried
    // (tenantReceipts B8). 10/12 (Nic, ledger P6): a slip's other money filed
    // as other income goes into the drawer first (design I4: Dr 1040), so it
    // is added back here; and an expense paid in cash from the office drawer
    // (expense_payment, method 'cash') takes it out. 10/13 (Nic): so does a
    // fixed asset typed in by hand that was bought with cash on hand
    // (books_fixed_assets.funded_by 'cash', ledgerProjectors/loansAssets),
    // once it is on the books (bought on or after the books start) — and,
    // 10/13 (Nic, "ALLOW A MIX"), each live cash-on-hand funding line of one
    // (books_fixed_asset_funding kind 'cash', its part of the cost).
    const r = await client.query<{ n: string }>(
      `WITH live_slip AS (
         SELECT s.id, s.other_amount FROM bank_deposit_slips s JOIN bank_transactions bt ON bt.id = s.bank_transaction_id
          WHERE s.landlord_id = $1 AND s.status = 'matched' AND s.voided_at IS NULL)
       SELECT (
         COALESCE((SELECT ${C('sum(r.amount)')} FROM tenant_remittances r
                    WHERE r.landlord_id = $1 AND r.status = 'settled' AND r.undone_at IS NULL
                      AND r.payment_method IN ('cash', 'check', 'money_order') AND r.stripe_payment_intent_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM bank_transactions bmr
                                       WHERE bmr.landlord_id = r.landlord_id AND bmr.status = 'matched'
                                         AND bmr.auto_settle_undo->>'receiptId' = r.id::text)), 0)
       + COALESCE((SELECT ${C('sum(t.total)')} FROM pos_transactions t
                    WHERE t.landlord_id = $1 AND t.payment_method = 'cash' AND t.status <> 'voided' AND t.voided_at IS NULL), 0)
       - COALESCE((SELECT ${C('sum(i.amount)')} FROM bank_deposit_slip_items i JOIN live_slip s ON s.id = i.slip_id
                    WHERE i.voided_at IS NULL), 0)
       - COALESCE((SELECT ${C('sum(s.other_amount)')} FROM live_slip s), 0)
       -- 10/14 (Nic, answer 15): a check the bank returned out of a slip and
       -- GAM took back — its receipt counts nothing now, the slip above still
       -- took it out of the drawer, and the bank's returned line puts it back
       -- (ledgerProjectors/tenantReceipts projectReturnedCheck: Dr 1040 / Cr bank).
       + COALESCE((SELECT ${C('sum(-bt.amount)')} FROM bank_transactions bt
                    WHERE bt.landlord_id = $1 AND bt.status = 'matched'
                      AND bt.auto_settle_undo->>'kind' = 'returned_check'), 0)
       - COALESCE((SELECT ${C('sum(pr.amount)')} FROM pos_refunds pr
                    WHERE pr.landlord_id = $1 AND pr.refund_method = 'cash' AND pr.stay_refund_part_id IS NULL
                      AND pr.reversed_at IS NULL), 0)
       - COALESCE((SELECT ${C('sum(rp.amount)')} FROM stay_refund_parts rp
                    WHERE rp.landlord_id = $1 AND rp.kind = 'cash' AND rp.reversed_at IS NULL
                      AND rp.status IN ('refunded', 'handed_back')), 0)
       + COALESCE((SELECT ${C('sum(e.cash_drawer_variance)')} FROM pos_eod_settlements e
                    WHERE e.landlord_id = $1 AND e.status <> 'reopened'), 0)
       + COALESCE((SELECT ${C('sum(o.amount)')} FROM landlord_other_income o
                     JOIN bank_transactions sb ON sb.landlord_other_income_id = o.id
                    WHERE o.landlord_id = $1 AND o.status = 'active' AND o.voided_at IS NULL
                      AND sb.status = 'matched' AND sb.auto_settle_undo->>'kind' = 'deposit_slip'), 0)
       - COALESCE((SELECT ${C('sum(xp.amount)')} FROM landlord_expense_payments xp
                    WHERE xp.landlord_id = $1 AND xp.method = 'cash' AND xp.voided_at IS NULL), 0)
       - COALESCE((SELECT ${C('sum(fa.cost)')} FROM books_fixed_assets fa JOIN landlords fl ON fl.id = fa.landlord_id
                    WHERE fa.landlord_id = $1 AND fa.funded_by = 'cash' AND fa.voided_at IS NULL AND fa.source_expense_id IS NULL
                      AND fl.books_start_date IS NOT NULL AND fa.acquired_on >= fl.books_start_date), 0)
       - COALESCE((SELECT ${C('sum(fx.amount)')} FROM books_fixed_asset_funding fx
                     JOIN books_fixed_assets fa ON fa.id = fx.asset_id JOIN landlords fl ON fl.id = fa.landlord_id
                    WHERE fa.landlord_id = $1 AND fx.kind = 'cash' AND fx.replaced_at IS NULL AND fa.voided_at IS NULL
                      AND fa.source_expense_id IS NULL
                      AND fl.books_start_date IS NOT NULL AND fa.acquired_on >= fl.books_start_date), 0))::text AS n`, [id])
    const expected = new Map([['', cents(r.rows[0]?.n)]])
    return compare('undeposited_funds', await severityFor(client, id, TENANT_CHECK_RULES.undepositedFunds), ledger, expected, [], 1)
  },
}

// ─── 1045 ───────────────────────────────────────────────────────────────────

export const depositsInTransitCheck: LedgerCheck = {
  name: 'deposits_in_transit',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const ledger = await ledgerBy(client, id, ['deposits_in_transit'], [])
    const r = await client.query<{ n: string }>(
      `SELECT COALESCE(${C('sum(r.amount)')}, 0)::text AS n FROM tenant_remittances r
        WHERE r.landlord_id = $1 AND r.status = 'settled' AND r.undone_at IS NULL AND r.payment_method = 'bank_deposit'
          AND NOT EXISTS (SELECT 1 FROM bank_transactions bt
                           WHERE bt.landlord_id = r.landlord_id AND bt.status = 'matched'
                             AND bt.auto_settle_undo->>'receiptId' = r.id::text)`, [id])
    const expected = new Map([['', cents(r.rows[0]?.n)]])
    return compare('deposits_in_transit', await severityFor(client, id, TENANT_CHECK_RULES.depositsInTransit), ledger, expected, [], 1)
  },
}

// ─── 2050 and 1055 ──────────────────────────────────────────────────────────

export const paidAheadCheck: LedgerCheck = {
  name: 'tenant_prepayments',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const out: LedgerFinding[] = []
    const ledger = await ledgerBy(client, id, ['tenant_prepayments'], [])
    const r = await client.query<{ n: string }>(
      `SELECT (
         COALESCE((SELECT ${C(`sum(pc.amount_original - COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                                                              WHERE cu.prepaid_credit_id = pc.id AND cu.status IN ('applied', 'reversed')), 0))`)}
                     FROM lease_prepaid_credits pc JOIN leases l ON l.id = COALESCE(pc.received_lease_id, pc.lease_id)
                    WHERE l.landlord_id = $1 AND pc.voided_at IS NULL AND pc.funded_by IN ('landlord', 'reclassified')), 0)
       + COALESCE((SELECT ${C('sum(o.amount)')} FROM books_opening_items o
                    WHERE o.landlord_id = $1 AND o.kind = 'paid_ahead_held' AND o.voided_at IS NULL), 0))::text AS n`, [id])
    out.push(...compare('tenant_prepayments', await severityFor(client, id, TENANT_CHECK_RULES.paidAhead), ledger,
      new Map([['', cents(r.rows[0]?.n)]]), [], -1))
    const held = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'due_from_gam_tenant_money'`, [id])
    if ((held.rows[0]?.n ?? 0) > 0) {
      out.push({ check: 'gam_held_paid_ahead_on_books', severity: 'integrity',
        detail: { lines: held.rows[0].n, why: 'Nic L13: paid-ahead money GAM holds is not on the landlord’s balance sheet (1055 must stay empty)' } })
    }
    return out
  },
}

// ─── 2020 ───────────────────────────────────────────────────────────────────

export const depositsOwedCheck: LedgerCheck = {
  name: 'security_deposits_payable',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const ledger = await ledgerBy(client, id, ['security_deposits_payable'], [])
    const r = await client.query<{ n: string }>(
      `WITH moved_out AS (SELECT d.id, d.lease_id, d.refund_amount FROM deposit_returns d
                           WHERE d.landlord_id = $1 AND d.finalized_at IS NOT NULL
                             AND d.status NOT IN ('draft', 'awaiting_approval'))
       SELECT (
         COALESCE((SELECT ${C('sum(p.amount)')} FROM payments p
                    WHERE p.landlord_id = $1 AND p.type = 'deposit' AND p.voided_at IS NULL AND p.revenue_owner = 'landlord'
                      AND NOT ${FLEX_ROW}
                      AND NOT EXISTS (SELECT 1 FROM deposit_returns d WHERE d.refund_payment_id = p.id OR d.gap_payment_id = p.id)
                      AND p.reversal_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM moved_out m WHERE m.lease_id = p.lease_id)), 0)
       + COALESCE((SELECT ${C('sum(sd.total_amount)')} FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id
                    WHERE l.landlord_id = $1 AND sd.flex_deposit_enabled IS TRUE AND sd.status <> 'voided'
                      AND EXISTS (SELECT 1 FROM flex_deposit_installments f WHERE f.security_deposit_id = sd.id)
                      AND NOT EXISTS (SELECT 1 FROM moved_out m WHERE m.lease_id = sd.lease_id)), 0)
       + COALESCE((SELECT ${C(`sum(m.refund_amount - COALESCE((SELECT sum(rp.toward_amount) FROM stay_refund_parts rp
                                                                WHERE rp.deposit_return_id = m.id AND rp.reversed_at IS NULL
                                                                  AND rp.status IN ('refunded', 'handed_back', 'credited')), 0))`)}
                     FROM moved_out m), 0)
       + COALESCE((SELECT ${C('sum(o.amount)')} FROM books_opening_items o
                    WHERE o.landlord_id = $1 AND o.kind = 'deposit_held' AND o.voided_at IS NULL), 0))::text AS n`, [id])
    return compare('security_deposits_payable', await severityFor(client, id, TENANT_CHECK_RULES.depositsOwed), ledger,
      new Map([['', cents(r.rows[0]?.n)]]), [], -1)
  },
}

// ─── 1070 ───────────────────────────────────────────────────────────────────

export const depositsGamHoldsCheck: LedgerCheck = {
  name: 'deposits_gam_holds',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    // Leases not yet moved out only: after the move-out the money leaves 1070
    // through the released held items (phase P5) and the refund parts.
    const ledger = await ledgerBy(client, id, ['deposits_gam_holds'], ['lease_id'],
      `AND lease_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deposit_returns d WHERE d.lease_id = ledger_posting_lines.lease_id
                                                   AND d.finalized_at IS NOT NULL)`)
    const r = await client.query<{ k: string; n: string }>(
      `SELECT x.lease_id::text AS k, ${C('sum(x.amt)')}::text AS n FROM (
         SELECT p.lease_id, ra.amount_applied AS amt
           FROM remittance_applications ra
           JOIN tenant_remittances r ON r.id = ra.remittance_id
           JOIN payments p ON p.id = ra.payment_id
          WHERE p.landlord_id = $1 AND p.type = 'deposit' AND r.status = 'settled' AND r.undone_at IS NULL
            AND r.payment_method IN ('card', 'ach') AND p.deposit_collected_by IS DISTINCT FROM 'landlord'
            AND p.revenue_owner = 'landlord' AND NOT ${FLEX_ROW}
         UNION ALL
         SELECT np.lease_id, -np.amount
           FROM payment_reversals pr JOIN payments op ON op.id = pr.payment_id JOIN payments np ON np.reversal_id = pr.id
          WHERE op.landlord_id = $1 AND op.type = 'deposit' AND op.deposit_collected_by IS DISTINCT FROM 'landlord'
            AND op.revenue_owner = 'landlord'
         UNION ALL
         SELECT sd.lease_id, sd.total_amount
           FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id
          WHERE l.landlord_id = $1 AND sd.flex_deposit_enabled IS TRUE AND sd.status <> 'voided'
            AND EXISTS (SELECT 1 FROM flex_deposit_installments f WHERE f.security_deposit_id = sd.id)) x
        WHERE NOT EXISTS (SELECT 1 FROM deposit_returns d WHERE d.lease_id = x.lease_id AND d.finalized_at IS NOT NULL)
        GROUP BY 1`, [id])
    const expected = new Map(r.rows.map(x => [x.k ?? '', cents(x.n)]))
    // Per lease not yet moved out: what posts there (deposit rows' receipts and
    // reversals, an installment deposit) resolves to its lease.
    const scope = await loadPendingScope(client, id)
    return compare('deposits_gam_holds', k => severityOf(scope.everything || scope.leases.has(k)), ledger, expected, ['leaseId'], 1)
  },
}

// ─── 1310 ───────────────────────────────────────────────────────────────────

export const homeNotesCheck: LedgerCheck = {
  name: 'home_notes_receivable',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const method = (await client.query<{ m: string | null }>(`SELECT books_home_sale_method AS m FROM landlords WHERE id = $1`, [id])).rows[0]?.m
    const ledger = await ledgerBy(client, id, ['home_notes_receivable'], ['unit_id', 'tenant_id'])
    const expected = new Map<string, number>()
    if (method === 'whole_sale_at_signing') {
      const r = await client.query<{ k: string; n: string }>(
        `SELECT concat_ws('|', c.unit_id::text, c.tenant_id::text) AS k,
                ${C(`sum(c.financed_amount - COALESCE((SELECT sum(i.principal_portion) FROM home_sale_installments i
                                                         WHERE i.contract_id = c.id
                                                           AND (i.settled_off_platform_at IS NOT NULL
                                                                OR EXISTS (SELECT 1 FROM payments p WHERE p.id = i.payment_id
                                                                             AND p.voided_at IS NULL AND p.status <> 'voided'))), 0))`)}::text AS n
           FROM home_sale_contracts c
          WHERE c.landlord_id = $1 AND c.activated_at IS NOT NULL AND c.cancelled_at IS NULL
          GROUP BY 1`, [id])
      for (const x of r.rows) expected.set(x.k ?? '', cents(x.n))
    }
    const sev: LedgerFindingSeverity = method ? await severityFor(client, id, TENANT_CHECK_RULES.homeNotes) : 'pending'
    return compare('home_notes_receivable', sev, ledger, expected, ['unitId', 'tenantId'], 1)
  },
}

// ─── 2015 (tenant refunds by check) ─────────────────────────────────────────

export const outstandingChecksCheck: LedgerCheck = {
  name: 'outstanding_checks',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    // 10/12 (Nic, ledger review): the whole of 2015 — tenant refund checks
    // (refund parts, D4), register refunds by check (F3) and GAM fee pulls
    // that succeeded (H5) — so nothing the books owe the bank sits there
    // untied. 10/12 (Nic, ledger P6): the bank line matched to one clears it
    // (bank_match), and an expense paid by check sits here until its bank line
    // pays it (expense_payment). 10/13 (Nic): a pull the landlord's bank
    // disputed is money coming back — its own posting debits 2015 by the
    // whole pull (ledgerProjectors/payoutGamCharges) — until the bank line of
    // the return clears it. The bank feed cannot match a return line to its
    // pull yet, so that debit stays, with no time limit, and this check cannot
    // tell a return still on its way from one filed some other way (as other
    // income, say: the money counted twice). 10/13 (Nic): a dispute GAM won
    // puts the money back — the pull's own posting takes its cancellation
    // back — so a won pull is a pull again.
    const ledger = await ledgerBy(client, id, ['outstanding_checks'], [])
    const r = await client.query<{ n: string }>(
      `SELECT (
         COALESCE((SELECT ${C('sum(rp.amount)')} FROM stay_refund_parts rp
                    WHERE rp.landlord_id = $1 AND rp.kind IN ('check', 'money_order') AND rp.reversed_at IS NULL
                      AND rp.status IN ('refunded', 'handed_back')), 0)
       + COALESCE((SELECT ${C('sum(pr.amount)')} FROM pos_refunds pr
                    WHERE pr.landlord_id = $1 AND pr.refund_method = 'check' AND pr.stay_refund_part_id IS NULL
                      AND pr.reversed_at IS NULL), 0)
       + COALESCE((SELECT ${C('sum(d.total_amount)')} FROM landlord_gam_debits d
                    WHERE d.landlord_id = $1 AND d.status = 'succeeded' AND d.settled_at IS NOT NULL), 0)
       -- 10/13 (Nic): a pull the landlord's bank disputed — the money coming back, until the bank line of the return clears it.
       - COALESCE((SELECT ${C('sum(d.total_amount)')} FROM landlord_gam_debits d
                    WHERE d.landlord_id = $1 AND d.status = 'succeeded' AND d.settled_at IS NOT NULL
                      AND d.disputed_at IS NOT NULL AND d.dispute_won_at IS NULL), 0)
       - COALESCE((SELECT ${C('sum(-bt.amount)')} FROM bank_transactions bt
                    WHERE bt.landlord_id = $1 AND bt.status = 'matched'
                      AND bt.matched_kind IN ('gam_debit', 'pos_refund', 'refund_part')), 0)
       + COALESCE((SELECT ${C('sum(xp.amount)')} FROM landlord_expense_payments xp
                    WHERE xp.landlord_id = $1 AND xp.method = 'check' AND xp.voided_at IS NULL
                      AND xp.bank_transaction_id IS NULL), 0))::text AS n`, [id])
    return compare('outstanding_checks', await severityFor(client, id, TENANT_CHECK_RULES.outstandingChecks), ledger,
      new Map([['', cents(r.rows[0]?.n)]]), [], -1)
  },
}

// ─── Settled rows explained ─────────────────────────────────────────────────

export const settledRowsCheck: LedgerCheck = {
  name: 'settled_rows_explained',
  async run(client, owner) {
    const id = landlordOf(owner)
    if (!id) return []
    const r = await client.query<{ id: string; amount_c: string; explained_c: string }>(
      `SELECT p.id::text, ${C('p.amount')}::text AS amount_c,
              ${C(`COALESCE((SELECT sum(ra.amount_applied) FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
                              WHERE ra.payment_id = p.id AND r.status = 'settled' AND r.undone_at IS NULL), 0)
                 + COALESCE((SELECT sum(cu.amount) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('applied', 'reversed')), 0)
                 + CASE WHEN p.manual_method = 'prior_arrangement'
                          OR (p.flexpay_advance_id IS NOT NULL AND p.manual_method IS NULL
                              AND NOT EXISTS (SELECT 1 FROM remittance_applications ra2 JOIN tenant_remittances r2 ON r2.id = ra2.remittance_id
                                               WHERE ra2.payment_id = p.id AND r2.status = 'settled' AND r2.undone_at IS NULL))
                        THEN p.amount - COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                                                    WHERE cu.payment_id = p.id AND cu.status IN ('applied', 'reversed')), 0)
                        ELSE 0 END`)}::text AS explained_c
         FROM payments p
        WHERE p.landlord_id = $1 AND p.status = 'settled' AND p.voided_at IS NULL AND p.revenue_owner = 'landlord'
          AND p.amount > 0 AND p.entry_description IS DISTINCT FROM 'FLEXPAY' AND NOT ${FLEX_ROW}
          AND NOT EXISTS (SELECT 1 FROM deposit_returns d WHERE d.refund_payment_id = p.id)`, [id])
    // The money records against themselves: pending only while the row itself
    // (or a receipt, credit or reversal on it) is still waiting to post.
    const scope = await loadPendingScope(client, id)
    return r.rows
      .filter(x => cents(x.explained_c) !== cents(x.amount_c))
      .map(x => ({ check: 'settled_rows_explained', severity: severityOf(scope.everything || scope.payments.has(x.id)),
        detail: { paymentId: x.id, amountCents: cents(x.amount_c), explainedCents: cents(x.explained_c) } }))
  },
}

/** Every tenant-money tie-out, in the order the nightly run reports them. */
export const TENANT_LEDGER_CHECKS: readonly LedgerCheck[] = [
  receivablesCheck,
  undepositedFundsCheck,
  depositsInTransitCheck,
  paidAheadCheck,
  depositsOwedCheck,
  depositsGamHoldsCheck,
  homeNotesCheck,
  outstandingChecksCheck,
  settledRowsCheck,
]

export function registerTenantLedgerChecks(): void {
  for (const c of TENANT_LEDGER_CHECKS) registerLedgerCheck(c)
}

export function unregisterTenantLedgerChecks(): void {
  for (const c of TENANT_LEDGER_CHECKS) unregisterLedgerCheck(c.name)
}
