/**
 * 10/28 — RECOVER ONE TAKEOVER'S INSTALLMENT CONTRACT.
 *
 * The landlord signed the installment contract in his takeover packet at 12:54
 * and got a critical alert: "Installment contract signed but its terms did not
 * record — This unit already has an active home-sale contract." The guard that
 * keeps two purchases off one home was counting the contract this paper exists
 * to retire. Fixed in createHomeSaleContract (it now excludes the contract the
 * document supersedes); this script is the recovery for the one document that
 * hit it before the fix shipped.
 *
 * The signature is NOT re-done and nothing is signed here: the paper is already
 * signed and valid. What is missing is the record his signature was supposed to
 * write, so this calls the same service his signature calls —
 * applySaleTermsFromDocument — and nothing else. The morning retry cannot do it
 * (landlordSignedSalesWaiting starts from contracts that exist, and this one
 * was never created).
 *
 * The buyer has not signed yet, so the contract is written pending_signature
 * and bills nothing. Their signature is what starts it and retires the old one
 * (startTakeoverContractAndRetireTheOld) — unchanged by this script.
 *
 * Scoped to ONE document id, and it refuses to touch anything else.
 */
import { db } from '../db'
import { applySaleTermsFromDocument } from '../services/homeSale'

const DOCUMENT_ID = '35707858-08c5-47ab-9b72-78cb5ba5f3a9'

async function main() {
  const dbName = (await db.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
  console.log(`database: ${dbName}`)

  const doc = (await db.query<any>(
    `SELECT d.id, d.document_type, d.status, d.unit_id, d.landlord_id,
            d.supersedes_home_sale_contract_id AS supersedes,
            (SELECT count(*)::int FROM lease_document_signers s
              WHERE s.document_id = d.id AND s.role <> 'witness' AND s.signed_at IS NOT NULL) AS signed,
            (SELECT count(*)::int FROM home_sale_contracts c WHERE c.purchase_document_id = d.id) AS already
       FROM lease_documents d WHERE d.id = $1`, [DOCUMENT_ID])).rows[0]

  if (!doc) throw new Error('that document does not exist here')
  if (doc.document_type !== 'purchase_agreement') throw new Error(`not an installment contract: ${doc.document_type}`)
  if (!doc.supersedes) throw new Error('this document does not name a purchase to take over — not the case this recovers')
  if (doc.status === 'voided') throw new Error('that document was voided — nothing to record')
  if (doc.already > 0) { console.log('a contract already exists for this document — nothing to do'); return }
  if (doc.signed < 1) throw new Error('nobody has signed it, so there are no terms to record')

  console.log(`document ${doc.id}: ${doc.status}, ${doc.signed} signature(s), takes over ${doc.supersedes}`)
  const out = await applySaleTermsFromDocument(DOCUMENT_ID)
  const c = (await db.query<any>(
    `SELECT id, status, round(sale_price::numeric,2) AS price, round(monthly_payment::numeric,2) AS monthly,
            installments_total, to_char(start_month,'YYYY-MM-DD') AS start_month
       FROM home_sale_contracts WHERE id = $1`, [out.contractId])).rows[0]
  console.log('recorded:', JSON.stringify(c))

  const onUnit = (await db.query<any>(
    `SELECT id, status FROM home_sale_contracts WHERE unit_id = $1 ORDER BY created_at`, [doc.unit_id])).rows
  console.log('contracts on that space now:', JSON.stringify(onUnit))
  console.log('the old one keeps billing until the buyer signs; their signature starts this one and retires it.')
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1) })
