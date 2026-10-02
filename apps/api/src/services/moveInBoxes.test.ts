/**
 * S654: page 8 on a renewal. The build bills only what a refundable box rises
 * above the deposit the old lease already holds (S534's top-up rule), so page 8's
 * deposit line and total say the same — the page and the bill agree.
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
    const oldLeaseId = await seedLease(c, { unitId, landlordId, status: 'active', startDate: '2025-06-15' })
    await seedLeaseTenant(c, { leaseId: oldLeaseId, tenantId })
    // The old lease holds a $500 security deposit and a $300 pet deposit.
    await c.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing) VALUES
         ($1, 'security_deposit', 500, TRUE, 'move_in'),
         ($1, 'pet_deposit',      300, TRUE, 'move_in')`, [oldLeaseId])
    const tpl = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name) VALUES ($1, 'Lease') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    return { landlordId, unitId, oldLeaseId, templateId: tpl.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function doc(s: Awaited<ReturnType<typeof seed>>, renews: boolean, values: Record<string, string>) {
  const d = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, template_id, renews_lease_id)
     VALUES ($1, $2, 'Lease', 'original_lease', $3, $4) RETURNING id`,
    [s.landlordId, s.unitId, s.templateId, renews ? s.oldLeaseId : null])
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

describe('S654 page 8 on a renewal shows only what is billed', () => {
  it('the carried deposits bill nothing; a fee bills in full', async () => {
    const s = await seed()
    expect(await doc(s, true, { security_deposit: '500', pet_deposit: '300', pet_fee: '75.00' })).toEqual({
      move_in_security_deposit: '0.00', move_in_total_due: '75.00',
    })
  })

  it('a raised deposit shows and bills only the top-up', async () => {
    const s = await seed()
    expect(await doc(s, true, { security_deposit: '650.00', pet_deposit: '300', pet_fee: '75.00' })).toEqual({
      move_in_security_deposit: '150.00', move_in_total_due: '225.00',
    })
  })

  it('a lowered deposit is never below $0', async () => {
    const s = await seed()
    expect(await doc(s, true, { security_deposit: '400.00', pet_deposit: '250.00' })).toEqual({
      move_in_security_deposit: '0.00', move_in_total_due: '0.00',
    })
  })

  it('a box the template tags as a fee bills in full, as the build does', async () => {
    const s = await seed()
    await db.query(
      `INSERT INTO lease_template_fields
         (template_id, field_type, signer_role, lease_column, page, x, y, width, height, required, money_kind)
       VALUES ($1, 'text', 'landlord', 'pet_deposit', 1, 10, 10, 80, 14, FALSE, 'fee')`, [s.templateId])
    expect(await doc(s, true, { security_deposit: '500', pet_deposit: '300' })).toEqual({
      move_in_security_deposit: '0.00', move_in_total_due: '300.00',
    })
  })

  it('a new tenancy still bills every box in full', async () => {
    const s = await seed()
    expect(await doc(s, false, { security_deposit: '650.00', pet_deposit: '300', pet_fee: '75.00' })).toEqual({
      move_in_security_deposit: '650.00', move_in_total_due: '1025.00',
    })
  })
})
