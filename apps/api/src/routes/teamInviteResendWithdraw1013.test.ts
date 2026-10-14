/**
 * 10/13 evening (Nic): "team invites expire after 24 HOURS (fix the email that
 * says 7 days). Add RESEND and WITHDRAW buttons on each pending invitation
 * (Team page)."
 *
 * The buttons call POST /api/scopes/invitations/:id/resend and /revoke. Pinned
 * here, on the real routes:
 *   - Resend: a brand-new link that works for 24 hours from now; the old link
 *     stops working; the email goes to the invitation's own address. It works
 *     on a pending invitation whose link has already lapsed, too.
 *   - Withdraw: the link stops working and says "withdrawn"; the row leaves
 *     the Team page's pending list.
 *   - An owner of two companies (Nic: Oak Park and Mountain View) can press
 *     both on either company's invitation — the button names no company, and
 *     the routes used to ask "which one?".
 *   - Another company's invitation is not found; a non-pending one is told in
 *     plain words; a Withdraw racing the invitee's Create account never stamps
 *     "withdrawn" on an invitation that was accepted.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { TEAM_INVITATION_TTL_HOURS } from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedManager, seedProperty } from '../test/dbHelpers'

const { emailInvitationMock } = vi.hoisted(() => ({
  emailInvitationMock: vi.fn(async (..._args: any[]) => 'msg_invitation_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailInvitation: emailInvitationMock,
    emailLoginCode: vi.fn(async () => 'msg_code_mock'),
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: vi.fn(async () => undefined) }
})

import { scopesRouter, invitationsRouter } from './scopes'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailInvitationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite_resend'
})

const HOUR_MS = 60 * 60 * 1000
const NEW_ACCOUNT = { password: 'her_own_pw_1013', firstName: 'Kay', lastName: 'Keeper' }

/** The token from the last invitation email's link — the only place it goes. */
function tokenFromEmail(): string {
  const calls = emailInvitationMock.mock.calls
  return String(calls[calls.length - 1]?.[3] ?? '').split('/').pop() ?? ''
}

interface Company { landlordId: string; park: string }
interface Owner { userId: string; token: string; companies: Company[] }

/** An owner account with `n` companies, each with one park. */
async function seedOwner(n = 1): Promise<Owner> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const companies: Company[] = []
    for (let i = 0; i < n; i++) {
      const id = i === 0 ? landlordId
        : (await c.query<{ id: string }>(
            `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])).rows[0].id
      companies.push({ landlordId: id, park: await seedProperty(c, { landlordId: id, ownerUserId: userId, managedByUserId: userId }) })
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'owner@test.dev', profileId: null, landlordIds: companies.map(x => x.landlordId), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, token, companies }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function invite(o: Owner, company: Company, email: string): Promise<{ id: string; token: string }> {
  const res = await request(buildApp())
    .post('/api/scopes/maintenance/invite')
    .set('Authorization', `Bearer ${o.token}`)
    .send({ email, scope: { propertyIds: [company.park], unitIds: [], jobCategories: [], allProperties: false } })
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { id: res.body.data.id, token: tokenFromEmail() }
}

const resend = (o: { token: string }, id: string) =>
  request(buildApp()).post(`/api/scopes/invitations/${id}/resend`).set('Authorization', `Bearer ${o.token}`).send({})
const withdraw = (o: { token: string }, id: string) =>
  request(buildApp()).post(`/api/scopes/invitations/${id}/revoke`).set('Authorization', `Bearer ${o.token}`).send({})
const teamList = async (o: Owner) =>
  (await request(buildApp()).get('/api/scopes/team').set('Authorization', `Bearer ${o.token}`)).body.data.invitations as any[]
const row = async (id: string) =>
  (await db.query<{ status: string; token: string; expires_at: Date }>(`SELECT status, token, expires_at FROM invitations WHERE id = $1`, [id])).rows[0]
/**
 * 10/13 review: hold the invitation row as the accept does (FOR UPDATE), press
 * a button, wait until its request is blocked on that row, then finish the
 * accept (status 'accepted') and let the button go on. The button's answer.
 */
async function whileAcceptHoldsRow(id: string, press: () => request.Test): Promise<request.Response> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SELECT 1 FROM invitations WHERE id = $1 FOR UPDATE`, [id])
    let answered = false
    const pressed = press().then(r => { answered = true; return r })
    const until = Date.now() + 5000
    for (;;) {
      const waiting = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n
      if (waiting > 0) break
      if (answered || Date.now() > until) throw new Error('the button never waited for the invitation row')
      await new Promise(r => setTimeout(r, 20))
    }
    expect(answered).toBe(false)
    await c.query(`UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1`, [id])
    await c.query('COMMIT')
    return await pressed
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    c.release()
  }
}
const eventsOf = async (id: string) =>
  (await db.query<{ event_type: string; actor_user_id: string | null }>(
    `SELECT event_type, actor_user_id FROM platform_events WHERE subject_id = $1 ORDER BY created_at`, [id])).rows

describe('10/13: Resend gives a fresh 24-hour link', () => {
  it('a new link that works for 24 hours from now; the old link stops working; sent to the invitation\'s own address', async () => {
    const o = await seedOwner()
    const email = `rs-${randomUUID().slice(0, 8)}@test.dev`
    const { id, token: oldToken } = await invite(o, o.companies[0], email)
    // The first link, as sent: 24 hours.
    const sent = (await row(id)).expires_at.getTime()
    expect(Math.abs(sent - (Date.now() + TEAM_INVITATION_TTL_HOURS * HOUR_MS))).toBeLessThan(60_000)
    expect(TEAM_INVITATION_TTL_HOURS).toBe(24)

    // An hour later (the clock moved back on the row), the owner presses Resend.
    await db.query(`UPDATE invitations SET expires_at = expires_at - INTERVAL '1 hour', created_at = created_at - INTERVAL '1 hour' WHERE id = $1`, [id])
    const res = await resend(o, id)
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('token')
    expect(res.body.data.status).toBe('pending')

    const newToken = tokenFromEmail()
    expect(newToken).toMatch(/^[0-9a-f]{64}$/)
    expect(newToken).not.toBe(oldToken)
    const after = await row(id)
    expect(after.token).toBe(newToken)
    expect(Math.abs(after.expires_at.getTime() - (Date.now() + 24 * HOUR_MS))).toBeLessThan(60_000)
    const call = emailInvitationMock.mock.calls[emailInvitationMock.mock.calls.length - 1]!
    expect(call[0]).toBe(email)
    expect(call[2]).toBe('maintenance')
    expect(call[4]).toMatchObject({ resend: true, invitationId: id, landlordId: o.companies[0].landlordId })

    // The old link is dead; the new one opens the form.
    expect((await request(buildApp()).get(`/api/invitations/${oldToken}`)).status).toBe(404)
    expect((await request(buildApp()).post(`/api/invitations/${oldToken}/accept`).send(NEW_ACCOUNT)).status).toBe(404)
    expect((await request(buildApp()).get(`/api/invitations/${newToken}`)).body.data).toMatchObject({ status: 'pending', expired: false })
    expect(await eventsOf(id)).toEqual([
      { event_type: 'invitation.created', actor_user_id: o.userId },
      { event_type: 'invitation.resent', actor_user_id: o.userId },
      // the new link opened just above (the dead one logs nothing)
      { event_type: 'invitation.viewed', actor_user_id: null },
    ])
  })

  it('a lapsed link (still listed until the hourly sweep) is shown as expired, and Resend brings it back for 24 hours', async () => {
    const o = await seedOwner()
    const email = `lapsed-${randomUUID().slice(0, 8)}@test.dev`
    const { id, token: oldToken } = await invite(o, o.companies[0], email)
    expect((await teamList(o)).map(i => [i.id, i.expired])).toEqual([[id, false]])

    await db.query(`UPDATE invitations SET expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [id])
    expect((await teamList(o)).map(i => [i.id, i.expired])).toEqual([[id, true]])
    expect((await request(buildApp()).get(`/api/invitations/${oldToken}`)).body.data).toMatchObject({ expired: true })

    const res = await resend(o, id)
    expect(res.status).toBe(200)
    expect((await teamList(o)).map(i => [i.id, i.expired])).toEqual([[id, false]])
    // She uses the new link and is signed straight in.
    const accepted = await request(buildApp()).post(`/api/invitations/${tokenFromEmail()}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toMatchObject({ role: 'maintenance', signedIn: true })
  })
})

describe('10/13: Withdraw', () => {
  it('the link stops working and says withdrawn; the row leaves the pending list', async () => {
    const o = await seedOwner()
    const { id, token } = await invite(o, o.companies[0], `wd-${randomUUID().slice(0, 8)}@test.dev`)
    const res = await withdraw(o, id)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'revoked', revoked_by_user_id: o.userId })
    expect(res.body.data).not.toHaveProperty('token')

    expect(await teamList(o)).toEqual([])
    expect((await request(buildApp()).get(`/api/invitations/${token}`)).body.data.status).toBe('revoked')
    const accept = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accept.status).toBe(400)
    expect(accept.body.error).toMatch(/withdrawn/)
    expect(await eventsOf(id)).toEqual([
      { event_type: 'invitation.created', actor_user_id: o.userId },
      { event_type: 'invitation.revoked', actor_user_id: o.userId },
    ])
    // Nothing was emailed for the withdrawal.
    expect(emailInvitationMock).toHaveBeenCalledTimes(1)
  })
})

describe('10/13: an owner of two companies presses either button on either company\'s invitation', () => {
  it('Resend and Withdraw work on the second company\'s invitation without naming a company', async () => {
    const o = await seedOwner(2)
    const [first, second] = o.companies
    const a = await invite(o, first, `a-${randomUUID().slice(0, 8)}@test.dev`)
    const b = await invite(o, second, `b-${randomUUID().slice(0, 8)}@test.dev`)
    const listed = await teamList(o)
    // (snake_case here: the camelizing layer is index.ts's, not this test app's)
    expect(listed.map(i => i.landlord_id).sort()).toEqual([first.landlordId, second.landlordId].sort())

    const r = await resend(o, b.id)
    expect(r.status).toBe(200)
    // The email names the invitation's own company.
    expect(emailInvitationMock.mock.calls[emailInvitationMock.mock.calls.length - 1]![4]).toMatchObject({ landlordId: second.landlordId })

    const w = await withdraw(o, a.id)
    expect(w.status).toBe(200)
    expect((await row(a.id)).status).toBe('revoked')
    expect((await row(b.id)).status).toBe('pending')
  })

  // 10/13 review: the same address may be invited to both companies (one
  // pending invitation per company, role and address); the rows looked alike
  // and Withdraw named only the email. Each row now says its company.
  it('the same address invited to both companies: two rows, each naming its own company', async () => {
    const o = await seedOwner(2)
    const [first, second] = o.companies
    await db.query(`UPDATE landlords SET business_name = 'Oak Park' WHERE id = $1`, [first.landlordId])
    await db.query(`UPDATE landlords SET business_name = 'Mountain View' WHERE id = $1`, [second.landlordId])
    const email = `both-${randomUUID().slice(0, 8)}@test.dev`
    const a = await invite(o, first, email)
    const b = await invite(o, second, email)

    const listed = await teamList(o)
    expect(listed.map(i => [i.id, i.email, i.landlord_id, i.company_name]).sort()).toEqual([
      [a.id, email, first.landlordId, 'Oak Park'],
      [b.id, email, second.landlordId, 'Mountain View'],
    ].sort())
    // Still never the secret.
    expect(JSON.stringify(listed)).not.toContain(a.token)
    expect(JSON.stringify(listed)).not.toContain(b.token)
  })
})

describe('10/13: what the buttons may not do', () => {
  it("another company's invitation is not found by either button, and nothing changes", async () => {
    const mine = await seedOwner()
    const theirs = await seedOwner()
    const { id, token } = await invite(theirs, theirs.companies[0], `x-${randomUUID().slice(0, 8)}@test.dev`)
    emailInvitationMock.mockClear()

    expect((await resend(mine, id)).status).toBe(404)
    expect((await withdraw(mine, id)).status).toBe(404)
    const after = await row(id)
    expect(after).toMatchObject({ status: 'pending', token })
    expect(emailInvitationMock).not.toHaveBeenCalled()
    // A made-up id is not found either (not a 500).
    expect((await resend(mine, 'not-an-id')).status).toBe(404)
    expect((await withdraw(mine, 'not-an-id')).status).toBe(404)
  })

  it('a manager with the team permission works their own company\'s invitations; without it, neither button', async () => {
    const o = await seedOwner()
    const company = o.companies[0]
    const mgr = async (perms: Record<string, boolean>) => {
      const c = await db.connect()
      try {
        const userId = await seedManager(c)
        await c.query(
          `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
           VALUES ($1, $2, '{}', '{}', TRUE, $3)`, [userId, company.landlordId, JSON.stringify(perms)])
        return { token: jwt.sign({ userId, role: 'property_manager', email: 'm@test.dev', profileId: userId, landlordId: company.landlordId, permissions: perms },
          process.env.JWT_SECRET!, { expiresIn: '1h' }) }
      } finally { c.release() }
    }
    const { id } = await invite(o, company, `m-${randomUUID().slice(0, 8)}@test.dev`)
    const without = await mgr({ 'team.manage_permissions': true })
    expect((await resend(without, id)).status).toBe(403)
    expect((await withdraw(without, id)).status).toBe(403)

    const withPerm = await mgr({ 'team.invite': true })
    expect((await resend(withPerm, id)).status).toBe(200)
    expect((await withdraw(withPerm, id)).status).toBe(200)
  })

  it('an accepted invitation: both buttons say so in plain words, and the person stays on the team', async () => {
    const o = await seedOwner()
    const { id, token } = await invite(o, o.companies[0], `acc-${randomUUID().slice(0, 8)}@test.dev`)
    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    emailInvitationMock.mockClear()

    const r = await resend(o, id)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe("They've already accepted this invitation and are on your team.")
    const w = await withdraw(o, id)
    expect(w.status).toBe(400)
    expect(w.body.error).toBe("They've already accepted this invitation and are on your team.")
    expect((await row(id)).status).toBe('accepted')
    expect((await db.query(`SELECT 1 FROM maintenance_worker_scopes WHERE user_id = $1`, [accepted.body.data.userId])).rows).toHaveLength(1)
    expect(emailInvitationMock).not.toHaveBeenCalled()
  })

  it('a swept (expired) invitation: Resend says to send a new one, Withdraw says its link is already dead', async () => {
    const o = await seedOwner()
    const { id } = await invite(o, o.companies[0], `sw-${randomUUID().slice(0, 8)}@test.dev`)
    await db.query(`UPDATE invitations SET status = 'expired', expires_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [id])
    const r = await resend(o, id)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('This invitation has expired. Send them a new one from the invite form.')
    const w = await withdraw(o, id)
    expect(w.status).toBe(400)
    expect(w.body.error).toBe('This invitation has already expired, so its link no longer works.')
    expect((await row(id)).status).toBe('expired')
  })

  // 10/13 review: the race above lands either way at random, so it can pass
  // without the row lock whenever the two do not overlap. These hold the
  // invitation row as the invitee's Create account does (FOR UPDATE), press
  // the button, see it wait for the row, then let the accept finish. Without
  // the lock the button read "pending" before the accept committed and wrote
  // over "accepted" (Withdraw) or mailed a link for it (Resend).
  it("Withdraw pressed while the invitee's Create account holds the row: it waits, then says she's on the team; never \"withdrawn\" on an accepted invitation", async () => {
    const o = await seedOwner()
    const { id } = await invite(o, o.companies[0], `held-${randomUUID().slice(0, 8)}@test.dev`)
    const res = await whileAcceptHoldsRow(id, () => withdraw(o, id))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("They've already accepted this invitation and are on your team.")
    expect((await row(id)).status).toBe('accepted')
    expect(await eventsOf(id)).toEqual([{ event_type: 'invitation.created', actor_user_id: o.userId }])
  })

  it("Resend pressed while the invitee's Create account holds the row: it waits, then says she's on the team; no new link is made or mailed", async () => {
    const o = await seedOwner()
    const { id, token } = await invite(o, o.companies[0], `held-rs-${randomUUID().slice(0, 8)}@test.dev`)
    emailInvitationMock.mockClear()
    const res = await whileAcceptHoldsRow(id, () => resend(o, id))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("They've already accepted this invitation and are on your team.")
    expect(await row(id)).toMatchObject({ status: 'accepted', token })
    expect(emailInvitationMock).not.toHaveBeenCalled()
    expect(await eventsOf(id)).toEqual([{ event_type: 'invitation.created', actor_user_id: o.userId }])
  })

  it('Withdraw racing the invitee\'s Create account: one of them wins, never both', async () => {
    for (let i = 0; i < 3; i++) {
      await cleanupAllSchema()
      const o = await seedOwner()
      const { id, token } = await invite(o, o.companies[0], `race-${randomUUID().slice(0, 8)}@test.dev`)
      const [acc, wd] = await Promise.all([
        request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT),
        withdraw(o, id),
      ])
      const final = (await row(id)).status
      const onTeam = (await db.query(`SELECT 1 FROM maintenance_worker_scopes`)).rows.length
      if (acc.status === 200) {
        expect(wd.status).toBe(400)
        expect(wd.body.error).toMatch(/already accepted/)
        expect(final).toBe('accepted')
        expect(onTeam).toBe(1)
      } else {
        expect(wd.status).toBe(200)
        expect(acc.status).toBe(400)
        expect(acc.body.error).toMatch(/withdrawn/)
        expect(final).toBe('revoked')
        expect(onTeam).toBe(0)
      }
    }
  })
})
