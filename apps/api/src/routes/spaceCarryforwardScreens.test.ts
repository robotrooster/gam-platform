/**
 * 10/19 (Nic) — THE SCREENS FOR A MOBILE HOME CHANGING HANDS WITH A DEBT ON IT.
 *
 *   "We need to get a screen done so I can send the invite to Jacob. ... I want
 *    to go through and mark Rashawn as moved out in the system when it's time to
 *    do that. And then add Jacob to the space or invite him to the space. And I
 *    want to see how that carry forward balance flow goes. I want to see what
 *    triggers, what actually asks the landlord, hey, is your new tenant carrying
 *    forward this balance from this spot?"
 *
 * The engine has its own suite (services/spaceRentCarryforward.test.ts). This
 * one is about the DOORS the screens knock on, and the four things a screen can
 * get wrong that the engine cannot:
 *
 *   · the preview must WRITE NOTHING. It is the figures a landlord decides from,
 *     opened and closed again all day long.
 *   · where this does not apply it must SAY SO, in plain words, not in enum
 *     values and not by hiding the action. The RV case is live: 94 spots at Oak
 *     Park are marked tenant-owned, and the guest owns the RV.
 *   · the figure the landlord SAW is the figure that gets closed out. A payment
 *     landing in between is asked again, never sent silently.
 *   · and a staff member locked to one park cannot reach a space in another.
 *     The money routes had only the company-level check before this pass.
 *
 * Built on the live shape of MH 09 at Oak Park: $880.00 of unpaid space rent
 * (Sept 1 and Oct 1 at $440), $1,051.00 of utilities and $95.00 of daily late
 * fees. Run it with the unapplied migrations:
 *
 *   DB_NAME=<yours>_test TEST_APPLY_MIGRATIONS_AFTER=20261020125959 npx vitest run routes/spaceCarryforwardScreens.test
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { spaceCarryforwardRouter } from './spaceCarryforward'
import { errorHandler } from '../middleware/errorHandler'
import { runCarryforwardArrangements, closeOutWithCarryforward } from '../services/spaceRentCarryforward'
import { SPACE_CARRYFORWARD_CHARGE_NOTE } from '@gam/shared'

const TZ = 'America/Phoenix'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leases', leasesRouter)
  app.use('/api/space-carryforward', spaceCarryforwardRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_space_screens'
})

const parkDay = async (daysAgo: number) => (await db.query<{ d: string }>(
  `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, daysAgo])).rows[0].d

interface Park {
  userId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; leaseId: string; token: string
}

/**
 * MH 09 as it stands today: an active lease with NO end date on a tenant-owned
 * mobile home, two unpaid bills behind it and the late fees still climbing.
 * `unitType` and `dwellingOwnership` are the two facts the whole mechanism turns
 * on, so every refusal case here is the same park with one of them changed.
 */
async function oakPark(opts: {
  unitType?: string
  dwellingOwnership?: 'tenant' | 'landlord'
  rent?: number
} = {}): Promise<Park> {
  const rent = opts.rent ?? 440
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = $2, name = 'Oak Park', late_fee_enabled = TRUE WHERE id = $1`,
      [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: rent, unitType: opts.unitType ?? 'mobile_home' })
    await c.query(`UPDATE units SET unit_number = 'MH 09', dwelling_ownership = $2 WHERE id = $1`,
      [unitId, opts.dwellingOwnership ?? 'tenant'])
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: rent, startDate: await parkDay(48) })
    await c.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [leaseId])
    await seedLeaseTenant(c, { leaseId, tenantId })

    const bill = async (dueDaysAgo: number, utilities: number[]) => {
      const due = await parkDay(dueDaysAgo)
      const utils = utilities.reduce((s, u) => s + u, 0)
      const invoiceId = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, subtotal_utilities, total_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,'pending') RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 10)}`,
         due, rent, utils, rent + utils])).rows[0].id
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, invoice_id)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,$7)`,
        [landlordId, unitId, leaseId, tenantId, rent, due, invoiceId])
      for (const u of utilities) {
        await c.query(
          `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                                 entry_description, due_date, invoice_id)
           VALUES ($1,$2,$3,$4,'utility',$5,'pending','UTILITY',$6::date,$7)`,
          [landlordId, unitId, leaseId, tenantId, u, due, invoiceId])
      }
      return invoiceId
    }
    await bill(48, [997, 25])
    const oct = await bill(18, [25, 4])
    for (let i = 0; i < 19; i++) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, invoice_id)
         VALUES ($1,$2,$3,$4,'late_fee',5,'pending','LATEFEE',$5::date,$6)`,
        [landlordId, unitId, leaseId, tenantId, await parkDay(18 - i), oct])
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'owner@oakpark.test', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A second park on the same account, with its own space — the scope case. */
async function secondPark(p: Park): Promise<{ propertyId: string; unitId: string; leaseId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const propertyId = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId })
    await c.query(`UPDATE properties SET timezone = $2, name = 'Mountain View' WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: p.landlordId, rentAmount: 500, unitType: 'mobile_home' })
    await c.query(`UPDATE units SET dwelling_ownership = 'tenant' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: 500, startDate: await parkDay(30) })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return { propertyId, unitId, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** An on-site manager locked to ONE property, with every money permission. */
async function lockedStaff(p: Park, propertyIds: string[]): Promise<string> {
  const perms = {
    'leases.terminate': true, 'leases.bill_fee': true, 'leases.edit': true,
    'tenants.invite': true, 'leases.create': true,
  }
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
    [`desk-${Math.random().toString(36).slice(2)}@oakpark.test`])).rows[0].id
  await db.query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,FALSE,$4)`,
    [u, p.landlordId, propertyIds, JSON.stringify(perms)])
  return jwt.sign({ userId: u, role: 'onsite_manager', email: 'desk@oakpark.test', landlordId: p.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const get = (url: string, token: string) =>
  request(buildApp()).get(url).set('Authorization', `Bearer ${token}`)
const post = (url: string, token: string, body: any = {}) =>
  request(buildApp()).post(url).set('Authorization', `Bearer ${token}`).send(body)
const put = (url: string, token: string, body: any = {}) =>
  request(buildApp()).put(url).set('Authorization', `Bearer ${token}`).send(body)

// ── 1. The preview is a screen, not an action ────────────────────────────────

describe('the window that closes a departing resident out', () => {
  it('shows all four figures and writes nothing until the landlord presses', async () => {
    const p = await oakPark()

    const before = async () => ({
      claims: (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_rent_carryforwards`)).rows[0].n,
      voided: (await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payments WHERE lease_id = $1 AND status = 'voided'`, [p.leaseId])).rows[0].n,
      lease: (await db.query<{ status: string; end_date: string | null }>(
        `SELECT status, end_date::text AS end_date FROM leases WHERE id = $1`, [p.leaseId])).rows[0],
      unit: (await db.query<{ status: string }>(`SELECT status FROM units WHERE id = $1`, [p.unitId])).rows[0].status,
      carried: (await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payments WHERE type = 'carried_balance'`)).rows[0].n,
    })
    const was = await before()

    // Opened, and opened again — a landlord reads this screen, closes it, comes
    // back to it. Twice, so an accidental write would show up either way.
    for (const _ of [1, 2]) {
      const res = await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)
      expect(res.status).toBe(200)
      const pv = res.body.data
      expect(pv.eligible).toBe(true)
      // THE FOUR FIGURES.
      expect(pv.carriesTotal).toBe(880)       // becomes the space's balance
      expect(pv.staysTotal).toBe(1051)        // stays the departing resident's own debt
      expect(pv.waivesTotal).toBe(95)         // late fees, dropped outright
      expect(pv.spaceName).toBe('MH 09')      // and the lease that is about to close
      expect(pv.departingTenantName).toBeTruthy()
      // Every carried row is space rent, with its own due date, so the landlord
      // can check the total rather than take it on trust.
      expect(pv.carries).toHaveLength(2)
      expect(pv.carries.every((l: any) => l.label === 'Space rent')).toBe(true)
      expect(pv.carries.reduce((t: number, l: any) => t + l.amount, 0)).toBe(880)
    }

    expect(await before()).toEqual(was)

    // The press writes, once.
    const done = await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token,
      { expectedCarried: 880 })
    expect(done.status).toBe(201)
    expect(done.body.data).toMatchObject({
      carriedAmount: 880, lateFeesWaived: 95, stayedWithDepartingTenant: 1051,
    })
    const now = await before()
    expect(now.claims).toBe(1)
    expect(now.carried).toBe(1)
    expect(now.voided).toBe(21)               // 2 rent carried + 19 late fees dropped
    expect(now.lease.status).toBe('terminated')
    expect(now.lease.end_date).toBe(await parkDay(0))
    expect(now.unit).toBe('vacant')
  })

  it('refuses the press when the figure moved under it, and says the new one', async () => {
    const p = await oakPark()
    // $440 of the space rent is paid while the window sits open.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW()
        WHERE lease_id = $1 AND type = 'rent' AND due_date = $2::date`, [p.leaseId, await parkDay(48)])

    const res = await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token,
      { expectedCarried: 880 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/has changed/i)
    expect(res.body.error).toContain('$440.00')
    // And nothing was written on the way to refusing.
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_rent_carryforwards`)).rows[0].n).toBe(0)
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [p.leaseId])).rows[0].status)
      .toBe('active')

    // Read again, press on what it says now: through.
    const pv = (await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)).body.data
    expect(pv.carriesTotal).toBe(440)
    expect((await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token,
      { expectedCarried: 440 })).status).toBe(201)
  })
})

// ── 2. Where it does not apply, it says why ──────────────────────────────────

describe('a space this does not work on', () => {
  /** No enum value, no column name, no code — a landlord reads this. */
  const plainWords = (reason: string) => {
    expect(reason).toBeTruthy()
    expect(reason).not.toMatch(/mobile_home|rv_spot|dwelling_ownership|unit_type|_/)
    expect(reason[0]).toBe(reason[0].toUpperCase())
    expect(reason.length).toBeGreaterThan(40)
  }

  it('an RV spot: the guest owns the RV and leaves with it', async () => {
    // The live risk, not a hypothetical: 94 RV spots at Oak Park are marked
    // tenant-owned, because the guest does own the RV.
    const p = await oakPark({ unitType: 'rv_spot', dwellingOwnership: 'tenant' })
    const res = await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)
    expect(res.status).toBe(200)
    expect(res.body.data.eligible).toBe(false)
    plainWords(res.body.data.reason)
    expect(res.body.data.reason).toMatch(/RV/)
    // And the figures are still there, so the window can show what IS owed
    // while refusing to carry any of it.
    expect(res.body.data.carriesTotal).toBe(880)

    // The action itself refuses too — the screen is not the only gate.
    const done = await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    expect(done.status).toBe(409)
    expect(done.body.error).toMatch(/RV/)
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_rent_carryforwards`)).rows[0].n).toBe(0)
  })

  it('a park-owned home: a vacancy has no next owner to inherit it', async () => {
    const p = await oakPark({ unitType: 'mobile_home', dwellingOwnership: 'landlord' })
    const res = await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)
    expect(res.body.data.eligible).toBe(false)
    plainWords(res.body.data.reason)
    expect(res.body.data.reason).toMatch(/park owns the home/i)
    expect((await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})).status).toBe(409)
  })

  it('an apartment: the same refusal as any other landlord-owned unit', async () => {
    const p = await oakPark({ unitType: 'apartment', dwellingOwnership: 'landlord' })
    const res = await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)
    expect(res.body.data.eligible).toBe(false)
    plainWords(res.body.data.reason)
  })
})

// ── 3. What the space carries, and the arrangement on it ─────────────────────

describe('what a space carries', () => {
  it('reads back by space and by lease, with the label the new resident sees', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})

    const byUnit = await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)
    expect(byUnit.status).toBe(200)
    expect(byUnit.body.data).toMatchObject({
      amount: 880, stillOwed: 880, lateFeesWaived: 95, status: 'open',
      spaceName: 'MH 09', chargeLabel: SPACE_CARRYFORWARD_CHARGE_NOTE,
      followsToNextLease: true,
    })
    expect(byUnit.body.data.owedByName).toBeTruthy()

    const list = await get('/api/space-carryforward', p.token)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].unitId).toBe(p.unitId)

    const byLease = await get(`/api/leases/${p.leaseId}/space-carryforward`, p.token)
    expect(byLease.body.data.role).toBe('origin')
    expect(byLease.body.data.amount).toBe(880)
  })

  it('an arrangement can be set, shows its cycles, and no cycle is ever fined', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})

    const today = await parkDay(0)
    const day = Number(today.slice(8, 10))
    // Nic: "even if it's $50 or $100 or whatever."
    const set = await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, p.token,
      { amount: 100, dayOfMonth: Math.min(day, 28), startOn: today })
    expect(set.status).toBe(200)
    expect(set.body.data.arrangement).toMatchObject({ amount: 100, dayOfMonth: Math.min(day, 28) })

    // The cycle runs on its day.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await runCarryforwardArrangements(c, today)
      await c.query('COMMIT')
      expect(r.asked).toBe(1)
      expect(r.lateFeesCharged).toBe(0)
    } finally { c.release() }

    const after = (await get(`/api/leases/${p.leaseId}/space-carryforward`, p.token)).body.data
    expect(after.installments).toHaveLength(1)
    expect(after.installments[0]).toMatchObject({ amount: 100, status: 'asked', dueDate: today })

    // THE PROMISE THE SCREEN MAKES: nothing is fined. Not one late_fee row
    // exists against this space any more — the 19 that did were dropped at
    // close-out and the arrangement writes none.
    const fees = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE unit_id = $1 AND type = 'late_fee' AND status IN ('pending','failed','settled')`, [p.unitId])
    expect(fees.rows[0].n).toBe(0)
    // And the one carried charge is on no invoice, which is what keeps the
    // nightly engine away from it by construction rather than by a filter.
    const charge = await db.query<{ invoice_id: string | null }>(
      `SELECT invoice_id FROM payments WHERE type = 'carried_balance' AND status = 'pending'`)
    expect(charge.rows).toHaveLength(1)
    expect(charge.rows[0].invoice_id).toBeNull()

    // Turning it off keeps the balance owed and stops asking.
    const off = await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, p.token,
      { amount: null, dayOfMonth: null })
    expect(off.body.data.arrangement).toBeNull()
    expect(off.body.data.stillOwed).toBe(880)
  })

  it('refuses a monthly amount bigger than what is still owed', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const res = await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, p.token,
      { amount: 1200, dayOfMonth: 1 })
    expect(res.status).toBe(422)
    expect(res.body.error).toContain('$880.00')
  })

  it('the take-off door: nothing is erased, it stops being a bill', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const res = await post(`/api/leases/${p.leaseId}/space-carryforward/take-off`, p.token,
      { reason: 'home abandoned, park took it back' })
    expect(res.status).toBe(200)
    expect(res.body.data.takenOff).toBe(880)
    const after = (await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)).body.data
    expect(after.status).toBe('voided')
    expect(after.stillOwed).toBe(0)
    expect(after.followsToNextLease).toBe(false)   // it never lands on anybody else
  })
})

// ── 4. The question at the invite ────────────────────────────────────────────

describe('the question the invite screen asks', () => {
  it('a space that carries a balance answers the invite read with the figure and whose it was', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})

    const read = await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)
    expect(read.body.data.followsToNextLease).toBe(true)
    expect(read.body.data.stillOwed).toBe(880)
    expect(read.body.data.owedByName).toBeTruthy()

    // The landlord's answer, recorded on the balance. The MONEY needs nothing
    // from it — the trigger moves the charge when the lease drafts — but weeks
    // later this is the only thing that says the question was ever asked.
    const rec = await post(`/api/space-carryforward/${read.body.data.id}/assumption`, p.token,
      { residents: [{ name: 'Incoming Resident', email: 'incoming@test.dev' }] })
    expect(rec.status).toBe(201)
    expect(rec.body.data.line).toMatch(/condition of moving in/i)
    expect(rec.body.data.line).toContain('Incoming Resident')
    const notes = (await db.query<{ notes: string }>(
      `SELECT notes FROM space_rent_carryforwards WHERE unit_id = $1`, [p.unitId])).rows[0].notes
    expect(notes).toContain('Incoming Resident')

    // Pressed twice on a slow connection: one line, not two.
    await post(`/api/space-carryforward/${read.body.data.id}/assumption`, p.token,
      { residents: [{ name: 'Incoming Resident', email: 'incoming@test.dev' }] }).expect(201)
    const again = (await db.query<{ notes: string }>(
      `SELECT notes FROM space_rent_carryforwards WHERE unit_id = $1`, [p.unitId])).rows[0].notes
    expect(again.split('Incoming Resident')).toHaveLength(2)
  })

  it('a space that carries nothing answers null, so the screen asks nothing', async () => {
    const p = await oakPark()
    const read = await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)
    expect(read.status).toBe(200)
    expect(read.body.data).toBeNull()
    expect((await get('/api/space-carryforward', p.token)).body.data).toEqual([])
  })

  it('a space the park has taken the home over on stops asking, because the balance no longer moves', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    // The likeliest ending of this exact situation: the park takes the
    // abandoned home for the back rent and rents it out itself.
    await db.query(`UPDATE units SET dwelling_ownership = 'landlord' WHERE id = $1`, [p.unitId])

    const read = await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)
    expect(read.body.data.stillOwed).toBe(880)         // still owed by the man who left
    expect(read.body.data.followsToNextLease).toBe(false)  // but it lands on nobody new
  })
})

// ── 5. A staff member locked to one park ─────────────────────────────────────

describe('a property-locked staff member', () => {
  it('cannot reach a space outside their properties — read or write', async () => {
    const p = await oakPark()
    const other = await secondPark(p)
    // Locked to Mountain View; Oak Park is not theirs.
    const token = await lockedStaff(p, [other.propertyId])

    // Reads.
    expect((await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, token)).status).toBe(403)
    expect((await get(`/api/space-carryforward/unit/${p.unitId}`, token)).status).toBe(403)
    // Writes: the two that move money, and the one that ends a tenancy.
    expect((await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, token, {})).status).toBe(403)
    expect((await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, token,
      { amount: 50, dayOfMonth: 1 })).status).toBe(403)
    expect((await post(`/api/leases/${p.leaseId}/space-carryforward/take-off`, token, {})).status).toBe(403)
    // Nothing happened on the way to any of those refusals.
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_rent_carryforwards`)).rows[0].n).toBe(0)
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [p.leaseId])).rows[0].status)
      .toBe('active')

    // And their own park still works, so this is a scope and not a lockout.
    expect((await get(`/api/leases/${other.leaseId}/space-carryforward/preview`, token)).status).toBe(200)
  })

  it('does not see another park\'s balance in the list, and cannot record an answer on it', async () => {
    const p = await oakPark()
    const other = await secondPark(p)
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const claimId = (await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)).body.data.id

    const token = await lockedStaff(p, [other.propertyId])
    expect((await get('/api/space-carryforward', token)).body.data).toEqual([])
    expect((await get(`/api/space-carryforward/${claimId}`, token)).status).toBe(403)
    expect((await post(`/api/space-carryforward/${claimId}/assumption`, token,
      { residents: [{ name: 'Someone', email: 's@t.dev' }] })).status).toBe(403)
    expect((await db.query<{ notes: string | null }>(
      `SELECT notes FROM space_rent_carryforwards WHERE id = $1`, [claimId])).rows[0].notes).toBeNull()

    // Locked to Oak Park instead: the same calls go through.
    const atOakPark = await lockedStaff(p, [p.propertyId])
    expect((await get('/api/space-carryforward', atOakPark)).body.data).toHaveLength(1)
    expect((await post(`/api/space-carryforward/${claimId}/assumption`, atOakPark,
      { residents: [{ name: 'Someone', email: 's@t.dev' }] })).status).toBe(201)
  })
})

// ── 6. Another company's charge on the same document ─────────────────────────

describe('a converged invoice carrying a neighbor landlord’s utility', () => {
  /**
   * S616: where a neighbor landlord's meter supplies a serviced space, his
   * utility rides THIS resident's invoice — jobs/invoiceGeneration writes it
   * with `lease_id` NULL, his own `landlord_id`, and revenue_owner left to its
   * default of 'landlord'. Nic: "the utilities are not tied to the lease from
   * the landlord next door because they are not part of that. They're getting
   * billed to the same tenant but for a different landlord."
   *
   * The close-out window reads the departing resident's bill by lease AND by
   * its invoices, so without a company filter that $40 counted as money owed
   * to THIS park: the window said "Stays their own debt — $1,091.00", listed a
   * line that is another company's receivable, and the done screen reported it.
   */
  const neighborUtilityOnTheSameInvoice = async (p: Park, amount: number) => {
    const c = await db.connect()
    let neighborId: string
    try {
      await c.query('BEGIN')
      neighborId = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const invoiceId = (await db.query<{ id: string }>(
      `SELECT id FROM invoices WHERE lease_id = $1 ORDER BY due_date DESC LIMIT 1`, [p.leaseId])).rows[0].id
    const id = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, invoice_id,
                             type, amount, status, entry_description, due_date, notes)
       VALUES ($1,$2,NULL,$3,$4,'utility',$5,'pending','UTILITY',
               (SELECT due_date FROM invoices WHERE id = $4), 'Water — the neighbor landlord’s meter')
       RETURNING id`,
      [neighborId, p.unitId, p.tenantId, invoiceId, amount])).rows[0].id
    return { neighborId, chargeId: id }
  }

  it('is not read as the departing resident’s debt to this park, and is left alone', async () => {
    const p = await oakPark()
    const neighbor = await neighborUtilityOnTheSameInvoice(p, 40)

    const pv = (await get(`/api/leases/${p.leaseId}/space-carryforward/preview`, p.token)).body.data
    // The four figures are this company's own money and nothing else.
    expect(pv.carriesTotal).toBe(880)
    expect(pv.staysTotal).toBe(1051)
    expect(pv.stays.map((l: any) => l.amount)).not.toContain(40)
    expect(pv.stays.some((l: any) => /neighbor/i.test(l.detail ?? ''))).toBe(false)

    const done = await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token,
      { expectedCarried: 880 })
    expect(done.status).toBe(201)
    expect(done.body.data.stayedWithDepartingTenant).toBe(1051)

    // And the row itself is untouched: still owed, still the neighbor's.
    const after = (await db.query<{ status: string; landlord_id: string; space_carryforward_id: string | null }>(
      `SELECT status, landlord_id, space_carryforward_id FROM payments WHERE id = $1`, [neighbor.chargeId])).rows[0]
    expect(after.status).toBe('pending')
    expect(after.landlord_id).toBe(neighbor.neighborId)
    expect(after.space_carryforward_id).toBeNull()
  })
})

// ── 7. The figure the landlord saw, checked where it is authoritative ────────

describe('the press is answered against the locked figure', () => {
  /**
   * The route previews OUTSIDE the household lock and compares there, which
   * cannot be the check that holds: a desk payment landing in that window takes
   * the same household lock and therefore completes FIRST, so the comparison
   * was made against a stale $880, passed, and the claim was then created for
   * whatever the locked read found — closed out silently on a figure the
   * landlord never saw. The service is driven directly here because that is
   * exactly the state the race leaves: the press is in flight with 880 on it
   * and the money has already moved.
   */
  it('refuses inside the transaction when the money moved after the route’s read', async () => {
    const p = await oakPark()
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW()
        WHERE lease_id = $1 AND type = 'rent' AND due_date = $2::date`, [p.leaseId, await parkDay(48)])

    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(closeOutWithCarryforward(c, {
        leaseId: p.leaseId, byUserId: p.userId, expectedCarried: 880,
      })).rejects.toThrow(/has changed .* \$440\.00/)
      await c.query('ROLLBACK')
    } finally { c.release() }

    // Nothing was written on the way to refusing.
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_rent_carryforwards`)).rows[0].n).toBe(0)
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [p.leaseId])).rows[0].status)
      .toBe('active')

    // Pressed on what it says now: through, under the lock, for $440.
    const c2 = await db.connect()
    try {
      await c2.query('BEGIN')
      const r = await closeOutWithCarryforward(c2, {
        leaseId: p.leaseId, byUserId: p.userId, expectedCarried: 440,
      })
      await c2.query('COMMIT')
      expect(r.carriedAmount).toBe(440)
    } catch (e) { await c2.query('ROLLBACK'); throw e } finally { c2.release() }
  })
})

// ── 8. A cycle is never left reading "asked" once nobody is being asked ──────

describe('the last cycle an arrangement asked for', () => {
  /** A day in the last fortnight whose day-of-month an arrangement can use (1–28). */
  const askableDay = async (): Promise<string> => {
    for (let d = 3; d <= 14; d++) {
      const day = await parkDay(d)
      if (Number(day.slice(8, 10)) <= 28) return day
    }
    throw new Error('no askable day in the last fortnight')
  }
  const runOn = async (asOf: string) => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await runCarryforwardArrangements(c, asOf)
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const cyclesOf = async (p: Park) =>
    (await get(`/api/leases/${p.leaseId}/space-carryforward`, p.token)).body.data.installments

  const withAnArrangementAsked = async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const asked = await askableDay()
    await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, p.token,
      { amount: 100, dayOfMonth: Number(asked.slice(8, 10)), startOn: asked }).expect(200)
    expect((await runOn(asked)).asked).toBe(1)
    expect((await cyclesOf(p))[0]).toMatchObject({ amount: 100, status: 'asked', dueDate: asked })
    return { p, asked }
  }

  it('is judged after the balance is paid off — never "Paid off" over "Asked for this month"', async () => {
    const { p } = await withAnArrangementAsked()

    // The resident pays the whole thing. The claim rolls up to settled in a
    // database trigger, which has no way to re-read the cycle — the nightly
    // run does it.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW()
        WHERE type = 'carried_balance' AND status = 'pending'`)
    const claim = (await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)).body.data
    expect(claim.status).toBe('settled')
    expect(claim.stillOwed).toBe(0)

    await runOn(await parkDay(0))
    const cycles = await cyclesOf(p)
    expect(cycles).toHaveLength(1)
    expect(cycles[0].status).toBe('met')
    expect(cycles[0].appliedAmount).toBe(100)
    // Nothing was fined on the way, either way.
    expect((await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments WHERE unit_id = $1 AND type = 'late_fee'
        AND status IN ('pending','failed','settled')`, [p.unitId])).rows[0].n).toBe(0)
  })

  it('is judged the moment the landlord stops asking, not a day later', async () => {
    const { p } = await withAnArrangementAsked()
    const off = await put(`/api/leases/${p.leaseId}/space-carryforward/arrangement`, p.token,
      { amount: null, dayOfMonth: null })
    expect(off.status).toBe(200)
    expect(off.body.data.arrangement).toBeNull()
    expect(off.body.data.stillOwed).toBe(880)
    // Nothing came in against it, so the cycle reads what happened — and the
    // label says in the same breath that it carries no fee.
    expect((await cyclesOf(p))[0].status).toBe('missed')
  })

  it('a cycle already judged on a closed balance is not re-written every night', async () => {
    const { p } = await withAnArrangementAsked()
    await post(`/api/leases/${p.leaseId}/space-carryforward/take-off`, p.token, { reason: 'home abandoned' })
    expect((await cyclesOf(p))[0].status).toBe('missed')
    const stamped = (await db.query<{ u: string }>(
      `SELECT updated_at::text AS u FROM space_carryforward_installments LIMIT 1`)).rows[0].u
    const journal = async () => (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_row_changes WHERE table_name = 'space_carryforward_installments'`)).rows[0].n
    const was = await journal()
    await runOn(await parkDay(0))
    await runOn(await parkDay(0))
    expect((await db.query<{ u: string }>(
      `SELECT updated_at::text AS u FROM space_carryforward_installments LIMIT 1`)).rows[0].u).toBe(stamped)
    expect(await journal()).toBe(was)
  })
})

// ── 9. The condition, recorded once per person ───────────────────────────────

describe('the sentence that records the condition', () => {
  it('is not written twice when the same invite is sent again the next day', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const claimId = (await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)).body.data.id
    const residents = [{ name: 'Incoming Resident', email: 'incoming@test.dev' }]

    await post(`/api/space-carryforward/${claimId}/assumption`, p.token, { residents }).expect(201)
    // The invite email bounced and the landlord sends it again tomorrow — or
    // simply presses either side of midnight in the park's timezone. The
    // duplicate check used to be the whole sentence, date and all, so it only
    // held within one property-local day. Aged here by rewriting the day the
    // line carries, which is exactly what yesterday's press would have left.
    await db.query(
      `UPDATE space_rent_carryforwards
          SET notes = replace(notes, $2, $3) WHERE id = $1`,
      [claimId, (await parkDay(0)), await parkDay(1)])

    const again = await post(`/api/space-carryforward/${claimId}/assumption`, p.token, { residents })
    expect(again.status).toBe(201)
    expect(again.body.data.alreadyRecorded).toBe(true)
    const notes = (await db.query<{ notes: string }>(
      `SELECT notes FROM space_rent_carryforwards WHERE id = $1`, [claimId])).rows[0].notes
    expect(notes.split('Incoming Resident')).toHaveLength(2)
    expect(notes.split('condition of moving in')).toHaveLength(2)

    // A DIFFERENT household asked about the same space is its own sentence.
    await post(`/api/space-carryforward/${claimId}/assumption`, p.token,
      { residents: [{ name: 'Someone Else', email: 'else@test.dev' }] }).expect(201)
    const both = (await db.query<{ notes: string }>(
      `SELECT notes FROM space_rent_carryforwards WHERE id = $1`, [claimId])).rows[0].notes
    expect(both.split('condition of moving in')).toHaveLength(3)
  })
})

// ── 10. A balance that moved onto a lease nobody was asked about ─────────────

describe('a lease drafted from a door that does not ask', () => {
  /**
   * The trigger moves the balance onto ANY lease drafted on the space, and only
   * the invite screen asks the question. A resident papered through tenant
   * onboarding, issuance or stay terms inherits a stranger's space rent in
   * silence — so the claim says whether anybody was ever asked, and the space's
   * window says so where nobody was.
   */
  const draftALeaseOnTheSpace = async (p: Park) => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, {
        unitId: p.unitId, landlordId: p.landlordId, rentAmount: 440, startDate: await parkDay(0),
      })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query('COMMIT')
      return { leaseId, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('says nobody was asked — and stops saying it once somebody is', async () => {
    const p = await oakPark()
    await post(`/api/leases/${p.leaseId}/space-carryforward/close-out`, p.token, {})
    const claimId = (await get(`/api/space-carryforward/unit/${p.unitId}`, p.token)).body.data.id

    // Before any lease: nothing moved, so there is nothing to warn about.
    expect((await get(`/api/space-carryforward/${claimId}`, p.token)).body.data.movedWithoutBeingAsked).toBe(false)

    const next = await draftALeaseOnTheSpace(p)
    const moved = (await get(`/api/space-carryforward/${claimId}`, p.token)).body.data
    expect(moved.assumedLeaseId).toBe(next.leaseId)
    expect(moved.assumptionRecordedAt).toBeNull()
    expect(moved.movedWithoutBeingAsked).toBe(true)

    // The landlord puts the condition to them: the record is complete and the
    // window stops warning.
    await post(`/api/space-carryforward/${claimId}/assumption`, p.token,
      { residents: [{ name: 'Incoming Resident', email: 'incoming@test.dev' }] }).expect(201)
    const asked = (await get(`/api/space-carryforward/${claimId}`, p.token)).body.data
    expect(asked.assumptionRecordedAt).not.toBeNull()
    expect(asked.movedWithoutBeingAsked).toBe(false)
  })
})
