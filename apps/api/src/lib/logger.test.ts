/**
 * 10/13 (Nic): "the invite link counts as proof of email." Since that answer a
 * new team member who creates an account from the link is signed straight in
 * (routes/scopes.ts, the accept), so a live team-invitation token is a full
 * sign-in for whoever holds it, for 24 hours. The token rides the path, and the
 * API's daily logs are never deleted (S652). Every request line and every
 * refused write was logged with its path: a 400 for a short password leaves the
 * invitation pending, so a still-good token was written down.
 *
 * Pinned here: the path as logged has ":token" where the token was, in the
 * request line (pino-http), in every line the per-request logger writes, and in
 * the "request rejected (4xx)" line (errorHandler). Nothing here needs the
 * database.
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import pino from 'pino'
import { httpLogger, httpLogSerializers, redactLoggedUrl } from './logger'
import { AppError, errorHandler } from '../middleware/errorHandler'

// The shape of a real one: 32 random bytes as hex (routes/scopes.ts).
const TOKEN = 'e29551b4' + '0123456789abcdef'.repeat(3) + '0123456789abcdef'.slice(0, 8)
const AN_ID = '5f0e8a8e-1a2b-4c3d-9e8f-0123456789ab'

describe('10/13: a live invitation token never reaches the log', () => {
  it('the token is replaced in both invitation paths; the rest of the path is kept', () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(redactLoggedUrl(`/api/invitations/${TOKEN}`)).toBe('/api/invitations/:token')
    expect(redactLoggedUrl(`/api/invitations/${TOKEN}/accept`)).toBe('/api/invitations/:token/accept')
    expect(redactLoggedUrl(`/api/invitations/${TOKEN}?from=email`)).toBe('/api/invitations/:token?from=email')
    // Express routes without regard to case, so the log does too.
    expect(redactLoggedUrl(`/API/Invitations/${TOKEN}/accept`)).toBe('/API/Invitations/:token/accept')
    // The Team page's buttons carry an invitation's id, never its secret: kept,
    // so a press can still be traced.
    expect(redactLoggedUrl(`/api/scopes/invitations/${AN_ID}/resend`)).toBe(`/api/scopes/invitations/${AN_ID}/resend`)
    expect(redactLoggedUrl('/api/scopes/team')).toBe('/api/scopes/team')
    expect(redactLoggedUrl(undefined)).toBeUndefined()
  })

  it("the request line's serializer writes the path without the token", () => {
    expect(httpLogSerializers.req({ id: 'r1', method: 'POST', url: `/api/invitations/${TOKEN}/accept`, headers: { a: 1 } }))
      .toEqual({ id: 'r1', method: 'POST', url: '/api/invitations/:token/accept' })
  })

  it('wired: the per-request logger (every line it writes, and the request line) carries the path without the token', async () => {
    const app = express()
    app.use(httpLogger)
    app.use('/api/invitations', express.Router().get('/:token', (req, res) => {
      // pino's serialized bindings for this request's child logger: what every
      // line written through req.log carries.
      res.json({ bindings: String((req as any).log[pino.symbols.chindingsSym]) })
    }))
    const res = await request(app).get(`/api/invitations/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.bindings).toContain('"url":"/api/invitations/:token"')
    expect(res.body.bindings).not.toContain(TOKEN)
  })

  it('a refused write (errorHandler, "request rejected (4xx)") logs the path without the token', async () => {
    const warn = vi.fn()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { (req as any).log = { warn, error: vi.fn() }; next() })
    app.post('/api/invitations/:token/accept', () => { throw new AppError(400, 'Password must be at least 12 characters.') })
    app.use(errorHandler)
    const res = await request(app).post(`/api/invitations/${TOKEN}/accept`).send({ password: 'short' })
    expect(res.status).toBe(400)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      { status: 400, reason: 'Password must be at least 12 characters.', path: '/api/invitations/:token/accept' },
      'request rejected (4xx)')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })
})
