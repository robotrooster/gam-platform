/**
 * S648 (Nic): page 8's fee boxes start from the property's fee list, for the
 * unit's KIND — and at $0 for an existing resident being onboarded.
 *
 *   "We want the boxes to be pre-filled in on page eight. Correctly have them
 *    at zero for onboarding tenants."
 *   "A pet deposit on an apartment is gonna only apply to apartments. A pet
 *    deposit is not really gonna apply to RVs because the tenants own those."
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { createDocumentRecord } from '../routes/esign'

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

const TAGS = ['pet_deposit', 'utility_deposit', 'move_in_fee', 'pet_rent', 'other_fee']

async function seed(unitType: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET unit_type=$2 WHERE id=$1`, [unitId, unitType])
    const tenantId = await seedTenant(c)
    const tpl = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, unit_type, is_unit_type_default, base_pdf_url, is_active)
       VALUES ($1,'Lease',$2,TRUE,'/uploads/lease.pdf',TRUE) RETURNING id`, [landlordId, unitType])
    for (const [i, tag] of TAGS.entries()) {
      await c.query(
        `INSERT INTO lease_template_fields
           (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
         VALUES ($1,'text','landlord',$2,$2,8,10,$3,80,14,FALSE)`, [tpl.rows[0].id, tag, 20 * i + 20])
    }
    // The property's list: apartments carry pet and utility deposits, a move-in
    // fee and pet rent; RV spots carry a different pet deposit.
    await c.query(
      `INSERT INTO property_fee_schedules (property_id, unit_type, fee_type, amount, is_refundable, due_timing) VALUES
         ($1,'apartment','pet_deposit',350,TRUE,'move_in'),
         ($1,'apartment','utility_deposit',100,TRUE,'move_in'),
         ($1,'apartment','move_in_fee',50,FALSE,'move_in'),
         ($1,'apartment','pet_rent',25,FALSE,'monthly_ongoing'),
         ($1,'apartment','other_fee',10,FALSE,'other'),
         ($1,'rv_spot','pet_deposit',75,TRUE,'move_in')`, [propertyId])
    await c.query('COMMIT')
    const t = await db.query<any>(
      `SELECT u.id AS user_id, u.email FROM tenants t JOIN users u ON u.id=t.user_id WHERE t.id=$1`, [tenantId])
    return { userId, landlordId, propertyId, unitId, tenantId, templateId: tpl.rows[0].id,
             tenantUserId: t.rows[0].user_id, tenantEmail: t.rows[0].email }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function draft(f: Awaited<ReturnType<typeof seed>>) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: f.landlordId, templateId: f.templateId, unitId: f.unitId, leaseId: null,
      title: 'Lease', basePdfUrl: null, documentType: 'original_lease' as any,
      targetLeaseTenantId: null, promoteLeaseTenantId: null,
      signers: [
        { userId: f.userId, role: 'landlord', name: 'LL', email: 'll@mailer-test.co', orderIndex: 1 },
        { userId: f.tenantUserId, role: 'primary', name: 'Jane Renter', email: f.tenantEmail, orderIndex: 2 },
      ],
    })
    await client.query('COMMIT')
    const rows = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND page=8`, [doc.id])
    return Object.fromEntries(rows.rows.map(r => [r.lease_column, r.value]))
  } finally { client.release() }
}

describe('page 8 fee boxes', () => {
  it('a new apartment tenant starts with the apartment fees', async () => {
    const f = await seed('apartment')
    expect(await draft(f)).toEqual({
      pet_deposit: '350.00',
      utility_deposit: '100.00',
      move_in_fee: '50.00',
      pet_rent: '25.00',
      // several "other" fees can exist; the lease's one box is left to the landlord
      other_fee: null,
    })
  })

  it('an RV spot gets the RV list, never the apartment one', async () => {
    const f = await seed('rv_spot')
    expect(await draft(f)).toEqual({
      pet_deposit: '75.00', utility_deposit: null, move_in_fee: null, pet_rent: null, other_fee: null,
    })
  })

  it('an existing resident being onboarded starts every move-in fee at $0', async () => {
    const f = await seed('apartment')
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy)
       VALUES ($1,$2,$3,$4,TRUE)`, [f.landlordId, f.tenantId, f.unitId, f.propertyId])
    expect(await draft(f)).toEqual({
      pet_deposit: '0.00',
      utility_deposit: '0.00',
      move_in_fee: '0.00',
      // a monthly price for new residents says nothing about what they pay now
      pet_rent: null,
      other_fee: null,
    })
  })
})
