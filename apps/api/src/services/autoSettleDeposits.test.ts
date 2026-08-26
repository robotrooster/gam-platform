/**
 * S624 — the zero-touch path, and the guards that keep it narrow.
 *
 * This is the ONLY place GAM settles a tenant's rent with nobody in the loop, so
 * what it REFUSES matters more than what it accepts. It overrides the S570
 * design lock ("landlord always confirms") on the strength of two independent
 * signals agreeing — a tenant's declaration and a bank row — neither of which is
 * the landlord's guess. Anything less than that must fall back to a shortlist.
 *
 * The failure this prevents is specific and bad: in a park where every lot pays
 * the same rent, settling on amount alone books one tenant's money onto
 * another's ledger and then onto their credit file.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { autoSettleDeclaredDeposits } from './bankFeed'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Park {
  landlordId: string; connectionId: string; propertyId: string
  lots: Array<{ tenantId: string; leaseId: string; unitId: string; rentId: string }>
}

/** A park where every lot pays the same rent — the hard case, by design. */
async function buildPark(lots: number, rent = 250): Promise<Park> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status)
       VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0]

    const out: Park['lots'] = []
    for (let i = 0; i < lots; i++) {
      const tenantId = await seedTenant(client)
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: rent })
      await client.query(`UPDATE units SET unit_number=$2 WHERE id=$1`,
        [unitId, `Lot ${i + 1}`])
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: rent })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      const rentId = (await client.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending',CURRENT_DATE,'RENT') RETURNING id`,
        [unitId, leaseId, tenantId, landlordId, rent.toFixed(2)])).rows[0].id
      out.push({ tenantId, leaseId, unitId, rentId })
    }
    return { landlordId, connectionId: conn.id, propertyId, lots: out }
  } finally { client.release() }
}

async function deposit(p: Park, amount: number, description: string) {
  return (await db.query(
    `INSERT INTO bank_transactions
       (bank_connection_id, landlord_id, external_id, posted_date, amount,
        description, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,'needs_review') RETURNING id`,
    [p.connectionId, p.landlordId, randomUUID(), amount.toFixed(2), description])).rows[0].id
}

async function declareFor(p: Park, i: number, amount: number, method = 'cash') {
  const lot = p.lots[i]
  return (await db.query(
    `INSERT INTO tenant_declared_deposits
       (tenant_id, lease_id, landlord_id, amount, declared_date, method)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING id`,
    [lot.tenantId, lot.leaseId, p.landlordId, amount.toFixed(2), method])).rows[0].id
}

const rentStatus = async (id: string) => (await db.query(
  `SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status

describe('two independent signals settle without a human', () => {
  it('settles the declaring tenant, and only them, in an identical-rent park', async () => {
    const p = await buildPark(25)
    await declareFor(p, 6, 250)
    await deposit(p, 250, 'ATM CASH DEPOSIT')

    const n = await autoSettleDeclaredDeposits(p.landlordId)
    expect(n).toBe(1)
    expect(await rentStatus(p.lots[6].rentId)).toBe('settled')
    // Every other lot is untouched — this is the whole safety property.
    for (const [i, lot] of p.lots.entries()) {
      if (i === 6) continue
      expect(await rentStatus(lot.rentId)).toBe('pending')
    }
  })

  it('marks the declaration confirmed and the bank row matched', async () => {
    const p = await buildPark(3)
    const dId = await declareFor(p, 0, 250)
    const tId = await deposit(p, 250, 'ATM CASH DEPOSIT')
    await autoSettleDeclaredDeposits(p.landlordId)

    const d = (await db.query(
      `SELECT status, bank_transaction_id FROM tenant_declared_deposits WHERE id=$1`,
      [dId])).rows[0]
    expect(d.status).toBe('confirmed')
    expect(d.bank_transaction_id).toBe(tId)
    const t = (await db.query(
      `SELECT status FROM bank_transactions WHERE id=$1`, [tId])).rows[0]
    expect(t.status).toBe('matched')
  })
})

describe('what it refuses to do alone', () => {
  // A unique amount is enough to PRE-TICK for a landlord who is looking at it.
  // It is not enough to move money unattended.
  it('will not settle on amount alone, even when only one tenant could match', async () => {
    const p = await buildPark(1)
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  it('will not settle on a named check without a declaration', async () => {
    const p = await buildPark(3)
    const name = (await db.query(
      `SELECT usr.last_name FROM tenants t JOIN users usr ON usr.id=t.user_id
        WHERE t.id=$1`, [p.lots[1].tenantId])).rows[0].last_name
    await deposit(p, 250, `REMOTE DEP CHK ${name}`)
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
  })

  it('will not settle when two tenants both declared the same figure', async () => {
    const p = await buildPark(25)
    await declareFor(p, 3, 250, 'cash')
    await declareFor(p, 11, 250, 'cash')
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    // Ambiguous between the two claimants — a human picks.
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[3].rentId)).toBe('pending')
    expect(await rentStatus(p.lots[11].rentId)).toBe('pending')
  })

  it('ignores a deposit that matches no claim', async () => {
    const p = await buildPark(5)
    await declareFor(p, 0, 250)
    await deposit(p, 900, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
  })

  it('never reaches another landlord’s deposits', async () => {
    const a = await buildPark(2)
    const b = await buildPark(2)
    await declareFor(b, 0, 250)
    await deposit(b, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(a.landlordId)).toBe(0)
    expect(await rentStatus(b.lots[0].rentId)).toBe('pending')
  })

  it('is safe to run twice — a settled deposit is not settled again', async () => {
    const p = await buildPark(3)
    await declareFor(p, 0, 250)
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    const settled = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE lease_id=$1 AND type='rent' AND status='settled'`, [p.lots[0].leaseId])
    expect(settled.rows[0].n).toBe(1)
  })
})
