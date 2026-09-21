/**
 * S652 — a sale nobody signed ends with its paper.
 *
 * Found clearing Lot 1 at Country Acres: voiding an unsigned installment
 * agreement left its sale at 'pending_signature' forever, and one live sale per
 * unit meant the unit could never be drafted again. The fix is a trigger, so
 * these tests void three different ways and expect the same result from each.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { voidDocument } from './voidDocument'

let f: { landlordId: string; unitId: string; tenantId: string }

beforeEach(async () => {
  await cleanupAllSchema()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, state: 'IL' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, unitType: 'mobile_home' })
    const tenantId = await seedTenant(client)
    await client.query('COMMIT')
    f = { landlordId: ll.landlordId, unitId, tenantId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
})

async function agreementWithSale(status: 'pending_signature' | 'active' = 'pending_signature') {
  const d = await query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Installment contract','purchase_agreement','sent') RETURNING *`,
    [f.landlordId, f.unitId])
  const h = await query<{ id: string }>(
    `INSERT INTO home_sale_contracts
       (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, status,
        installments_total, purchase_document_id)
     VALUES ($1,$2,$3,11000,0,11000,0,55,200,'2026-11-01',$4,55,$5) RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId, status, d[0].id])
  return { doc: d[0] as any, saleId: h[0].id }
}
const saleStatus = async (id: string) =>
  (await query<{ status: string }>(`SELECT status FROM home_sale_contracts WHERE id=$1`, [id]))[0].status

describe('voiding an unsigned installment agreement', () => {
  it('cancels the sale it was for — through the void button\'s own steps', async () => {
    const { doc, saleId } = await agreementWithSale()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await voidDocument(client.query.bind(client) as any, doc, 'redrafting')
      await client.query('COMMIT')
    } finally { client.release() }
    expect(await saleStatus(saleId)).toBe('cancelled')
  })

  it('cancels it however the void happens — the 48-hour timeout writes the status directly', async () => {
    // The scheduler's timeout path never calls voidDocument. The trigger is
    // what makes it right anyway.
    const { doc, saleId } = await agreementWithSale()
    await query(`UPDATE lease_documents SET status='voided', voided_at=now() WHERE id=$1`, [doc.id])
    expect(await saleStatus(saleId)).toBe('cancelled')
  })

  it('frees the unit to be drafted again — the thing that was actually broken', async () => {
    const first = await agreementWithSale()
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [first.doc.id])
    // One live sale per unit: before the fix this second draft was refused.
    const second = await agreementWithSale()
    expect(await saleStatus(second.saleId)).toBe('pending_signature')
  })

  it('never touches a sale somebody signed for', async () => {
    const { doc, saleId } = await agreementWithSale('active')
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [doc.id])
    expect(await saleStatus(saleId)).toBe('active')
  })

  it('leaves a sale on some OTHER document alone', async () => {
    const { saleId } = await agreementWithSale()
    const other = await query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Lot lease','original_lease','sent') RETURNING id`, [f.landlordId, f.unitId])
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [other[0].id])
    expect(await saleStatus(saleId)).toBe('pending_signature')
  })
})
