/**
 * THE OPEN BILLS OF A PERSON — ONE DEFINITION (10/27).
 *
 * Lifted out of `GET /api/balances/:tenantId/invoices` (S634) unchanged, so
 * that the bill a landlord reads on screen and the bill they hand a resident
 * on paper are built by the same words. The alternative was a second copy of
 * this query for the print sheet, which is how two bills for the same month
 * end up disagreeing about a late fee.
 *
 * Everything below — which charges count as owed, how credit is shown, what a
 * line is called — is the S634/S655/10-6 contract. The reasoning lives with
 * each piece; do not simplify a comment away.
 */
import { query } from '../db'
import { openBalanceSql, openAmountSql } from './openBalances'
import { chargeLabelColumnsSql, chargeLabel, chargeDetail } from './invoiceNotice'

/** The group a charge on no invoice is shown under (a counter charge, a carried balance). */
export const NOT_ON_A_BILL = 'Not on a bill'

export interface OpenBillLine {
  id: string
  type: string
  entry_description: string | null
  amount: string | number
  status: string
  due_date: string
  notes: string | null
  /** What it is, in plain words: "Water", "Late fee" — never a generic "Utilities". */
  label: string
  /** The meter read or the period behind it; null when there is nothing to add. */
  detail: string | null
  open: boolean
  credit_applied: number
  /** Money (not credit) that paid it. */
  paid: number
}

export interface OpenBill {
  id: string
  invoice_number: string
  due_date: string
  status: string
  unit_number_then?: string | null
  unit_number?: string | null
  property_name?: string | null
  amount_paid: number
  credit_applied: number
  balance: number
  total_amount: number
  lines: OpenBillLine[]
  [k: string]: unknown
}

export interface OpenBillsResult {
  bills: OpenBill[]
  /** bill id → the lease it bills (null for a charge on no lease). Not in the wire shape. */
  leaseOf: Map<string, string | null>
  /** bill id → the resident the invoice names. Not in the wire shape. */
  tenantOf: Map<string, string | null>
}

/**
 * Every open bill of these residents, with its lines.
 *
 * A bill is here when one of its charges is still owed (openBalanceSql), and
 * its balance is what those charges still owe — late fees included, which the
 * invoice's own total never carried. Charges on no invoice are one more group,
 * NOT_ON_A_BILL.
 *
 * `groupLooseBy` decides how charges with no invoice are grouped: 'tenant'
 * (one group across the lot, which is what GET /balances/:tenantId/invoices
 * has always returned) or 'lease' (one group per lease, so a print sheet puts
 * each household's loose charges on that household's page).
 */
export async function openBillsFor(opts: {
  tenantIds: readonly string[]
  landlordIds: readonly string[]
  /** null = every property; otherwise the properties this viewer may see. */
  scopedPropertyIds: string[] | null
  /** S641: work-trade lines and figures only for a viewer who may see them. */
  seesWorkTrade: boolean
  groupLooseBy?: 'tenant' | 'lease'
}): Promise<OpenBillsResult> {
  const empty: OpenBillsResult = { bills: [], leaseOf: new Map(), tenantOf: new Map() }
  if (opts.tenantIds.length === 0) return empty

  // Every charge of these people's with these companies, on a bill that still
  // has something owed (or owed itself with no bill).
  const lines = await query<any>(`
    WITH mine AS (
      SELECT p.*, inv.tenant_id AS inv_tenant_id, inv.lease_id AS inv_lease_id
        FROM payments p
        LEFT JOIN invoices inv ON inv.id = p.invoice_id
        LEFT JOIN units u ON u.id = p.unit_id
       WHERE COALESCE(p.tenant_id, inv.tenant_id) = ANY($1::uuid[])
         AND p.landlord_id = ANY($2::uuid[])
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
         -- GAM's FlexPay pull is the tenant's arrangement with GAM: it never
         -- appears anywhere a landlord or their staff can see (CLAUDE.md).
         AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
         -- 10/12 (Nic, G9): a voided line (owed by nobody, kept as a record)
         -- is not one of the bill's lines here; it stays on file and in the
         -- full history.
         AND p.status <> 'voided'
    ),
    open_bills AS (
      SELECT DISTINCT m.invoice_id FROM mine m
       WHERE m.invoice_id IS NOT NULL AND ${openBalanceSql('m')} AND ${openAmountSql('m')} > 0
    )
    SELECT m.invoice_id, m.id, m.type, m.entry_description, m.amount, m.status,
           to_char(m.due_date, 'YYYY-MM-DD') AS due_date, m.notes,
           COALESCE(m.lease_id, m.inv_lease_id) AS owner_lease_id,
           (m.work_trade_suspended_at IS NOT NULL) AS work_trade,
           ${openBalanceSql('m')} AS open,
           CASE WHEN ${openBalanceSql('m')} THEN ${openAmountSql('m')} ELSE 0 END AS open_amount,
           -- 10/6 (Nic): credit already applied to the line (whole or part).
           (SELECT COALESCE(SUM(cu.amount), 0) FROM credit_uses cu
             WHERE cu.payment_id = m.id AND cu.status = 'applied') AS credit_applied,
           ${chargeLabelColumnsSql('m')}
      FROM mine m
     WHERE m.invoice_id IN (SELECT invoice_id FROM open_bills)
        OR (m.invoice_id IS NULL AND ${openBalanceSql('m')} AND ${openAmountSql('m')} > 0)
     ORDER BY m.due_date ASC, m.type ASC, m.created_at ASC`,
    [opts.tenantIds as string[], opts.landlordIds as string[], opts.scopedPropertyIds])
  if (lines.length === 0) return empty

  const invoiceIds = [...new Set(lines.map((l: any) => l.invoice_id).filter(Boolean))]
  const invoices = invoiceIds.length === 0 ? [] : await query<any>(`
    SELECT i.id, i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.status,
           -- S641 (Nic): "when somebody goes on their history from last year
           -- that it shows that they were in that spot at that time." An
           -- invoice renders the number the space carried on its own due
           -- date, not whatever it was renamed to since.
           unit_number_on(i.unit_id, i.due_date) AS unit_number_then,
           i.subtotal_rent, i.subtotal_fees, i.subtotal_utilities,
           i.subtotal_deposits, i.subtotal_late_fees,
           i.work_trade_credit_amount,
           u.unit_number, pr.name AS property_name,
           i.lease_id AS _lease_id, i.tenant_id AS _tenant_id
      FROM invoices i
      LEFT JOIN units u       ON u.id  = i.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
     WHERE i.id = ANY($1::uuid[])
     ORDER BY i.due_date ASC, i.invoice_number ASC`, [invoiceIds])

  // 10/6 (Nic): "Credits need to not settle by line item. It needs to be a
  // credit against the entire balance." A line is shown at what it is; the
  // credit on the bill is ONE figure under the lines (credit_applied), and
  // money paid is another (amount_paid) — never a line marked "covered by
  // prepaid credit … collected by the landlord" (the raw note is not the
  // line's words: label and detail are, payment tags stripped).
  // Money that came in on it: settled, still clearing, or taken from the deposit.
  const paidOf = (l: any) => (!l.work_trade && ['settled', 'processing', 'paid_via_deposit'].includes(l.status)) ? Number(l.amount) : 0
  // Of that, what money paid (credit applied to a paid line is not money paid).
  const moneyPaidOf = (l: any) => paidOf(l) > 0 ? Math.max(0, paidOf(l) - Number(l.credit_applied ?? 0)) : 0
  // Credit applied to the line, whether the line is paid or still open in part.
  const creditOf = (l: any) => l.work_trade ? 0 : Number(l.credit_applied ?? 0)
  const shape = (l: any): OpenBillLine => ({
    id: l.id, type: l.type, entry_description: l.entry_description,
    amount: l.amount, status: l.status, due_date: l.due_date, notes: l.notes,
    label: chargeLabel(l), detail: chargeDetail(l),
    open: l.open === true,
    credit_applied: Number(l.credit_applied ?? 0),
    paid: Math.round(moneyPaidOf(l) * 100) / 100,
  })
  const visible = (l: any) => opts.seesWorkTrade || !l.work_trade
  const money = (xs: any[], f: (l: any) => number) =>
    Math.round(xs.reduce((s, l) => s + Math.round(f(l) * 100), 0)) / 100

  const leaseOf = new Map<string, string | null>()
  const tenantOf = new Map<string, string | null>()
  const bills: OpenBill[] = invoices.map((i: any) => {
    const mine = lines.filter((l: any) => l.invoice_id === i.id)
    const balance = money(mine, l => Number(l.open_amount))
    const amountPaid = money(mine, moneyPaidOf)
    const creditApplied = money(mine, creditOf)
    const { _lease_id, _tenant_id, ...wire } = i
    leaseOf.set(i.id, _lease_id ?? mine.find((l: any) => l.owner_lease_id)?.owner_lease_id ?? null)
    tenantOf.set(i.id, _tenant_id ?? null)
    const row: any = {
      ...wire,
      // Money paid on it (cash, check, card, bank) — never the credit.
      amount_paid: amountPaid,
      // 10/6 (Nic): the credit applied against this bill, as one figure.
      credit_applied: creditApplied,
      balance,
      // What this bill comes to now: what was paid on it, the credit applied,
      // and what it still owes (late fees included, which the invoice's own
      // total never was).
      total_amount: Math.round((amountPaid + creditApplied + balance) * 100) / 100,
      lines: mine.filter(visible).map(shape),
    }
    if (!opts.seesWorkTrade) {
      delete row.work_trade_credit_amount
      delete row.work_trade_credit_hours
    }
    return row as OpenBill
  })

  // Charges on no invoice. One group across the lot for a single person's own
  // page ('tenant'), or one per lease for a print run ('lease').
  const loose = lines.filter((l: any) => !l.invoice_id)
  if (loose.length) {
    const byKey = new Map<string, any[]>()
    for (const l of loose) {
      const key = opts.groupLooseBy === 'lease' ? String(l.owner_lease_id ?? 'no-lease') : 'all'
      const bucket = byKey.get(key); bucket ? bucket.push(l) : byKey.set(key, [l])
    }
    for (const [key, group] of byKey) {
      const balance = money(group, l => Number(l.open_amount))
      const id = key === 'all' ? 'not-on-a-bill' : `not-on-a-bill:${key}`
      leaseOf.set(id, key === 'all' ? (group.find((l: any) => l.owner_lease_id)?.owner_lease_id ?? null)
                                    : (key === 'no-lease' ? null : key))
      tenantOf.set(id, group.find((l: any) => l.tenant_id)?.tenant_id ?? null)
      bills.push({
        id,
        invoice_number: NOT_ON_A_BILL,
        due_date: group[0].due_date,
        status: 'pending',
        unit_number_then: null, unit_number: null, property_name: null,
        amount_paid: money(group, moneyPaidOf), credit_applied: money(group, creditOf), balance,
        total_amount: Math.round((money(group, moneyPaidOf) + money(group, creditOf) + balance) * 100) / 100,
        lines: group.filter(visible).map(shape),
      })
    }
  }

  return { bills, leaseOf, tenantOf }
}
