/**
 * Knowledge ingestion — chunker (pure) + ingestArticle orchestration.
 * No DB / no model: knowledge.ts is mocked.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./knowledge', () => ({
  indexChunk: vi.fn().mockResolvedValue('id'),
  deleteChunksBySource: vi.fn().mockResolvedValue(0),
}))

import { chunkText, ingestArticle } from './knowledgeIngest'
import { indexChunk, deleteChunksBySource } from './knowledge'
import { parseArticle } from './ingestKnowledge'

describe('chunkText', () => {
  it('keeps a short article as one chunk', () => {
    expect(chunkText('One short paragraph.')).toEqual(['One short paragraph.'])
  })

  it('packs paragraphs up to the target, then splits', () => {
    const para = 'x'.repeat(500)
    const chunks = chunkText([para, para, para].join('\n\n'), 900)
    // 500+500 > 900 → first chunk one para, etc.
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(1400))
  })

  it('hard-splits a single paragraph that exceeds the max length', () => {
    // One paragraph (no blank lines) well over MAX_CHARS (1400).
    const big = Array.from({ length: 120 }, (_, i) => `Sentence number ${i}.`).join(' ')
    expect(big.length).toBeGreaterThan(1400)
    const chunks = chunkText(big, 300)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('drops empty/whitespace paragraphs (and packs the short remainder)', () => {
    // 'a' and 'b' are tiny, so they pack into one chunk; the blank/space
    // paragraph between them is dropped.
    expect(chunkText('a\n\n\n\n   \n\nb')).toEqual(['a\n\nb'])
  })
})

describe('ingestArticle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes prior chunks for the source, then indexes title-prefixed chunks', async () => {
    ;(deleteChunksBySource as any).mockResolvedValue(3)
    const res = await ingestArticle({
      scope: 'tenant',
      source: 'tenant/rent.md',
      title: 'Paying rent',
      body: 'First para about rent.\n\nSecond para about due dates.',
    })

    expect(deleteChunksBySource).toHaveBeenCalledWith('tenant/rent.md')
    expect(res).toEqual({ source: 'tenant/rent.md', deleted: 3, inserted: 1 })
    // single chunk (short), prefixed with the title, scoped + sourced
    const call = (indexChunk as any).mock.calls[0][0]
    expect(call.scope).toBe('tenant')
    expect(call.source).toBe('tenant/rent.md')
    expect(call.content.startsWith('Paying rent\n\n')).toBe(true)
    expect(call.metadata).toMatchObject({ chunkIndex: 0, chunkCount: 1 })
  })
})

describe('parseArticle', () => {
  it('parses frontmatter scope/title + body', () => {
    const a = parseArticle('---\nscope: tenant\ntitle: Paying rent\n---\nBody line one.\n\nBody line two.')
    expect(a).toEqual({ scope: 'tenant', title: 'Paying rent', body: 'Body line one.\n\nBody line two.' })
  })

  it('rejects an invalid scope', () => {
    expect(() => parseArticle('---\nscope: nope\ntitle: X\n---\nbody')).toThrow(/invalid scope/)
  })

  it('rejects missing frontmatter', () => {
    expect(() => parseArticle('no frontmatter here')).toThrow(/frontmatter/)
  })
})
