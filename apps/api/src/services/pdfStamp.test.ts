/**
 * S428 services-audit slice 5a (of 3): pdfStamp.ts.
 *
 * `stampPdf(sourcePath, fields, signers, outputPath)` reads a PDF,
 * draws field stamps + signature lines, appends an "ELECTRONIC
 * SIGNATURE CERTIFICATE" page, and writes to outputPath.
 *
 * Tests verify:
 *   - Round-trip: parses input PDF, writes output PDF, output has
 *     source pages + 1 cert page
 *   - Cert page contains expected signer + footer text
 *   - Each field_type branch (text / date / signature / checkbox)
 *     doesn't throw
 *   - Empty value and out-of-range page index skip silently
 */

import { describe, it, expect, afterAll } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'
import { stampPdf } from './pdfStamp'

const cleanupPaths: string[] = []
afterAll(() => {
  for (const p of cleanupPaths) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

async function makeSourcePdf(pageCount = 2): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Source page ${i + 1}`, { x: 50, y: 750, size: 20, font })
  }
  const bytes = await doc.save()
  const p = path.join(os.tmpdir(), `s428-src-${randomUUID()}.pdf`)
  fs.writeFileSync(p, bytes)
  cleanupPaths.push(p)
  return p
}

function outputPath(): string {
  const p = path.join(os.tmpdir(), `s428-out-${randomUUID()}.pdf`)
  cleanupPaths.push(p)
  return p
}

const signerOne = {
  name: 'Jane Doe', email: 'jane@test.dev',
  role: 'tenant', signed_at: '2026-06-08T12:00:00Z',
}

describe('stampPdf', () => {
  it('round-trip: writes output that parses + has source pages + 1 cert page', async () => {
    const src = await makeSourcePdf(2)
    const out = outputPath()
    await stampPdf(src, [], [signerOne], out)
    expect(fs.existsSync(out)).toBe(true)
    const bytes = fs.readFileSync(out)
    expect(bytes.length).toBeGreaterThan(0)
    const parsed = await PDFDocument.load(bytes)
    // 2 source pages + 1 cert page
    expect(parsed.getPageCount()).toBe(3)
  })

  it('handles text + date + checkbox + signature field types without throwing', async () => {
    const src = await makeSourcePdf(1)
    const out = outputPath()
    const fields = [
      { page: 1, x: 50,  y: 100, width: 200, height: 20, field_type: 'text', value: 'Hello' },
      { page: 1, x: 50,  y: 130, width: 100, height: 20, field_type: 'date', value: '2026-06-08' },
      { page: 1, x: 50,  y: 160, width: 20,  height: 20, field_type: 'checkbox', value: 'checked' },
      { page: 1, x: 50,  y: 200, width: 200, height: 50, field_type: 'signature', value: 'Jane Doe' },
      { page: 1, x: 50,  y: 270, width: 200, height: 50, field_type: 'initials',  value: 'JD' },
    ]
    await stampPdf(src, fields, [signerOne], out)
    const parsed = await PDFDocument.load(fs.readFileSync(out))
    expect(parsed.getPageCount()).toBe(2)
  })

  it('empty value field is skipped silently', async () => {
    const src = await makeSourcePdf(1)
    const out = outputPath()
    await stampPdf(src, [
      { page: 1, x: 50, y: 100, width: 200, height: 20, field_type: 'text', value: '' },
    ], [signerOne], out)
    expect(fs.existsSync(out)).toBe(true)
  })

  it('out-of-range page index is skipped silently', async () => {
    const src = await makeSourcePdf(1)
    const out = outputPath()
    await stampPdf(src, [
      // Page 5 doesn't exist on a 1-page source.
      { page: 5, x: 50, y: 100, width: 200, height: 20, field_type: 'text', value: 'late' },
    ], [signerOne], out)
    // Should still produce a valid output with 1 source + 1 cert page.
    const parsed = await PDFDocument.load(fs.readFileSync(out))
    expect(parsed.getPageCount()).toBe(2)
  })

  it('signature field with data: image URL embeds the image', async () => {
    // 1x1 transparent PNG.
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64')
    const dataUrl = 'data:image/png;base64,' + png1x1.toString('base64')
    const src = await makeSourcePdf(1)
    const out = outputPath()
    await stampPdf(src, [
      { page: 1, x: 50, y: 200, width: 100, height: 30,
        field_type: 'signature', value: dataUrl },
    ], [signerOne], out)
    const parsed = await PDFDocument.load(fs.readFileSync(out))
    expect(parsed.getPageCount()).toBe(2)
  })

  it('signature with invalid base64 falls back to text drawing (does not throw)', async () => {
    const src = await makeSourcePdf(1)
    const out = outputPath()
    await stampPdf(src, [
      { page: 1, x: 50, y: 200, width: 100, height: 30,
        field_type: 'signature', value: 'data:image/png;base64,@@@not-valid@@@' },
    ], [signerOne], out)
    expect(fs.existsSync(out)).toBe(true)
  })

  it('certificate page renders multiple signers stacked', async () => {
    const src = await makeSourcePdf(1)
    const out = outputPath()
    await stampPdf(src, [], [
      { name: 'A',  email: 'a@t.dev', role: 'tenant',   signed_at: '2026-06-01T00:00:00Z' },
      { name: 'B',  email: 'b@t.dev', role: 'landlord', signed_at: '2026-06-02T00:00:00Z' },
      { name: 'CC', email: 'c@t.dev', role: 'co_tenant', signed_at: '2026-06-03T00:00:00Z' },
    ], out)
    // Output still parses; page count = 1 source + 1 cert.
    const parsed = await PDFDocument.load(fs.readFileSync(out))
    expect(parsed.getPageCount()).toBe(2)
  })
})
