/**
 * S652 — the real packet for Lot 1, to Blu.
 *
 * Nic: "send blu the packet now."
 *
 * Lot 1 is one of the eleven rent-to-own households, so the packet is three
 * documents and two kinds of signature: the lot lease, the installment contract
 * for the home, and the lead-based-paint addendum — the SALE version, because a
 * sale is what is happening here, and the federal rule makes that form
 * different from the one a renter signs.
 *
 * THE MONEY, per Nic: "the remaining balance of installments totaled against the
 * purchase price, because we have no data on what the actual purchase price was.
 * The purchase price for this contract is just going to be the remaining
 * balance. And then no down payments — again, that was something from a prior
 * contract. So this is just to separate the space rent from the installment
 * loan."
 *
 * Blu's sheet says $11,000 left over 55 months at $200 a month, and 55 × $200 is
 * exactly $11,000 — a flat plan at no interest, which is the shape the contract
 * already supports. Nothing here invents a sale price or a down payment that
 * nobody recorded.
 *
 * It replaces the lease-only document sent earlier today, which Blu has not
 * acted on. That one is deleted rather than voided for the same reason the
 * other twelve were: it was superseded before anybody signed anything, and a
 * voided row would sit in his history forever implying something happened.
 *
 * Run with --apply.
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord } from '../../routes/esign'
import { createHomeSaleContract } from '../../services/homeSale'
import { signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
import crypto from 'crypto'
import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const LOT = 'Lot 1'
const MONTHLY = 200, PAYMENTS = 55, START_MONTH = '2026-10-01'

async function main() {
  const prop = await queryOne<any>(
    `SELECT id, name, landlord_id, state FROM properties WHERE name ILIKE '%country acres%'`)
  const unit = await queryOne<any>(
    `SELECT id, unit_number FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`,
    [prop.id, LOT])

  const tpl = async (name: string) => {
    const t = await queryOne<any>(
      `SELECT id, name, base_pdf_url, purpose FROM lease_templates
        WHERE landlord_id=$1 AND name=$2 AND is_active=TRUE`, [prop.landlord_id, name])
    if (!t) throw new Error(`Template not found: ${name}`)
    return t
  }
  const lease = await tpl('Mattoon Lease, EX A and B')
  const contract = await tpl('Mattoon Installment Contract')
  const lbp = await tpl('Mattoon LBP - Sale')

  const residents = await query<any>(
    `SELECT u.id AS user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM users u WHERE u.role='tenant' AND u.last_name ILIKE 'Sheptock' ORDER BY 2`)
  const tenant = await queryOne<any>(
    `SELECT t.id FROM tenants t JOIN users u ON u.id=t.user_id WHERE u.id=$1`, [residents[0].user_id])
  const owner = await queryOne<any>(
    `SELECT l.user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [prop.landlord_id])

  // S652 — THE ADULTS WHO ARE NOT SIGNING ARE STILL ON THE LEASE.
  //
  // Nic, catching this a second time: "you didn't add john as authorized
  // occupant. why?" Because I built the packet from SIGNERS, and John Sheptock
  // has no email, so he is not one. That is the identical mistake as S651 —
  // an account needs a real address and GAM never invents one, which is true,
  // and says nothing at all about who lives there. Lot 1's sheet says "John
  // Sheptock / Nancy Sheptock"; Nancy holds the mailbox, so Nancy signs, and
  // John is a named resident with no account and no liability.
  //
  // Read off the sheet at packet time rather than patched in afterwards: a
  // document that is right when it is created cannot be sent before the patch
  // runs.
  const sheet: any[] = JSON.parse(fs.readFileSync(__dirname + '/lots.json', 'utf8'))
  const row = sheet.find((r) => String(r.lot) === LOT.replace(/\D/g, ''))
  const household: string[] = String(row?.tenant ?? '')
    .split(/\n/).map((n: string) => n.trim()).filter(Boolean)
  const signerNames = residents.map((r: any) => String(r.name).toLowerCase())
  const occupants = household.filter((n) => !signerNames.includes(n.toLowerCase()))

  const existing = await query<any>(
    `SELECT d.id FROM lease_documents d
      WHERE d.unit_id=$1 AND d.status NOT IN ('completed','voided')`, [unit.id])

  console.log(`${prop.name} · ${unit.unit_number} (${prop.state})`)
  console.log(`  replacing ${existing.length} unsigned document(s)`)
  console.log(`  lease     ${lease.name}`)
  console.log(`  contract  ${contract.name}  —  $${(MONTHLY * PAYMENTS).toLocaleString()} over ${PAYMENTS} months at $${MONTHLY}, no down payment`)
  console.log(`  addendum  ${lbp.name}`)
  console.log(`  signers   ${owner.name} (landlord), ${residents.map((r: any) => r.name).join(', ')}`)
  console.log(`  occupants ${occupants.join(', ') || '(none)'}  — named on the lease, not signing, not liable`)
  console.log(`  send to   ${owner.name} <${owner.email}> only`)
  if (!APPLY) { console.log('\n(dry run — nothing written)'); process.exit(0) }

  const signers = [
    { userId: owner.user_id, role: 'landlord', name: owner.name, email: owner.email, phone: owner.phone, orderIndex: 1 },
    ...residents.map((r: any, i: number) => ({
      userId: r.user_id, role: i === 0 ? 'primary' : `co_tenant_${i}`,
      name: r.name, email: r.email, phone: r.phone, orderIndex: i + 2,
    })),
  ]

  const client = await getClient()
  let leaseDocId = ''
  try {
    await client.query('BEGIN')
    if (existing.length) {
      await client.query(`DELETE FROM lease_documents WHERE id = ANY($1::uuid[])`,
        [existing.map((d: any) => d.id)])
    }

    const sale = await createHomeSaleContract(client, {
      unitId: unit.id, leaseId: null, tenantId: tenant.id, landlordId: prop.landlord_id,
      salePrice: MONTHLY * PAYMENTS, downPayment: 0, annualInterestRate: 0,
      termMonths: PAYMENTS, startMonth: START_MONTH, planType: 'flat', pendingSignature: true,
    })

    const groupId = crypto.randomUUID()
    const mk = (t: any, documentType: string, order: number, prefillValues: any = {}) =>
      createDocumentRecord(client, {
        landlordId: prop.landlord_id, templateId: t.id, unitId: unit.id, leaseId: null,
        title: order === 0
          ? `Lease — ${prop.name} ${unit.unit_number}`
          : `${t.name} — ${unit.unit_number}`,
        basePdfUrl: t.base_pdf_url, documentType,
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers, prefillValues,
        packageGroupId: groupId, packageId: null, packageSortOrder: order,
      } as any)

    const leaseDoc = await mk(lease, 'original_lease', 0,
      occupants.length ? { occupant_names: occupants.join(', ') } : {})
    leaseDocId = leaseDoc.id
    const saleDoc = await mk(contract, 'purchase_agreement', 1, {
      sale_price:               (MONTHLY * PAYMENTS).toFixed(2),
      sale_down_payment:        '0.00',
      sale_financed_amount:     Number(sale.financed_amount).toFixed(2),
      sale_monthly_payment:     Number(sale.monthly_payment).toFixed(2),
      sale_term_months:         String(PAYMENTS),
      sale_interest_rate:       '0',
      sale_first_payment_month: START_MONTH,
    })
    await mk(lbp, 'addendum_terms', 2)
    await client.query(
      `UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`,
      [sale.id, saleDoc.id])
    await client.query('COMMIT')
    console.log(`\npacket ${groupId}`)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  // Proof before the mail goes: the tenant fields exist this time.
  const f = await query<any>(
    `SELECT lease_column, count(*) AS n FROM lease_document_fields
      WHERE document_id=$1 AND lease_column IN ('tenant_name','tenant_initial','date_signed')
      GROUP BY 1 ORDER BY 1`, [leaseDocId])
  console.log('  lease tenant fields:', f.map((x: any) => `${x.lease_column}×${x.n}`).join(', ') || 'NONE')

  // The lease is the way in; the signing screen walks him through the siblings.
  const first = await queryOne<any>(
    `SELECT s.*, u.email_verified, u.tenant_invite_token
       FROM lease_document_signers s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.document_id=$1 ORDER BY s.order_index LIMIT 1`, [leaseDocId])
  if (first.role !== 'landlord') throw new Error(`First signer is ${first.role} — stopping.`)

  await emailSigningRequest(
    first.email, first.name, `Lease — ${prop.name} ${unit.unit_number}`,
    `${prop.name} ${unit.unit_number}`, owner.name,
    signingUrlFor(first, leaseDocId, first),
    { landlordId: prop.landlord_id, documentId: leaseDocId })
  await query(
    `UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW()
      WHERE package_group_id=(SELECT package_group_id FROM lease_documents WHERE id=$1)`,
    [leaseDocId])
  await query(`UPDATE lease_document_signers SET status='sent' WHERE id=$1`, [first.id])
  console.log(`\nsent to ${first.name} <${first.email}>`)
  process.exit(0)
}
main().catch((e) => { console.error(e.message || e); process.exit(1) })
