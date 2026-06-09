/**
 * FlexSuite acceptance PDF renderer — sanitizer + render integration.
 *
 * Two surfaces under test:
 *
 *   1. sanitizeForWinAnsi — WinAnsi-incompatible characters that
 *      Helvetica can't encode get replaced with ASCII equivalents
 *      BEFORE the PDF render. S331 caught the right-arrow case in
 *      production (`Read full terms →` blew up mid-render) — this
 *      pins that regression target plus every other char from the
 *      replacement table.
 *
 *   2. renderAcceptancePdf — produced buffer is a valid PDF, the
 *      multi-page pagination kicks in for content beyond one page,
 *      the metadata is set, and the rendered body actually contains
 *      the expected terms text + forensic footer (acceptance id +
 *      sha256 fragment + accepted-at ISO).
 *
 * No DB. Pure-function + pdf-lib smoke. cleanupAllSchema not needed.
 */

import zlib from 'zlib'
import { describe, it, expect } from 'vitest'
import { sanitizeForWinAnsi, renderAcceptancePdf, type FlexsuiteAcceptancePdfContext } from './flexsuitePdf'

// pdf-lib FlateDecode-compresses content streams AND emits drawn text
// as hex strings (`<48656C6C6F> Tj`), not literal `(...)` Tj. To verify
// what the renderer wrote, we (1) inflate every /FlateDecode stream
// and (2) decode each <hex> Tj into its WinAnsi byte sequence.
// Helvetica WinAnsi maps the ASCII range 1:1, so the decoded bytes
// reproduce the original text exactly.
//
// (pdf-parse v2 would be the more natural verifier but triggers a
// pdfjs-dist worker DataCloneError inside Vitest's vite-node loader,
// so we drop down to byte-level inspection.)
function extractDecodedText(buf: Buffer): string {
  const haystack = buf.toString('latin1')
  const streamPattern = /<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g
  const streams: string[] = []
  for (const match of haystack.matchAll(streamPattern)) {
    const dict = match[1] ?? ''
    const body = match[2] ?? ''
    if (!/\/Filter\s*\/FlateDecode/.test(dict)) continue
    try {
      streams.push(zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1'))
    } catch {
      // Some streams may use other filters; skip them.
    }
  }
  const joined = streams.join('\n')
  // Replace each <hex> Tj operator with the decoded text.
  return joined.replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_, hex) => {
    const cleanHex = hex.replace(/\s+/g, '')
    const bytes: number[] = []
    for (let i = 0; i + 1 < cleanHex.length; i += 2) {
      bytes.push(parseInt(cleanHex.slice(i, i + 2), 16))
    }
    return Buffer.from(bytes).toString('latin1')
  })
}

function decodedContains(buf: Buffer, s: string): boolean {
  return extractDecodedText(buf).includes(s)
}

// Page count: pdf-lib puts the per-page "/Type /Page" object headers
// inside a compressed object stream (ObjStm), not in the raw PDF
// bytes. So we count occurrences inside the inflated streams instead.
// The /Pages root uses "/Type /Pages" — negative lookahead excludes it.
function pageCount(buf: Buffer): number {
  return (extractDecodedText(buf).match(/\/Type\s*\/Page(?!s)/g) ?? []).length
}

function baseCtx(overrides: Partial<FlexsuiteAcceptancePdfContext> = {}): FlexsuiteAcceptancePdfContext {
  return {
    product:         'flexpay',
    tenantName:      'Alice Tenant',
    tenantEmail:     'alice@tenant.dev',
    templateVersion: '1.0.0',
    acceptedAt:      new Date('2026-05-20T18:30:00.000Z'),
    contentHash:     'a'.repeat(64),
    renderedText:    'FlexPay Subscription Terms\n\nThis is the populated body.',
    acceptanceId:    '11111111-2222-3333-4444-555555555555',
    ...overrides,
  }
}

describe('sanitizeForWinAnsi', () => {
  it('replaces em-dash with double hyphen', () => {
    expect(sanitizeForWinAnsi('a—b')).toBe('a--b')
  })

  it('replaces en-dash with single hyphen', () => {
    expect(sanitizeForWinAnsi('a–b')).toBe('a-b')
  })

  it('replaces curly single quotes with straight', () => {
    expect(sanitizeForWinAnsi('it’s o‘kay')).toBe("it's o'kay")
  })

  it('replaces curly double quotes with straight', () => {
    expect(sanitizeForWinAnsi('“hello”')).toBe('"hello"')
  })

  it('replaces ellipsis with three dots', () => {
    expect(sanitizeForWinAnsi('wait…')).toBe('wait...')
  })

  it('replaces non-breaking space with regular space', () => {
    expect(sanitizeForWinAnsi('a b')).toBe('a b')
  })

  it('replaces bullet with asterisk', () => {
    expect(sanitizeForWinAnsi('• item')).toBe('* item')
  })

  it('replaces section sign with Sec.', () => {
    expect(sanitizeForWinAnsi('§ 9.1')).toBe('Sec. 9.1')
  })

  // S331 regression target — the right-arrow blew up Helvetica
  // WinAnsi encoding in the rendered terms text.
  it('replaces right arrow with ->', () => {
    expect(sanitizeForWinAnsi('Read full terms →')).toBe('Read full terms ->')
  })

  it('replaces left arrow with <-', () => {
    expect(sanitizeForWinAnsi('← back')).toBe('<- back')
  })

  it('replaces checkmark with [x]', () => {
    expect(sanitizeForWinAnsi('✓ done')).toBe('[x] done')
  })

  it('replaces multiple unicode chars in one pass', () => {
    const input = '§ 5.4 — “FlexPay terms” • Read more →'
    const expected = 'Sec. 5.4 -- "FlexPay terms" * Read more ->'
    expect(sanitizeForWinAnsi(input)).toBe(expected)
  })

  it('passes ASCII through unchanged', () => {
    const input = 'Plain ASCII text 1234 !@#$%^&*()_+-={}[]:;<>,.?/'
    expect(sanitizeForWinAnsi(input)).toBe(input)
  })
})

describe('renderAcceptancePdf', () => {
  it('returns a buffer beginning with the PDF magic bytes', async () => {
    const buf = await renderAcceptancePdf(baseCtx())
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
  })

  it('sets PDF metadata keys in the Info dict', async () => {
    const buf = await renderAcceptancePdf(baseCtx())
    // pdf-lib serializes Title / Author / Subject into the /Info dict
    // as PDFHexString (UTF-16BE with BOM, wrapped in <FEFF...>), which
    // is inside a compressed ObjStm. The key names appear in the
    // inflated stream content — assert the keys are set rather than
    // round-trip the UTF-16BE values.
    const decoded = extractDecodedText(buf)
    expect(decoded).toMatch(/\/Title\s*<FEFF/)
    expect(decoded).toMatch(/\/Author\s*<FEFF/)
    expect(decoded).toMatch(/\/Subject\s*<FEFF/)
  })

  it('embeds the rendered body text', async () => {
    const renderedText = 'Section 1.\n\nThis is a clause body that must appear in the PDF.\n\nSection 2.\n\nAnother clause.'
    const buf = await renderAcceptancePdf(baseCtx({ renderedText }))
    expect(decodedContains(buf, 'Section 1.')).toBe(true)
    expect(decodedContains(buf, 'This is a clause body that must appear in the PDF.')).toBe(true)
    expect(decodedContains(buf, 'Section 2.')).toBe(true)
    expect(decodedContains(buf, 'Another clause.')).toBe(true)
  })

  it('renders header title differently per product', async () => {
    const flexpayBuf = await renderAcceptancePdf(baseCtx({ product: 'flexpay' }))
    const flexdepositBuf = await renderAcceptancePdf(baseCtx({ product: 'flexdeposit' }))
    expect(decodedContains(flexpayBuf, 'FLEXPAY SUBSCRIPTION TERMS')).toBe(true)
    expect(decodedContains(flexdepositBuf, 'FLEXDEPOSIT SERVICE AGREEMENT')).toBe(true)
    // And specifically NOT the other product's header
    expect(decodedContains(flexpayBuf, 'FLEXDEPOSIT SERVICE AGREEMENT')).toBe(false)
    expect(decodedContains(flexdepositBuf, 'FLEXPAY SUBSCRIPTION TERMS')).toBe(false)
  })

  it('embeds the forensic footer (acceptance id, sha256 fragment, accepted-at ISO)', async () => {
    const ctx = baseCtx({
      acceptanceId: 'aabbccdd-eeff-0011-2233-445566778899',
      contentHash:  '1234567890abcdef'.repeat(4),
      acceptedAt:   new Date('2026-05-20T18:30:00.000Z'),
    })
    const buf = await renderAcceptancePdf(ctx)
    // Acceptance id first 8 chars
    expect(decodedContains(buf, 'aabbccdd')).toBe(true)
    // sha256 first 16 chars
    expect(decodedContains(buf, '1234567890abcdef')).toBe(true)
    // ISO timestamp
    expect(decodedContains(buf, '2026-05-20T18:30:00.000Z')).toBe(true)
  })

  it('paginates beyond one page when content exceeds page height', async () => {
    // 200 short paragraphs forces multi-page layout
    const longText = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1} body content line.`).join('\n\n')
    const buf = await renderAcceptancePdf(baseCtx({ renderedText: longText }))
    expect(pageCount(buf)).toBeGreaterThan(1)
    // Content from earliest and latest paragraphs both made it in
    expect(decodedContains(buf, 'Paragraph 1 body content line.')).toBe(true)
    expect(decodedContains(buf, 'Paragraph 200 body content line.')).toBe(true)
  })

  it('single-page render produces exactly one page', async () => {
    const buf = await renderAcceptancePdf(baseCtx({ renderedText: 'Short body.' }))
    expect(pageCount(buf)).toBe(1)
  })

  it('does not throw on unicode chars covered by the sanitizer (S331 regression)', async () => {
    // The exact char that blew up the renderer in S331.
    const renderedText = 'Section 5.4.\n\nFlexPay fee schedule. Read full terms →\n\n§ 9.1 — Continuation clause.'
    const buf = await renderAcceptancePdf(baseCtx({ renderedText }))
    // Sanitizer rewrites `→` to `->` and `—` to `--`; the sanitized
    // form should appear in the rendered text.
    expect(decodedContains(buf, 'Read full terms ->')).toBe(true)
    expect(decodedContains(buf, 'Sec. 9.1 -- Continuation clause.')).toBe(true)
    // And the original unicode chars must NOT appear post-sanitize
    expect(decodedContains(buf, 'Read full terms →')).toBe(false)
  })
})
