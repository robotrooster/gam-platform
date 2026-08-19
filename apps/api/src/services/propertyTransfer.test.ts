// S605 (Nic, selling Oak Park): transfer the account, not the money.
//
// "It's more about just transferring ownership of the property account and the
// record of deposits and leases and stuff like that."
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { transferProperty, initiateTransfer, approveTransfer, declineTransfer } from './propertyTransfer'
import { vi } from 'vitest'

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

async function seedSale() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const seller = await seedLandlord(c)
    const buyer  = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: seller.landlordId, ownerUserId: seller.userId, managedByUserId: seller.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: seller.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: seller.landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `INSERT INTO parts_inventory (landlord_id, name, quantity, property_id)
       VALUES ($1,'Zero-turn mower',1,$2)`, [seller.landlordId, propertyId])
    await c.query('COMMIT')
    return { seller, buyer, propertyId, unitId, leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const doTransfer = (f: any) => transferProperty({
  propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
  toLandlordId: f.buyer.landlordId, byUserId: f.seller.userId,
})

describe('transferProperty', () => {
  it('moves the property, its units, leases and equipment to the buyer', async () => {
    const f = await seedSale()
    const res = await doTransfer(f)
    expect(res.transferId).toBeTruthy()

    const { rows: [p] } = await db.query<any>(
      `SELECT landlord_id, owner_user_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.buyer.landlordId)
    expect(p.owner_user_id).toBe(f.buyer.userId)

    const { rows: [u] } = await db.query<any>(`SELECT landlord_id FROM units WHERE id=$1`, [f.unitId])
    expect(u.landlord_id).toBe(f.buyer.landlordId)

    const { rows: [l] } = await db.query<any>(`SELECT landlord_id FROM leases WHERE id=$1`, [f.leaseId])
    expect(l.landlord_id).toBe(f.buyer.landlordId)

    const { rows: [eq] } = await db.query<any>(
      `SELECT landlord_id FROM parts_inventory WHERE name='Zero-turn mower'`)
    expect(eq.landlord_id).toBe(f.buyer.landlordId)
  })

  // The tenancy continues unchanged — a buyer honours the remaining term, and
  // re-papering a sitting tenant's lease at a sale would alarm them for nothing.
  it('leaves the lease TERMS and the tenant untouched', async () => {
    const f = await seedSale()
    const { rows: [before] } = await db.query<any>(
      `SELECT rent_amount, start_date, end_date, status FROM leases WHERE id=$1`, [f.leaseId])
    await doTransfer(f)
    const { rows: [after] } = await db.query<any>(
      `SELECT rent_amount, start_date, end_date, status FROM leases WHERE id=$1`, [f.leaseId])
    expect(after).toEqual(before)
    const { rows: lt } = await db.query<any>(
      `SELECT tenant_id FROM lease_tenants WHERE lease_id=$1`, [f.leaseId])
    expect(lt[0].tenant_id).toBe(f.tenantId)
  })

  // THE LINE THAT MATTERS: settled money stays with whoever actually received
  // it. Re-pointing history would rewrite the seller's books for a period they
  // owned the property.
  it('does NOT move settled financial history', async () => {
    const f = await seedSale()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',500,'settled','2026-08-01','RENT')`,
      [f.unitId, f.leaseId, f.tenantId, f.seller.landlordId])

    await doTransfer(f)

    const { rows: [pay] } = await db.query<any>(
      `SELECT landlord_id FROM payments WHERE lease_id=$1`, [f.leaseId])
    expect(pay.landlord_id).toBe(f.seller.landlordId)   // still the seller's income
  })

  it('records an audit row with what moved', async () => {
    const f = await seedSale()
    const res = await doTransfer(f)
    const { rows: [t] } = await db.query<any>(
      `SELECT from_landlord_id, to_landlord_id, moved FROM property_transfers WHERE id=$1`,
      [res.transferId])
    expect(t.from_landlord_id).toBe(f.seller.landlordId)
    expect(t.to_landlord_id).toBe(f.buyer.landlordId)
    expect(t.moved.units).toBeGreaterThan(0)
    expect(t.moved.leases).toBeGreaterThan(0)
  })

  it('refuses when the property is not the seller’s', async () => {
    const f = await seedSale()
    await expect(transferProperty({
      propertyId: f.propertyId, fromLandlordId: f.buyer.landlordId,
      toLandlordId: f.seller.landlordId, byUserId: f.buyer.userId,
    })).rejects.toThrow(/does not belong/i)
  })

  it('refuses a transfer to the same account', async () => {
    const f = await seedSale()
    await expect(transferProperty({
      propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
      toLandlordId: f.seller.landlordId, byUserId: f.seller.userId,
    })).rejects.toThrow(/already belongs/i)
  })

  // Rent routes to the buyer the moment this lands, so a buyer who can't take
  // payouts yet is worth saying out loud — but not worth blocking a closing over.
  it('warns when the buyer cannot yet receive payouts', async () => {
    const f = await seedSale()
    await db.query(`UPDATE users SET connect_payouts_enabled = FALSE WHERE id = $1`, [f.buyer.userId])
    const res = await doTransfer(f)
    expect(res.warning).toMatch(/payouts/i)
  })

  // The seller's designated signer has no authority at a property they sold.
  it('clears the seller’s designated lease signer', async () => {
    const f = await seedSale()
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`,
      [f.propertyId, f.seller.userId])
    await doTransfer(f)
    const { rows: [p] } = await db.query<any>(
      `SELECT lease_signer_user_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.lease_signer_user_id).toBeNull()
  })
})


// ── S605 (Nic): every owner must confirm ───────────────────────────────────
// "So that one person can't just accidentally sell or transfer account
// ownership out from underneath other people."
describe('transfer consent', () => {
  // Give the selling entity a SECOND owner — the partnership case.
  async function withPartner(f: any) {
    const { rows: [u2] } = await db.query<any>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('partner@mailer-test.co','x','landlord','Pat','Partner') RETURNING id`)
    await db.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, u2.id])
    return u2.id
  }
  const codeFor = async (requestId: string, userId: string) =>
    (await db.query<any>(
      `SELECT code FROM property_transfer_approvals WHERE request_id=$1 AND user_id=$2`,
      [requestId, userId])).rows[0].code

  const initiate = (f: any) => initiateTransfer({
    propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
    toLandlordId: f.buyer.landlordId, byUserId: f.seller.userId,
  })

  it('raising a request moves NOTHING', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    await initiate(f)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.seller.landlordId)   // still the seller's
  })

  it('one owner of two cannot complete the sale alone', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    const partnerId = await withPartner(f)
    const { requestId } = await initiate(f)

    const res = await approveTransfer({
      requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.executed).toBe(false)
    expect(res.required).toBe(2)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.seller.landlordId)   // untouched

    // The partner's approval is what completes it.
    const done = await approveTransfer({
      requestId, userId: partnerId, code: await codeFor(requestId, partnerId) })
    expect(done.executed).toBe(true)
    const { rows: [after] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(after.landlord_id).toBe(f.buyer.landlordId)
  })

  it('a wrong code does not count as approval', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    const { requestId } = await initiate(f)
    await expect(approveTransfer({ requestId, userId: f.seller.userId, code: '000000' }))
      .rejects.toThrow(/not correct/i)
  })

  it('someone who is not an owner cannot approve', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    const { requestId } = await initiate(f)
    await expect(approveTransfer({ requestId, userId: f.buyer.userId, code: '123456' }))
      .rejects.toThrow(/not an owner/i)
  })

  it('a single decline kills the sale', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    const partnerId = await withPartner(f)
    const { requestId } = await initiate(f)
    await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })

    await declineTransfer(requestId, partnerId)
    const { rows: [r] } = await db.query<any>(
      `SELECT status FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.status).toBe('cancelled')
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.seller.landlordId)   // never moved
  })

  it('only one pending request per property', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    await initiate(f)
    await expect(initiate(f)).rejects.toThrow(/already awaiting approval/i)
  })

  // Adding an owner mid-flight must not change what the sale needs.
  it('the approver set is frozen when the request is raised', async () => {
    const f = await seedSale()
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.seller.userId])
    const { requestId } = await initiate(f)
    await withPartner(f)     // joins AFTER the request
    const res = await approveTransfer({
      requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.required).toBe(1)
    expect(res.executed).toBe(true)
  })
})
