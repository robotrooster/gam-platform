/**
 * S636 — the screening intake must never silently drop to 'mock'.
 *
 * Nic, opening a screening link: "That link is still showing a six fucking
 * page process before doing the application... It's a whole page just for
 * putting in my fucking address. If I'm doing a background check to look
 * for somewhere to live, why... that address has nothing to do with
 * anything."
 *
 * 'mock' selects GAM's legacy six-step intake — SSN, home address,
 * employment, previous landlord, all on GAM's own form. Under Checkr none
 * of it is sent: the order carries name, email, DOB and the PROPERTY's
 * address, and Checkr collects the rest on its hosted flow.
 *
 * /price decided which form to show and defaulted to 'mock' whenever a
 * landlordId was absent or unrecognised — which is the renter-pool path by
 * definition, and anyone opening the page with a bad id. It also disagreed
 * with /submit, which resolves the pool shell's provider. So an applicant
 * could be asked for an SSN that the placed order would never carry.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

const { shellMock } = vi.hoisted(() => ({ shellMock: vi.fn() }))
vi.mock('../services/poolIntake', async (orig) => ({
  ...(await orig() as any),
  getPoolIntakeShell: shellMock,
}))

import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

const PRIOR_NODE_ENV = process.env.NODE_ENV
beforeEach(async () => {
  await cleanupAllSchema()
  shellMock.mockReset()
  shellMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_screen'
  process.env.NODE_ENV = PRIOR_NODE_ENV
})
// Restore ONLY what this file touches. Replacing process.env wholesale
// dropped JWT_SECRET for every suite that ran afterwards, which surfaced as
// unrelated 401s in the full run and passed fine in isolation.
afterEach(() => { process.env.NODE_ENV = PRIOR_NODE_ENV })

const price = (qs: string) => request(buildApp()).get(`/api/background/price?${qs}`)

describe('screening provider resolution', () => {
  it("uses the named landlord's provider", async () => {
    const c = await db.connect()
    let landlordId: string
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId
      await c.query(`UPDATE landlords SET background_provider='checkr' WHERE id=$1`, [landlordId])
      await c.query('COMMIT')
    } finally { c.release() }

    const res = await price(`landlordId=${landlordId!}`)
    expect(res.status).toBe(200)
    expect(res.body.data.provider).toBe('checkr')
    expect(res.body.data.providerCollectsPii).toBe(true)
  })

  it('falls back to the POOL SHELL, matching what /submit will do', async () => {
    shellMock.mockResolvedValue({ landlordId: randomUUID(), backgroundProvider: 'checkr' })
    const res = await price('landlordId=')
    expect(res.status).toBe(200)
    expect(res.body.data.provider).toBe('checkr')
    expect(res.body.data.providerCollectsPii).toBe(true)
  })

  it('does the same for an unrecognised landlordId rather than showing the SSN form', async () => {
    shellMock.mockResolvedValue({ landlordId: randomUUID(), backgroundProvider: 'checkr' })
    const res = await price(`landlordId=${randomUUID()}`)
    expect(res.status).toBe(200)
    expect(res.body.data.providerCollectsPii).toBe(true)
  })

  it('REFUSES in production rather than dropping to the SSN-collecting intake', async () => {
    process.env.NODE_ENV = 'production'
    shellMock.mockResolvedValue(null)
    const res = await price('landlordId=')
    expect(res.status).toBe(503)
    expect(res.body.success).toBe(false)
  })

  it('still allows mock outside production, for dev', async () => {
    process.env.NODE_ENV = 'test'
    shellMock.mockResolvedValue(null)
    const res = await price('landlordId=')
    expect(res.status).toBe(200)
    expect(res.body.data.provider).toBe('mock')
  })
})
