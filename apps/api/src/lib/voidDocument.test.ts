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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { voidDocument } from './voidDocument'
import { lockLeaseHousehold } from './unwindIssuedLease'
import { householdLockKey } from '../services/moneyPredicates'

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

// S655 lock order: household, then the document, then its rows — the order the
// scheduler's 15-minute cancel and its hold take. The manual void used to write
// lease_tenants rows before the unwind locked the household, so a manual void
// and the scheduler on the same document could deadlock.
describe('the void takes the household lock first, as the scheduler does', () => {
  async function addendumAdd() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId })
      const joiner = await seedTenant(client)
      const doc = (await client.query(
        `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
         VALUES ($1,$2,$3,'Add a tenant','addendum_add','sent') RETURNING *`,
        [f.landlordId, f.unitId, leaseId])).rows[0]
      await client.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, add_document_id)
         VALUES ($1,$2,'co_tenant','pending_add',$3)`, [leaseId, joiner, doc.id])
      await client.query('COMMIT')
      return { doc, leaseId }
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  const HELD = `SELECT EXISTS (
      SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
         AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
         AND objid   = (hashtextextended($1, 0) & 4294967295)::oid) AS held`

  it('holds the household lock before it writes any lease_tenants row', async () => {
    const { doc } = await addendumAdd()
    const key = householdLockKey(f.tenantId, f.landlordId)
    const client = await db.connect()
    const heldAtCascade: boolean[] = []
    try {
      await client.query('BEGIN')
      const q = async (sql: string, params?: any[]) => {
        if (/UPDATE\s+lease_tenants/i.test(sql)) {
          heldAtCascade.push((await client.query(HELD, [key])).rows[0].held)
        }
        return client.query(sql, params)
      }
      await voidDocument(q as any, doc, 'redrafting')
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    expect(heldAtCascade).toEqual([true])
    const rows = await query<{ status: string }>(
      `SELECT status FROM lease_tenants WHERE add_document_id = $1`, [doc.id])
    expect(rows.map(r => r.status)).toEqual(['void'])
  })

  it('runs cleanly inside a transaction that already took the scheduler order (household, then document)', async () => {
    const { doc, leaseId } = await addendumAdd()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await lockLeaseHousehold(client.query.bind(client) as any, leaseId)
      const live = (await client.query(
        `SELECT * FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
      await voidDocument(client.query.bind(client) as any, live, 'canceled')
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    const d = await query<{ status: string }>(`SELECT status FROM lease_documents WHERE id = $1`, [doc.id])
    expect(d[0].status).toBe('voided')
  })

  it('refuses on the live row: a copy read before a tenant signed is not voided', async () => {
    const { doc } = await addendumAdd()
    await query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, signed_at)
       SELECT $1, t.user_id, 'tenant', 'pat@example.com', 'Pat', gen_random_uuid()::text, 'signed', now()
         FROM tenants t WHERE t.id = $2`, [doc.id, f.tenantId])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'redrafting'))
        .rejects.toThrow('Cannot void after a tenant has signed')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('refuses a document already voided since the caller read it', async () => {
    const { doc } = await addendumAdd()
    await query(`UPDATE lease_documents SET status = 'voided' WHERE id = $1`, [doc.id])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'again'))
        .rejects.toThrow('Document is already voided')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})
