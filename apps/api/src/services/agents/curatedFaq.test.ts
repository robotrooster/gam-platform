/**
 * matchCuratedFaq — semantic match with a high confidence threshold, and
 * audience scoping. Embeddings are mocked so we control similarity.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./embeddings', () => ({ embed: vi.fn() }))
vi.mock('./cache', () => ({ normalizeQuestion: (s: string) => s.toLowerCase() }))

import { embed } from './embeddings'
import { matchCuratedFaq, CURATED_FAQ, __resetFaqForTest } from './curatedFaq'

const mockEmbed = embed as unknown as ReturnType<typeof vi.fn>

// Build a unit vector that is `sim` cosine-similar to a reference axis.
const axis = (which: number, sim: number) => {
  const v = new Array(8).fill(0)
  v[which] = sim
  v[7] = Math.sqrt(Math.max(0, 1 - sim * sim)) // orthogonal remainder
  return v
}

describe('matchCuratedFaq', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetFaqForTest()
  })

  it('returns the approved answer on a high-confidence match', async () => {
    // Every curated question embeds to axis 0; the user question embeds
    // 0.95-similar to axis 0 → clears the 0.85 threshold.
    mockEmbed.mockImplementation(async (text: string) => {
      const isUser = text.includes('?') && text === text.toLowerCase()
      return isUser ? axis(0, 0.95) : axis(0, 1)
    })
    const ans = await matchCuratedFaq('tenant', 'when is rent due?')
    expect(ans).toBeTypeOf('string')
    expect(ans!.length).toBeGreaterThan(0)
  })

  it('returns null when nothing clears the threshold', async () => {
    // user question is near-orthogonal to all curated questions
    mockEmbed.mockImplementation(async (text: string) => (text === text.toLowerCase() && text.includes('?') ? axis(3, 0.2) : axis(0, 1)))
    expect(await matchCuratedFaq('tenant', 'totally unrelated question?')).toBeNull()
  })

  it('does not match a tenant question to a landlord-only entry', async () => {
    // Force a perfect match on ALL entries; only a tenant-or-shared answer may return.
    mockEmbed.mockResolvedValue(axis(0, 1))
    const ans = await matchCuratedFaq('tenant', 'anything')
    // the returned answer must come from a tenant/shared entry
    const tenantAnswers = CURATED_FAQ.filter((e) => e.audience !== 'landlord').map((e) => e.answer)
    expect(tenantAnswers).toContain(ans)
  })
})
