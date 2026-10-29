/**
 * 10/14 (Nic) — one-time: take October late fees off three Mountain View
 * residents as if they had never been charged (deleted, not credited).
 *
 *   Selene Arvizu, RV 39: "she was already charged a late fee on the bill that
 *     she paid off platform, so this would be kind of double charging her. So
 *     just remove late fees until the credit on her that I applied
 *     automatically matches down to the penny her bill." Her $840.24 credit
 *     (the Square payment) is $15.20 more than October without fees ($825.04),
 *     so the first three days' fees ($15) stay and the other eleven go (Nic
 *     chose that); the credit then pays the whole bill, 20 cents left over.
 *   Valentin Flores, MH 22, and Michael Moreno, RV 42: every October late fee
 *     goes, and October adds no more (Nic: "Delete, and no more for Oct").
 *
 * Each fee is deleted the way services/lateFeeDelete deletes one: the full row
 * kept in audit_log under LATE_FEE_DELETED_ACTION (so the late-fee engine
 * treats that day as already charged and never charges it again), then the
 * row removed (the payments triggers roll up the bill and capture the ledger
 * change). Each October bill is marked late_fee_exempt so the engine adds
 * nothing more to it. Selene's bill is then settled from her credit by the
 * whole-bill rule, with no receipt email.
 *
 *   npx ts-node -T src/scripts/oct14_waive_late_fees.ts           (dry run: rolled back)
 *   npx ts-node -T src/scripts/oct14_waive_late_fees.ts --apply
 */
import { getClient } from '../db'
import { LATE_FEE_DELETED_ACTION } from '../services/lateFeeDelete'
import { reRateMarksWithoutLateFee } from '../services/creditLedgerEmitters'
import { lockHousehold } from '../services/moneyPredicates'
import { settleWholeBillIfCovered } from '../services/creditUse'

const APPLY = process.argv.includes('--apply')
const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'
const NIC = '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3'

interface Target { who: string; unit: string; tenantId: string; keepFirst: number; settleFromCredit: boolean }
const TARGETS: Target[] = [
  { who: 'Selene Arvizu', unit: 'RV 39', tenantId: '2c434fef-5597-45f4-a389-c138144c3667', keepFirst: 3, settleFromCredit: true },
  { who: 'Valentin Flores', unit: 'MH 22', tenantId: '617e5f64-3ca0-4310-9436-170969dda9e6', keepFirst: 0, settleFromCredit: false },
  { who: 'Michael Moreno', unit: 'RV 42', tenantId: 'b56cf928-b0a8-4230-9381-77127058634b', keepFirst: 0, settleFromCredit: false },
]

const MONEY_ON_IT = `
  SELECT EXISTS (SELECT 1 FROM credit_uses WHERE payment_id = $1 AND status <> 'released')
      OR EXISTS (SELECT 1 FROM remittance_applications WHERE payment_id = $1)
      OR EXISTS (SELECT 1 FROM bank_deposit_allocations WHERE payment_id = $1)
      OR EXISTS (SELECT 1 FROM bank_transactions WHERE matched_payment_id = $1)
      OR EXISTS (SELECT 1 FROM payment_reversals WHERE payment_id = $1) AS x`

async function main() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const t of TARGETS) {
      await lockHousehold(client, t.tenantId, MOUNTAIN_VIEW)
      const fees = (await client.query<{ id: string; invoice_id: string; due_date: string; amount: string; status: string; spi: string | null; row: Record<string, unknown> }>(
        `SELECT p.id, p.invoice_id, p.due_date::text AS due_date, p.amount::text AS amount, p.status,
                p.stripe_payment_intent_id AS spi, to_jsonb(p) AS row
           FROM payments p JOIN units u ON u.id = p.unit_id
          WHERE p.tenant_id = $1 AND p.landlord_id = $2 AND u.unit_number = $3 AND p.type = 'late_fee'
            AND p.status <> 'voided' AND p.due_date BETWEEN '2026-10-01' AND '2026-10-31'
          ORDER BY p.due_date, p.id FOR UPDATE OF p`, [t.tenantId, MOUNTAIN_VIEW, t.unit])).rows
      const invoices = [...new Set(fees.map(f => f.invoice_id))]
      if (invoices.length !== 1) throw new Error(`${t.who}: expected one October bill, found ${invoices.length}`)
      const go = fees.slice(t.keepFirst)
      for (const f of go) {
        if (f.status !== 'pending' || f.spi || Number(f.amount) <= 0) throw new Error(`${t.who}: fee ${f.id} is ${f.status}; not a plain unpaid fee`)
        if ((await client.query<{ x: boolean }>(MONEY_ON_IT, [f.id])).rows[0].x) throw new Error(`${t.who}: money is recorded against fee ${f.id}`)
        await client.query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
           VALUES ($1, $2, 'invoice', $3, $4::jsonb, $5::jsonb)`,
          [NIC, LATE_FEE_DELETED_ACTION, f.invoice_id, JSON.stringify(f.row),
           JSON.stringify({ paymentId: f.id, via: 'owner_directed', deletedAt: new Date().toISOString(), kind: 'waived_by_owner',
             note: '10/14 (Nic): late fee removed as if never charged' })])
        const d = await client.query(`DELETE FROM payments WHERE id = $1`, [f.id])
        if (d.rowCount !== 1) throw new Error(`fee ${f.id} could not be deleted`)
      }
      await client.query(`UPDATE invoices SET late_fee_exempt = true WHERE id = $1`, [invoices[0]])
      if (t.keepFirst === 0) await reRateMarksWithoutLateFee(client, invoices[0])
      const kept = fees.slice(0, t.keepFirst)
      console.log(`${t.who} (${t.unit}): deleted ${go.length} late fees ($${go.reduce((s, f) => s + Number(f.amount), 0).toFixed(2)}), kept ${kept.length}` +
        (kept.length ? ` (${kept.map(f => f.due_date).join(', ')})` : '') + '; no more October late fees')
      if (t.settleFromCredit) {
        const r = await settleWholeBillIfCovered(client, { tenantId: t.tenantId, landlordId: MOUNTAIN_VIEW, source: 'whole_bill', receipt: false, alerts: false })
        const used = r.leases.reduce((s, l) => s + l.creditUsed, 0)
        console.log(`  credit applied: $${used.toFixed(2)} across ${r.settledIds.length} charges`)
      }
      const owed = (await client.query<{ n: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS n FROM payments WHERE invoice_id = $1 AND status IN ('pending', 'failed')`, [invoices[0]])).rows[0].n
      const credit = (await client.query<{ n: string }>(
        `SELECT COALESCE(SUM(amount_remaining), 0)::text AS n FROM tenant_credits WHERE tenant_id = $1 AND landlord_id = $2 AND status = 'active'`,
        [t.tenantId, MOUNTAIN_VIEW])).rows[0].n
      console.log(`  October still owed: $${Number(owed).toFixed(2)}; credit left: $${Number(credit).toFixed(2)}`)
    }
    if (APPLY) { await client.query('COMMIT'); console.log('APPLIED') }
    else { await client.query('ROLLBACK'); console.log('DRY RUN — nothing written (pass --apply)') }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
