/**
 * 10/12 (Nic) — the monthly property report on the Reports page.
 *
 *   GET  /api/reports/monthly-report            the report (all four groups)
 *   GET  /api/reports/monthly-report/pdf        the same report, as the emailed PDF
 *   GET  /api/reports/monthly-report/recipients who gets it — owner / admin only
 *   POST /api/reports/monthly-report/recipients the owner's list   — owner / admin only
 *
 * A team member sees the report for the properties they are assigned to, and
 * never the recipient list. Every pass is shaped as auth.ts mints it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'
import { emailMonthlyPropertyReport } from '../services/email'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_monthly_report'
})

const sign = (claims: object) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface F { lid: string; uid: string; propA: string; propB: string; owner: string; pm: string; pmId: string }

async function seed(): Promise<F> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: uid, landlordId: lid } = await seedLandlord(c)
    const prop = async (name: string) => {
      const id = await seedProperty(c, { landlordId: lid, ownerUserId: uid, managedByUserId: uid })
      await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix' WHERE id = $1`, [id, name])
      return id
    }
    const propA = await prop('Alpha Park'), propB = await prop('Bravo Park')
    for (const [propertyId, amt] of [[propA, 500], [propB, 700]] as const) {
      const unitId = await seedUnit(c, { propertyId, landlordId: lid })
      const leaseId = await seedLease(c, { unitId, landlordId: lid })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at, settled_at, manual_method)
         VALUES ($1,$2,$3,$4,'rent',$5,'settled','2026-09-01','RENT','2026-08-25T09:00:00-07:00','2026-09-03T10:00:00-07:00','cash')`,
        [unitId, leaseId, tenantId, lid, amt])
    }
    const pmId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`, [`pm-${lid.slice(0, 8)}@example.org`])).rows[0].id
    await c.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,FALSE,$3)`,
      [pmId, lid, [propA]])
    await c.query('COMMIT')
    return {
      lid, uid, propA, propB, pmId,
      owner: sign({ userId: uid, role: 'landlord', email: 'o@t.dev', profileId: null, landlordId: null, landlordIds: [lid], permissions: null }),
      pm: sign({ userId: pmId, role: 'property_manager', email: 'pm@example.org', profileId: null, landlordId: lid,
                 permissions: { 'payments.view_all': true, 'reports.tab.monthly': true } }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const get = (token: string, path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)
const post = (token: string, path: string, body: object) => request(buildApp()).post(path).send(body).set('Authorization', `Bearer ${token}`)

describe('GET /api/reports/monthly-report', () => {
  it('the owner gets every property, all four groups, with the three columns named', async () => {
    const f = await seed()
    const res = await get(f.owner, '/api/reports/monthly-report?month=2026-09')
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.monthLabel).toBe('September 2026')
    expect(d.properties.map((p: any) => p.property.name)).toEqual(['Alpha Park', 'Bravo Park'])
    for (const p of d.properties) expect(Object.keys(p).sort()).toEqual(['money', 'operations', 'payments', 'property', 'tenants'])
    expect(d.totals.money.view).toMatchObject({ charged: 1200, received: 1200, owed: 0 })
    // 10/12 (Nic, L2): Received leads.
    expect(d.meta.columns.map((c: any) => c.label)).toEqual(['Received', 'Charged', 'Owed'])
    // The API camelizes keys, never values: a stamp is still its enum value.
    expect(d.properties[0].payments.counts[0]).toMatchObject({ stamp: 'paid_on_time', label: 'Paid on time', households: 1 })
  })

  it('a property manager gets only the properties they manage — and a named other one is not found', async () => {
    const f = await seed()
    const res = await get(f.pm, '/api/reports/monthly-report?month=2026-09')
    expect(res.status).toBe(200)
    expect(res.body.data.properties.map((p: any) => p.property.name)).toEqual(['Alpha Park'])
    expect(res.body.data.totals.money.view.received).toBe(500)
    expect((await get(f.pm, `/api/reports/monthly-report?month=2026-09&propertyId=${f.propB}`)).status).toBe(404)
    const one = await get(f.owner, `/api/reports/monthly-report?month=2026-09&propertyId=${f.propB}`)
    expect(one.body.data.properties.map((p: any) => p.property.name)).toEqual(['Bravo Park'])
  })

  it('opens on the Monthly report permission, not on "View all payments" (10/12 review)', async () => {
    const f = await seed()
    const staff = (permissions: Record<string, boolean>) => sign({
      userId: f.pmId, role: 'property_manager', email: 'pm@example.org', profileId: null, landlordId: f.lid, permissions })
    // Granted the tab only: the tab's report opens (their properties).
    const tabOnly = await get(staff({ 'reports.tab.monthly': true }), '/api/reports/monthly-report?month=2026-09')
    expect(tabOnly.status).toBe(200)
    expect(tabOnly.body.data.properties.map((p: any) => p.property.name)).toEqual(['Alpha Park'])
    // "View all payments" without the tab: neither the report nor its PDF.
    const viewAll = staff({ 'payments.view_all': true })
    expect((await get(viewAll, '/api/reports/monthly-report?month=2026-09')).status).toBe(403)
    expect((await get(viewAll, '/api/reports/monthly-report/pdf?month=2026-09')).status).toBe(403)
  })

  it('refuses a month that is not one, or has not started', async () => {
    const f = await seed()
    expect((await get(f.owner, '/api/reports/monthly-report?month=2026-13')).status).toBe(400)
    expect((await get(f.owner, '/api/reports/monthly-report?month=2999-01')).status).toBe(400)
    expect((await get(f.owner, '/api/reports/monthly-report')).status).toBe(200)   // last month
  })

  it('the PDF is the same report, served to a signed-in viewer only', async () => {
    const f = await seed()
    const res = await get(f.owner, '/api/reports/monthly-report/pdf?month=2026-09').buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (x: Buffer) => chunks.push(x)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Monthly-report-.*-2026-09\.pdf"/)
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await request(buildApp()).get('/api/reports/monthly-report/pdf?month=2026-09')).status).toBe(401)
  })
})

describe('who gets it: owner / admin only', () => {
  it('the owner reads the list (default: themselves) and the team to pick from', async () => {
    const f = await seed()
    const res = await get(f.owner, '/api/reports/monthly-report/recipients')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ canEdit: true, isDefault: true, maxExtraEmails: 20 })
    expect(res.body.data.recipients).toEqual([expect.objectContaining({ kind: 'team_member', userId: f.uid, roleLabel: 'Owner', allProperties: true })])
    expect(res.body.data.team.map((m: any) => [m.roleLabel, m.allProperties, m.propertyCount])).toEqual([
      ['Owner', true, null], ['Property Manager', false, 1],
    ])
  })

  it('the owner saves a list: their manager and an outside address', async () => {
    const f = await seed()
    const res = await post(f.owner, '/api/reports/monthly-report/recipients', { teamMemberIds: [f.pmId], emails: ['CPA@example.org'] })
    expect(res.status).toBe(200)
    expect(res.body.data.isDefault).toBe(false)
    expect(res.body.data.recipients.map((r: any) => [r.kind, r.email, r.propertyCount])).toEqual([
      ['team_member', expect.stringMatching(/^pm-.*@example\.org$/), 1], ['email', 'cpa@example.org', null],
    ])
  })

  // 10/12 (Nic): a send stuck at 'sending' read "Sending" on the list forever.
  // After 30 minutes it says it was not sent, and GAM is told before it says so.
  it('a send stuck past 30 minutes reads "Not sent — stuck, GAM was alerted", and GAM is alerted once', async () => {
    const f = await seed()
    await post(f.owner, '/api/reports/monthly-report/recipients', { teamMemberIds: [f.pmId], emails: ['cpa@example.org'] })
    const ownerEmail = (await db.query<{ email: string }>(`SELECT lower(email) AS email FROM users WHERE id = $1`, [f.uid])).rows[0].email
    const claim = (email: string, minutesAgo: number) => db.query(
      `INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, status, updated_at)
       VALUES ($1, '2026-09-01', $2, $2, 'sending', NOW() - make_interval(mins => $3::int))`, [f.lid, email, minutesAgo])
    await claim(ownerEmail, 10)          // still going
    await claim('cpa@example.org', 120)  // the process died mid-send
    const res = await get(f.owner, '/api/reports/monthly-report/recipients')
    expect(res.status).toBe(200)
    const label = (email: string) => res.body.data.lastSends.find((s: any) => s.email === email)
    expect(label(ownerEmail)).toMatchObject({ statusLabel: 'Sending', stuck: false })
    expect(label('cpa@example.org')).toMatchObject({ statusLabel: 'Not sent — stuck, GAM was alerted', stuck: true })
    const alerts = async () => (await db.query(
      `SELECT context->>'email' AS email FROM admin_notifications WHERE category = 'monthly_report_send_stuck'`)).rows
    expect(await alerts()).toEqual([{ email: 'cpa@example.org' }])
    // Read again: still one alert for that send.
    await get(f.owner, '/api/reports/monthly-report/recipients')
    expect(await alerts()).toHaveLength(1)
  })

  it('a team member can neither read nor change the list', async () => {
    const f = await seed()
    expect((await get(f.pm, '/api/reports/monthly-report/recipients')).status).toBe(403)
    const res = await post(f.pm, '/api/reports/monthly-report/recipients', { teamMemberIds: [f.pmId], emails: [] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Only the account owner/)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM monthly_report_recipients`)).rows[0].n).toBe(0)
  })

  it('refuses a stranger, a bad address, too many addresses, and another company', async () => {
    const f = await seed()
    const other = await seed()
    expect((await post(f.owner, '/api/reports/monthly-report/recipients', { teamMemberIds: [other.pmId], emails: [] })).status).toBe(400)
    expect((await post(f.owner, '/api/reports/monthly-report/recipients', { teamMemberIds: [], emails: ['nope'] })).status).toBe(400)
    const many = Array.from({ length: 21 }, (_, i) => `x${i}@example.org`)
    expect((await post(f.owner, '/api/reports/monthly-report/recipients', { teamMemberIds: [], emails: many })).status).toBe(400)
    expect((await post(f.owner, '/api/reports/monthly-report/recipients', { landlordId: other.lid, teamMemberIds: [], emails: [] })).status).toBe(403)
  })
})

describe('the monthly report email (services/email)', () => {
  it('logs one send to the address with the report\'s category (the PDF rides as an attachment)', async () => {
    const f = await seed()
    const id = await emailMonthlyPropertyReport({
      to: 'cpa@example.org', recipientName: null, companyName: 'Owner <Parks>', monthLabel: 'September 2026',
      rows: [{ name: 'Alpha & Co', charged: 500, received: 500, owed: 0, lateHouseholds: 0 }],
      pdf: Buffer.from('%PDF-1.7'), filename: 'Monthly-report.pdf', reportUrl: null, landlordId: f.lid,
      sendId: '00000000-0000-0000-0000-000000000001',
    })
    expect(id).toBeNull()   // never a real send in tests
    const log = (await db.query(`SELECT to_email, subject, category, status, landlord_id, related_entity_type FROM email_send_log`)).rows
    expect(log).toEqual([expect.objectContaining({
      to_email: 'cpa@example.org', category: 'monthly_property_report', landlord_id: f.lid,
      related_entity_type: 'monthly_report_send', subject: 'Monthly property report — Owner <Parks> — September 2026',
    })])
  })
})
