/**
 * Page 8 restamp for a new tenancy: the deposit line copies page 2 and the
 * total adds every move-in box in full. (S654: renewal page 8 is back to its
 * e32bdc1 behavior until Nic sets the renewal billing rule.)
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { restampMoveInBoxes } from './moveInBoxes'

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    // A prior lease on the unit that held deposits; a new tenancy owes its own.
    const oldLeaseId = await seedLease(c, { unitId, landlordId, status: 'active', startDate: '2025-06-15' })
    await seedLeaseTenant(c, { leaseId: oldLeaseId, tenantId })
    await c.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing) VALUES
         ($1, 'security_deposit', 500, TRUE, 'move_in'),
         ($1, 'pet_deposit',      300, TRUE, 'move_in')`, [oldLeaseId])
    const tpl = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name) VALUES ($1, 'Lease') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    return { landlordId, unitId, templateId: tpl.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function newTenancyDoc(s: Awaited<ReturnType<typeof seed>>, values: Record<string, string>) {
  const d = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, template_id)
     VALUES ($1, $2, 'Lease', 'original_lease', $3) RETURNING id`,
    [s.landlordId, s.unitId, s.templateId])
  const all = {
    move_in_first_month_rent: '0.00', move_in_proration: '0.00',
    move_in_security_deposit: '', move_in_total_due: '', ...values,
  }
  for (const [col, value] of Object.entries(all)) {
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1, 'text', 'landlord', $2, $3, FALSE)`, [d.rows[0].id, col, value])
  }
  await restampMoveInBoxes(db as any, d.rows[0].id)
  const { rows } = await db.query<{ lease_column: string; value: string }>(
    `SELECT lease_column, value FROM lease_document_fields
      WHERE document_id = $1 AND lease_column IN ('move_in_security_deposit', 'move_in_total_due')`, [d.rows[0].id])
  return Object.fromEntries(rows.map(r => [r.lease_column, r.value]))
}

describe('page 8 on a new tenancy', () => {
  it('bills every box in full', async () => {
    const s = await seed()
    expect(await newTenancyDoc(s, { security_deposit: '650.00', pet_deposit: '300', pet_fee: '75.00' })).toEqual({
      move_in_security_deposit: '650.00', move_in_total_due: '1025.00',
    })
  })
})
