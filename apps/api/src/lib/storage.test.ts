/**
 * Driver contract test (GCP migration Phase A1). The same assertions run
 * against every driver so local and gcs can never drift. The gcs side runs
 * only when GCS_TEST_BUCKET is set (never in CI) — the contract itself is
 * what's under test here, on the local driver.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createLocalDriver, createGcsDriver, StorageNotFoundError, isValidKey,
  uploadKeyFromStored, newStoredFilename, type StorageDriver,
} from './storage'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-storage-test-'))
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })

function contract(name: string, makeDriver: () => StorageDriver) {
  describe(`${name} driver contract`, () => {
    const d = makeDriver()

    it('save → exists → open round-trips bytes and size', async () => {
      await d.save('docs/a.txt', Buffer.from('hello'))
      expect(await d.exists('docs/a.txt')).toBe(true)
      const { stream, size } = await d.open('docs/a.txt')
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('hello')
      expect(size).toBe(5)
    })

    it('supports multi-segment keys (business-attachments/<id>/<file>)', async () => {
      await d.save('business-attachments/biz-1/f.bin', Buffer.from('x'))
      expect(await d.exists('business-attachments/biz-1/f.bin')).toBe(true)
    })

    it('open of a missing key throws StorageNotFoundError', async () => {
      await expect(d.open('docs/nope.txt')).rejects.toBeInstanceOf(StorageNotFoundError)
    })

    it('exists is false for a missing key', async () => {
      expect(await d.exists('docs/nope.txt')).toBe(false)
    })

    it('remove is idempotent', async () => {
      await d.save('docs/gone.txt', Buffer.from('x'))
      await d.remove('docs/gone.txt')
      expect(await d.exists('docs/gone.txt')).toBe(false)
      await expect(d.remove('docs/gone.txt')).resolves.toBeUndefined()
    })

    it('move relocates across subdirs (the leaseParser promote)', async () => {
      await d.save('lease-pdfs-pending/m.pdf', Buffer.from('pdf'))
      await d.move('lease-pdfs-pending/m.pdf', 'leases/m.pdf')
      expect(await d.exists('lease-pdfs-pending/m.pdf')).toBe(false)
      expect(await d.exists('leases/m.pdf')).toBe(true)
    })

    it('saveFromFile consumes the staged temp file', async () => {
      const tmp = path.join(os.tmpdir(), `stage-${Date.now()}.bin`)
      fs.writeFileSync(tmp, 'staged')
      await d.saveFromFile(tmp, 'inspection-videos/v.bin')
      expect(await d.exists('inspection-videos/v.bin')).toBe(true)
      expect(fs.existsSync(tmp)).toBe(false)
    })

    it('range read returns the requested slice', async () => {
      await d.save('docs/range.txt', Buffer.from('0123456789'))
      const { stream } = await d.open('docs/range.txt', { start: 2, end: 5 })
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('2345')
    })

    it('rejects traversal and malformed keys', async () => {
      for (const bad of ['../etc/passwd', 'docs/../../x', '/abs', 'a\\b', 'docs//x', '']) {
        await expect(d.save(bad, Buffer.from('x'))).rejects.toThrow()
      }
    })
  })
}

contract('local', () => createLocalDriver(tmpRoot))
// The gcs side of the contract needs real credentials + a scratch bucket, so
// it never runs in CI — set GCS_TEST_BUCKET locally (with ADC) to exercise it.
if (process.env.GCS_TEST_BUCKET) {
  contract('gcs', () => createGcsDriver(process.env.GCS_TEST_BUCKET!))
}

describe('key helpers', () => {
  it('uploadKeyFromStored: API url, legacy /uploads/ url, bare filename all yield subdir/basename', () => {
    expect(uploadKeyFromStored('leases', '/api/esign/files/x.pdf')).toBe('leases/x.pdf')
    expect(uploadKeyFromStored('docs', '/uploads/docs/y.pdf')).toBe('docs/y.pdf')
    expect(uploadKeyFromStored('avatars', 'z.png')).toBe('avatars/z.png')
  })
  it('uploadKeyFromStored: null/malformed → null, never throws', () => {
    expect(uploadKeyFromStored('docs', null)).toBeNull()
    expect(uploadKeyFromStored('docs', '')).toBeNull()
    expect(uploadKeyFromStored('docs', 'evil name!.pdf')).toBeNull()
    // basename() defuses traversal; the remaining name must pass the charset guard
    expect(uploadKeyFromStored('docs', '../../etc/passwd')).toBe('docs/passwd')
  })
  it('isValidKey rules', () => {
    expect(isValidKey('docs/a.pdf')).toBe(true)
    expect(isValidKey('business-attachments/b1/f.bin')).toBe(true)
    expect(isValidKey('../x')).toBe(false)
    expect(isValidKey('/abs')).toBe(false)
    expect(isValidKey('a//b')).toBe(false)
  })
  it('newStoredFilename keeps a safe extension', () => {
    expect(newStoredFilename('lease v2.PDF')).toMatch(/^\d+-[0-9a-f]{16}\.pdf$/)
    expect(newStoredFilename('noext')).toMatch(/^\d+-[0-9a-f]{16}$/)
  })
})
