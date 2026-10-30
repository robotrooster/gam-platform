/**
 * sendStoredFile's headers (10/29, Nic's review). A stored file is never
 * rendered as a page: Content-Type comes from our own list, nosniff is always
 * set, and anything else — a legacy .html among them — downloads. Runs on
 * the local driver's res.sendFile fast path, which is the one that had no
 * nosniff. No database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-serve-test-'))
let app: express.Express

beforeAll(async () => {
  process.env.UPLOADS_ROOT = root
  const { sendStoredFile } = await import('./storage')
  fs.mkdirSync(path.join(root, 'id-documents'))
  fs.writeFileSync(path.join(root, 'id-documents', 'old.html'), '<script>alert(1)</script>')
  fs.writeFileSync(path.join(root, 'id-documents', 'scan.png'), 'png')
  app = express()
  app.get('/f/:name', async (req, res, next) => {
    try {
      await sendStoredFile(res, `id-documents/${req.params.name}`, {
        stripEmbedBlockers: true,
        mimeType: (req.query.type as string) || undefined,
      })
    } catch (e) { next(e) }
  })
})
afterAll(() => {
  delete process.env.UPLOADS_ROOT
  fs.rmSync(root, { recursive: true, force: true })
})

describe('sendStoredFile', () => {
  it('serves a stored .html as a download, never as a page', async () => {
    const res = await request(app).get('/f/old.html')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(res.headers['content-disposition']).toMatch(/^attachment/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
  it('serves an image inline with its own type and nosniff', async () => {
    const res = await request(app).get('/f/scan.png')
    expect(res.headers['content-type']).toMatch(/^image\/png/)
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
  it('ignores a caller type that is not one we serve', async () => {
    const res = await request(app).get('/f/scan.png?type=text/html')
    expect(res.headers['content-type']).toMatch(/^image\/png/)
  })
})
