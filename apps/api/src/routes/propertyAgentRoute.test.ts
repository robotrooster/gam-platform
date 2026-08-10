/**
 * Public property agent route (S601) — POST /api/property/:slug/agent/chat.
 * Proves the door binds a VISITOR actor hard-scoped to the resolved property,
 * and gates on the published booking site (unknown / disabled slug 404s before
 * the agent ever runs). runAgentSession is mocked — no model, no tools here;
 * the tools' own scope-locking is covered in propertyAgentTools.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

const { runAgentSessionMock } = vi.hoisted(() => ({ runAgentSessionMock: vi.fn() }))
vi.mock('../services/agents/agentSession', () => ({ runAgentSession: runAgentSessionMock }))

import { propertyAgentRouter } from './agent'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/property', propertyAgentRouter)
  app.use(errorHandler)
  return app
}

async function seedPublishedProperty(slug: string, enabled = true): Promise<string> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET public_booking_enabled=$1, booking_slug=$2 WHERE id=$3`,
      [enabled, slug, propertyId])
    await client.query('COMMIT')
    return propertyId
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

beforeEach(async () => {
  await cleanupAllSchema()
  runAgentSessionMock.mockReset()
  runAgentSessionMock.mockResolvedValue({
    reply: 'Hi!', handledBy: { name: 'Skye', tier: 'entry' }, escalations: [], toolInvocations: [],
  })
})

describe('POST /api/property/:slug/agent/chat', () => {
  it('binds a visitor actor hard-scoped to the resolved property', async () => {
    const propertyId = await seedPublishedProperty('park-a')
    const res = await request(buildApp())
      .post('/api/property/park-a/agent/chat')
      .send({ message: 'how much is a pull-through?' })
    expect(res.status).toBe(200)
    expect(res.body.data.reply).toBe('Hi!')
    const arg = runAgentSessionMock.mock.calls[0][0]
    expect(arg.audience).toBe('visitor')
    expect(arg.actor.role).toBe('visitor')
    expect(arg.actor.propertyId).toBe(propertyId)
    expect(arg.actor.profileId).toBe(propertyId)
  })

  it('404s an unknown slug BEFORE running the agent', async () => {
    const res = await request(buildApp())
      .post('/api/property/does-not-exist/agent/chat')
      .send({ message: 'hi' })
    expect(res.status).toBe(404)
    expect(runAgentSessionMock).not.toHaveBeenCalled()
  })

  it('404s a property whose booking site is disabled', async () => {
    await seedPublishedProperty('park-off', false)
    const res = await request(buildApp())
      .post('/api/property/park-off/agent/chat')
      .send({ message: 'hi' })
    expect(res.status).toBe(404)
    expect(runAgentSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an empty message', async () => {
    await seedPublishedProperty('park-a')
    const res = await request(buildApp())
      .post('/api/property/park-a/agent/chat')
      .send({ message: '' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(runAgentSessionMock).not.toHaveBeenCalled()
  })
})
