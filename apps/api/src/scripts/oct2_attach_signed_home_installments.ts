/**
 * S654 (2026-10-02) — run once at the deploy that ships
 * attachDueInstallmentsToOpenInvoices.
 *
 * Nic (Shane Rueff, Country Acres MH 11): "if he signs today and the bill was
 * generated yesterday, that $150 needs to go on this month's bill as well
 * after he signs." A purchase agreement signed BEFORE this deploy activated
 * its contract under the old code, which leaves the installment already due
 * for the next monthly run. This puts it on the open bill for its month.
 *
 * Idempotent (an installment bills once). Paid bills are never grown.
 * DRY=1 (the default) prints what would be attached and changes nothing:
 *   DRY=1 node -r ts-node/register src/scripts/oct2_attach_signed_home_installments.ts
 *   DRY=0 node -r ts-node/register src/scripts/oct2_attach_signed_home_installments.ts
 */
import { query } from '../db'
import { attachDueInstallmentsToOpenInvoices } from '../services/homeSale'

async function main() {
  const dryRun = process.env.DRY !== '0'
  const contracts = await query<{ id: string; unit_number: string; property: string }>(
    `SELECT c.id, u.unit_number, p.name AS property
       FROM home_sale_contracts c JOIN units u ON u.id = c.unit_id JOIN properties p ON p.id = u.property_id
      WHERE c.status = 'active' AND c.lease_id IS NOT NULL
      ORDER BY p.name, u.unit_number`)
  let total = 0
  for (const c of contracts) {
    const { attached } = await attachDueInstallmentsToOpenInvoices(c.id, { dryRun })
    for (const a of attached) {
      total++
      console.log(`${dryRun ? 'WOULD ATTACH' : 'ATTACHED'} ${c.property} ${c.unit_number}: home payment ${a.installmentNumber} $${a.amount.toFixed(2)} → bill due ${a.dueDate} (${a.invoiceId})`)
    }
  }
  console.log(`${dryRun ? 'DRY RUN — nothing changed.' : 'Done.'} ${total} installment(s) across ${contracts.length} active contract(s).`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
