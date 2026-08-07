/**
 * S582: async auto-field placement jobs. The model call itself is mocked so the
 * test is fast + deterministic — this covers the job lifecycle + scoping.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

vi.mock('./autoFieldPlacement', () => ({
  autoPlaceFields: vi.fn(async () => ({
    pageCount: 2,
    fields: [{ page: 1, x: 10, y: 10, width: 100, height: 20, fieldType: 'signature', signerRole: 'landlord', leaseColumn: 'landlord_signature', label: 'Signature' }],
    modelUsed: true,
  })),
}))

import { createAutoFieldJob, runAutoFieldJob, getAutoFieldJob } from './autoFieldJobs'

const uploadDir = path.join(process.cwd(), 'uploads', 'leases')

async function seedTemplate(landlordId: string, basePdfUrl: string | null): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count, base_pdf_url) VALUES ($1,'T',2,$2) RETURNING id`,
    [landlordId, basePdfUrl])
  return r.rows[0].id
}

async function seedLL(): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    return landlordId
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('auto-field jobs (async)', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('create → run → done, result stored', async () => {
    const landlordId = await seedLL()
    // A real (dummy) file so runAutoFieldJob's fs.existsSync gate passes; the
    // model is mocked so the bytes are never parsed.
    const fname = `test-autofield-${Date.now()}.pdf`
    fs.mkdirSync(uploadDir, { recursive: true })
    fs.writeFileSync(path.join(uploadDir, fname), '%PDF-1.4')
    const tid = await seedTemplate(landlordId, `/api/esign/files/${fname}`)

    const jobId = await createAutoFieldJob(tid, landlordId)
    expect((await getAutoFieldJob(jobId, landlordId))?.status).toBe('processing')

    await runAutoFieldJob(jobId)

    const done = await getAutoFieldJob(jobId, landlordId)
    expect(done?.status).toBe('done')
    expect(done?.result?.fields?.length).toBe(1)
    expect(done?.result?.modelUsed).toBe(true)

    fs.unlinkSync(path.join(uploadDir, fname))
  })

  it('missing PDF → error status, never throws', async () => {
    const landlordId = await seedLL()
    const tid = await seedTemplate(landlordId, `/api/esign/files/does-not-exist-${Date.now()}.pdf`)
    const jobId = await createAutoFieldJob(tid, landlordId)
    await expect(runAutoFieldJob(jobId)).resolves.toBeUndefined()
    const job = await getAutoFieldJob(jobId, landlordId)
    expect(job?.status).toBe('error')
    expect(job?.error).toMatch(/not found/i)
  })

  it('getAutoFieldJob is landlord-scoped', async () => {
    const a = await seedLL()
    const b = await seedLL()
    const tid = await seedTemplate(a, null)
    const jobId = await createAutoFieldJob(tid, a)
    expect(await getAutoFieldJob(jobId, b)).toBeNull()       // not landlord b's job
    expect(await getAutoFieldJob(jobId, a)).not.toBeNull()
  })
})
