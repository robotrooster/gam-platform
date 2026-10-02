/**
 * Page 8 restamp. A new tenancy: the deposit line copies page 2 and the total
 * adds every move-in box in full. A renewal (Nic's rule — "people get billed on
 * their due date according to how the landlord sets the property"): no rent on
 * page 8, the deposit line is only the increase over what the old lease holds,
 * and the total is the one-time bill the renewal actually sends.
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
    return { landlordId, unitId, templateId: tpl.rows[0].id, oldLeaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function newTenancyDoc(s: Awaited<ReturnType<typeof seed>>, values: Record<string, string>,
  renewsLeaseId: string | null = null, columns = ['move_in_security_deposit', 'move_in_total_due']) {
  const d = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, template_id, renews_lease_id)
     VALUES ($1, $2, 'Lease', 'original_lease', $3, $4) RETURNING id`,
    [s.landlordId, s.unitId, s.templateId, renewsLeaseId])
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
      WHERE document_id = $1 AND lease_column = ANY($2)`, [d.rows[0].id, columns])
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

describe('page 8 on a renewal says what the renewal bills', () => {
  const ALL = ['move_in_first_month_rent', 'move_in_proration', 'move_in_security_deposit', 'move_in_total_due']

  it('no rent, and the deposit already held is not owed again', async () => {
    const s = await seed()
    expect(await newTenancyDoc(s, {
      security_deposit: '500.00', pet_deposit: '300', move_in_first_month_rent: '1050.00', move_in_proration: '533.33',
    }, s.oldLeaseId, ALL)).toEqual({
      move_in_first_month_rent: '0.00', move_in_proration: '0.00',
      move_in_security_deposit: '0.00', move_in_total_due: '0.00',
    })
  })

  it('a deposit increase bills only the difference; a fee typed on the form bills in full', async () => {
    const s = await seed()
    expect(await newTenancyDoc(s, {
      security_deposit: '600.00', pet_deposit: '350', pet_fee: '75.00',
    }, s.oldLeaseId, ALL)).toEqual({
      move_in_first_month_rent: '0.00', move_in_proration: '0.00',
      // $100 over the $500 held; the pet deposit's $50 over $300 is in the total.
      move_in_security_deposit: '100.00', move_in_total_due: '225.00',
    })
  })

  it('a lower deposit is never a negative charge', async () => {
    const s = await seed()
    expect(await newTenancyDoc(s, { security_deposit: '400.00' }, s.oldLeaseId, ALL)).toMatchObject({
      move_in_security_deposit: '0.00', move_in_total_due: '0.00',
    })
  })

  it('the landlord\'s signature over a renewal\'s rent line does not keep a rent figure on page 8', async () => {
    const s = await seed()
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, template_id, renews_lease_id)
       VALUES ($1, $2, 'Lease', 'original_lease', $3, $4) RETURNING id`,
      [s.landlordId, s.unitId, s.templateId, s.oldLeaseId])
    for (const [col, value] of Object.entries({ security_deposit: '500.00', move_in_first_month_rent: '1050.00',
      move_in_proration: '0.00', move_in_security_deposit: '', move_in_total_due: '' })) {
      await db.query(
        `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required, signed_at)
         VALUES ($1, 'text', 'landlord', $2, $3, FALSE, NOW())`, [d.rows[0].id, col, value])
    }
    await restampMoveInBoxes(db as any, d.rows[0].id)
    const r = await db.query<{ value: string }>(
      `SELECT value FROM lease_document_fields WHERE document_id=$1 AND lease_column='move_in_first_month_rent'`, [d.rows[0].id])
    expect(r.rows[0].value).toBe('0.00')
  })
})
