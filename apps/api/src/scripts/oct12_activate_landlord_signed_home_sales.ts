/**
 * 10/12 (Nic) — run once at the deploy that makes the LANDLORD's signature
 * start a home sale billing.
 *
 *   "We need people to be billed correctly regardless of signing status."
 *
 * Under the old code a sale waited for the buyer's signature, so a contract
 * whose installment contract only the landlord had signed sat at
 * 'pending_signature' with no schedule and billed nothing — Country Acres MH 18
 * and MH 24 (landlord signed 9/22), whose October bills went out without the
 * home payment. Every such contract is started now exactly as the landlord's
 * signature starts one from today (services/homeSale activateHomeSaleContractIn):
 *   - the schedule is written and the contract made active;
 *   - months before the property's first billing cycle are stamped as paid
 *     outside GAM (never billed);
 *   - each installment already due goes on the buyer's open bill for its
 *     month. A paid bill never grows a line; with no open bill the monthly run
 *     bills it.
 * A buyer who belongs to another company waits for their own signature
 * (S655), as on a live signature. A sale whose agreement carries typed terms
 * that are not the sale on file is left waiting, never billed on numbers
 * nobody signed (services/homeSale startLandlordSignedSaleIn — the same steps
 * the daily home-sale run now retries every morning).
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back,
 * so what it prints is what --apply would do. --apply commits, then lets money
 * the buyer paid ahead go on the balance (the 10/6 whole-balance rule).
 *   cd apps/api && npx ts-node -T src/scripts/oct12_activate_landlord_signed_home_sales.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct12_activate_landlord_signed_home_sales.ts --apply
 */
import type { PoolClient } from 'pg'
import { landlordSignedSalesWaiting, startLandlordSignedSaleIn, type AttachedInstallment } from '../services/homeSale'

export interface StartedSale {
  contractId: string
  documentId: string
  property: string
  unit: string
  installmentsCreated: number
  stampedOffPlatform: number
  attached: Array<AttachedInstallment & { invoiceNumber: string | null }>
  household: { tenantId: string; landlordId: string }
}

export interface StartReport {
  started: StartedSale[]
  skipped: Array<{ contractId: string; property: string; unit: string; why: string }>
}

/**
 * Start every landlord-signed sale still waiting, on `client` (the caller
 * commits or rolls back). 10/12: the finding and the starting are
 * services/homeSale's (landlordSignedSalesWaiting, startLandlordSignedSaleIn),
 * the same steps the daily home-sale run retries every morning; this adds the
 * savepoint per sale and the report.
 */
export async function activateLandlordSignedHomeSales(client: PoolClient): Promise<StartReport> {
  const out: StartReport = { started: [], skipped: [] }
  const waiting = await landlordSignedSalesWaiting(client)

  for (const w of waiting) {
    await client.query('SAVEPOINT start_sale')
    try {
      const r = await startLandlordSignedSaleIn(client, w)
      await client.query('RELEASE SAVEPOINT start_sale')
      if (!('started' in r)) {
        out.skipped.push({ contractId: w.contract_id, property: w.property, unit: w.unit, why: r.why })
        continue
      }
      const s = r.started
      const numbers = new Map<string, string | null>()
      for (const a of s.attached) {
        if (!numbers.has(a.invoiceId)) {
          numbers.set(a.invoiceId, (await client.query<{ invoice_number: string | null }>(
            `SELECT invoice_number FROM invoices WHERE id = $1`, [a.invoiceId])).rows[0]?.invoice_number ?? null)
        }
      }
      out.started.push({
        contractId: s.contractId, documentId: w.document_id, property: w.property, unit: w.unit,
        installmentsCreated: s.installmentsCreated, stampedOffPlatform: s.stampedOffPlatform,
        attached: s.attached.map(a => ({ ...a, invoiceNumber: numbers.get(a.invoiceId) ?? null })),
        household: { tenantId: w.tenant_id, landlordId: w.landlord_id },
      })
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT start_sale')
      out.skipped.push({ contractId: w.contract_id, property: w.property, unit: w.unit,
        why: `could not start: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return out
}

export function printStartReport(r: StartReport, log: (s: string) => void = console.log): void {
  log(`${r.started.length} sale(s) started, ${r.skipped.length} skipped.`)
  for (const s of r.started) {
    log(`  ${s.property} ${s.unit} (contract ${s.contractId}): ${s.installmentsCreated} installments written, ` +
        `${s.stampedOffPlatform} stamped as paid outside GAM`)
    if (s.attached.length === 0) log(`      nothing due on an open bill — the monthly run bills the next one in its month`)
    for (const a of s.attached) {
      log(`      home payment ${a.installmentNumber} $${a.amount.toFixed(2)} → bill ${a.invoiceNumber ?? '(no number)'} ` +
          `due ${a.dueDate} (${a.invoiceId})`)
    }
  }
  for (const s of r.skipped) log(`  SKIPPED ${s.property} ${s.unit} (contract ${s.contractId}): ${s.why}`)
}

if (require.main === module) {
  ;(async () => {
    const apply = process.argv.includes('--apply')
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    let report: StartReport | null = null
    try {
      await c.query('BEGIN')
      report = await activateLandlordSignedHomeSales(c)
      printStartReport(report)
      if (apply) { await c.query('COMMIT'); console.log('COMMITTED') }
      else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. --apply to commit.') }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      console.error(e instanceof Error ? e.message : e)
      code = 1
      report = null
    } finally {
      c.release()
    }
    if (apply && report) {
      const { runWholeBillCheckAfterCommit } = await import('../services/creditUse')
      for (const s of report.started) {
        if (s.attached.length) await runWholeBillCheckAfterCommit(s.household)
      }
    }
    process.exit(code)
  })()
}
