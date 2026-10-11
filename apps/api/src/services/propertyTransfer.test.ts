// S605 (Nic, selling Oak Park): transfer the account, not the money.
//
// "It's more about just transferring ownership of the property account and the
// record of deposits and leases and stuff like that."
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { transferProperty, initiateTransfer, approveTransfer, declineTransfer, acceptTransfer, confirmTransfer, listIncomingTransfers } from './propertyTransfer'
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

  // The tenancy continues unchanged — a buyer honors the remaining term, and
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

  // S655: a sale to another account names the buyer's LOGIN; the buyer
  // accepts with their own code before anything moves.
  const initiate = (f: any) => initiateTransfer({
    propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
    toUserId: f.buyer.userId, byUserId: f.seller.userId,
  })
  const buyerCode = async (requestId: string) =>
    (await db.query<any>(`SELECT buyer_code FROM property_transfer_requests WHERE id=$1`, [requestId])).rows[0].buyer_code
  const buyerAccepts = async (f: any, requestId: string) =>
    acceptTransfer({ requestId, userId: f.buyer.userId, code: await buyerCode(requestId) })

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
    await buyerAccepts(f, requestId)   // the buyer is ready; the sellers are not

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
    await buyerAccepts(f, requestId)
    const res = await approveTransfer({
      requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.required).toBe(1)
    expect(res.executed).toBe(true)
  })

  // ── S655: the receiving side consents too ──────────────────────────────────
  it('every seller confirmed but the buyer silent: nothing moves', async () => {
    const f = await seedSale()
    const { requestId, awaitingBuyer } = await initiate(f)
    expect(awaitingBuyer).toBe(true)
    const res = await approveTransfer({
      requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.executed).toBe(false)
    expect(res.awaitingBuyer).toBe(true)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.seller.landlordId)
    const { rows: [r] } = await db.query<any>(`SELECT status, to_landlord_id FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.status).toBe('pending')
    expect(r.to_landlord_id).toBeNull()   // the receiving company is the buyer's choice
  })

  it('the buyer accepts with the right code into their own company, and that executes the sale', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    const res = await confirmTransfer({ requestId, userId: f.buyer.userId, code: await buyerCode(requestId) })
    expect(res.side).toBe('buyer')
    expect(res.executed).toBe(true)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(f.buyer.landlordId)
    const { rows: [r] } = await db.query<any>(
      `SELECT status, to_landlord_id, buyer_accepted_by FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.status).toBe('executed')
    expect(r.to_landlord_id).toBe(f.buyer.landlordId)
    expect(r.buyer_accepted_by).toBe(f.buyer.userId)
  })

  it('either order works: the buyer first, then the last seller executes it', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    const accepted = await buyerAccepts(f, requestId)
    expect(accepted.executed).toBe(false)
    const res = await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.executed).toBe(true)
  })

  it('refuses a wrong buyer code, a stranger, and the selling company named as the receiver', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    await expect(acceptTransfer({ requestId, userId: f.buyer.userId, code: '000000' }))
      .rejects.toThrow(/not correct/i)
    const c = await db.connect()
    let stranger: any
    try { stranger = await seedLandlord(c) } finally { c.release() }
    await expect(acceptTransfer({ requestId, userId: stranger.userId, code: await buyerCode(requestId) }))
      .rejects.toThrow(/not addressed to you/i)
    // The buyer is ALSO an owner of the selling company — they still cannot
    // name it as the receiver.
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [f.seller.landlordId, f.buyer.userId])
    await expect(acceptTransfer({ requestId, userId: f.buyer.userId, code: await buyerCode(requestId),
      receivingLandlordId: f.seller.landlordId })).rejects.toThrow(/one transferring it/i)
    // ...nor a company that is not theirs.
    await expect(acceptTransfer({ requestId, userId: f.buyer.userId, code: await buyerCode(requestId),
      receivingLandlordId: stranger.landlordId })).rejects.toThrow(/not yours/i)
    const { rows: [r] } = await db.query<any>(`SELECT buyer_accepted_at FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.buyer_accepted_at).toBeNull()
  })

  it('a buyer with several companies must choose which one takes it', async () => {
    const f = await seedSale()
    const { rows: [second] } = await db.query<any>(
      `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [f.buyer.userId])
    const { requestId } = await initiate(f)
    await expect(buyerAccepts(f, requestId)).rejects.toThrow(/Choose which of your companies/i)
    await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    const res = await acceptTransfer({ requestId, userId: f.buyer.userId, code: await buyerCode(requestId),
      receivingLandlordId: second.id })
    expect(res.executed).toBe(true)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(second.id)
  })

  it('the buyer can decline, which cancels the request', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    await declineTransfer(requestId, f.buyer.userId)
    const { rows: [r] } = await db.query<any>(
      `SELECT status, cancelled_by FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.status).toBe('cancelled')
    expect(r.cancelled_by).toBe(f.buyer.userId)
    await expect(approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) }))
      .rejects.toThrow(/already called off/i)
  })

  // A decline that lands while the other side's confirmation is executing the
  // sale must not report success: it read the row unlocked and updated
  // "WHERE status='pending'" without checking anything matched, so the seller
  // was told "declined, nothing moved" over a property that had moved.
  it('a decline racing the sale waits for it and is refused once the property has moved', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })

    // Stand in for the buyer's acceptance mid-flight: hold the request row
    // the way acceptTransfer does while it moves the property.
    const holder = await db.connect()
    let declined: Promise<void> | null = null
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM property_transfer_requests WHERE id = $1 FOR UPDATE`, [requestId])
      declined = declineTransfer(requestId, f.seller.userId)
      const settled = declined.then(() => 'ok', () => 'err')
      // Wait until the decline is actually blocked on the row lock.
      const deadline = Date.now() + 5000
      for (;;) {
        const { rows: [w] } = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        if (Number(w.n) > 0) break
        if (Date.now() > deadline) throw new Error('decline never waited on the lock')
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(await Promise.race([settled, new Promise((r) => setTimeout(() => r('pending'), 50))])).toBe('pending')
      await holder.query(
        `UPDATE property_transfer_requests SET status = 'executed', executed_at = now() WHERE id = $1`, [requestId])
      await holder.query('COMMIT')
    } catch (e) {
      await holder.query('ROLLBACK').catch(() => {})
      throw e
    } finally { holder.release() }

    await expect(declined!).rejects.toThrow(/already went through/i)
    const { rows: [r] } = await db.query<any>(
      `SELECT status, cancelled_by FROM property_transfer_requests WHERE id=$1`, [requestId])
    expect(r.status).toBe('executed')
    expect(r.cancelled_by).toBeNull()
    const { rows: [a] } = await db.query<any>(
      `SELECT declined_at FROM property_transfer_approvals WHERE request_id=$1 AND user_id=$2`,
      [requestId, f.seller.userId])
    expect(a.declined_at).toBeNull()
  })

  it('a buyer accepting and a seller declining at the same moment never both succeed', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    const code = await buyerCode(requestId)
    const [acc, dec] = await Promise.allSettled([
      acceptTransfer({ requestId, userId: f.buyer.userId, code }),
      declineTransfer(requestId, f.seller.userId),
    ])
    expect([acc.status, dec.status].filter((s) => s === 'fulfilled')).toHaveLength(1)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    const { rows: [r] } = await db.query<any>(`SELECT status FROM property_transfer_requests WHERE id=$1`, [requestId])
    if (dec.status === 'fulfilled') {
      expect(r.status).toBe('cancelled')
      expect(p.landlord_id).toBe(f.seller.landlordId)
    } else {
      expect(r.status).toBe('executed')
      expect(p.landlord_id).toBe(f.buyer.landlordId)
    }
  })

  it('a move between two companies of the same account needs no buyer step', async () => {
    const f = await seedSale()
    const { rows: [mine] } = await db.query<any>(
      `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [f.seller.userId])
    const { requestId, awaitingBuyer } = await initiateTransfer({
      propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
      toLandlordId: mine.id, byUserId: f.seller.userId,
    })
    expect(awaitingBuyer).toBe(false)
    const res = await approveTransfer({ requestId, userId: f.seller.userId, code: await codeFor(requestId, f.seller.userId) })
    expect(res.executed).toBe(true)
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [f.propertyId])
    expect(p.landlord_id).toBe(mine.id)
  })

  it('a company the initiator does not own cannot be named as the receiver', async () => {
    const f = await seedSale()
    await expect(initiateTransfer({
      propertyId: f.propertyId, fromLandlordId: f.seller.landlordId,
      toLandlordId: f.buyer.landlordId, byUserId: f.seller.userId,
    })).rejects.toThrow(/company you own/i)
  })

  it('a company with no member row can still raise a sale — its founding login confirms', async () => {
    const f = await seedSale()   // no landlord_members row at all
    const { requestId, approversNotified } = await initiate(f)
    expect(approversNotified).toBe(1)
    const { rows } = await db.query<any>(`SELECT user_id FROM property_transfer_approvals WHERE request_id=$1`, [requestId])
    expect(rows.map((r: any) => r.user_id)).toEqual([f.seller.userId])
  })

  it('the buyer sees the incoming transfer — property and counts, no tenant names, no codes', async () => {
    const f = await seedSale()
    const { requestId } = await initiate(f)
    const rows = await listIncomingTransfers(f.buyer.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(requestId)
    expect(rows[0].unit_count).toBe(1)
    expect(rows[0].active_lease_count).toBe(1)
    expect(rows[0].seller_required).toBe(1)
    const flat = JSON.stringify(rows)
    expect(flat).not.toMatch(/buyer_code|"code"/)
    expect(await listIncomingTransfers(f.seller.userId)).toHaveLength(0)
  })
})
