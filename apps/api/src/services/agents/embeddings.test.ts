/**
 * embeddings client (Step 3).
 *
 * Pure unit test: global `fetch` is mocked. Asserts batch ordering,
 * dimension validation (the guard against a wrong served model), and
 * the pgvector literal formatter.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { embed, embedBatch, toVectorLiteral } from './embeddings'
import { EMBEDDING_DIM } from './config'

const vec = (fill: number) => Array.from({ length: EMBEDDING_DIM }, () => fill)

function mockEmbeddings(data: Array<{ embedding: number[]; index: number }>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => '',
  } as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('embeddings client', () => {
  beforeEach(() => {
    process.env.EMBEDDINGS_ENDPOINT = 'http://localhost:8081/v1'
    process.env.EMBEDDINGS_MODEL = 'bge-large-en-v1.5'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('embed() posts to /embeddings and returns one vector', async () => {
    const fetchMock = mockEmbeddings([{ embedding: vec(0.1), index: 0 }])
    const v = await embed('hello')

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8081/v1/embeddings')
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.model).toBe('bge-large-en-v1.5')
    expect(sent.input).toEqual(['hello'])
    expect(v).toHaveLength(EMBEDDING_DIM)
  })

  it('embedBatch() returns vectors re-sorted into input order', async () => {
    // endpoint returns them out of order
    mockEmbeddings([
      { embedding: vec(0.2), index: 1 },
      { embedding: vec(0.1), index: 0 },
    ])
    const [a, b] = await embedBatch(['first', 'second'])
    expect(a[0]).toBe(0.1) // index 0
    expect(b[0]).toBe(0.2) // index 1
  })

  it('returns [] for empty input without calling the endpoint', async () => {
    const fetchMock = mockEmbeddings([])
    expect(await embedBatch([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws when a returned vector has the wrong dimension', async () => {
    mockEmbeddings([{ embedding: [1, 2, 3], index: 0 }])
    await expect(embed('x')).rejects.toThrow(/3-dim vector.*expected 1024/)
  })

  it('throws when the count does not match the inputs', async () => {
    mockEmbeddings([{ embedding: vec(0.1), index: 0 }])
    await expect(embedBatch(['a', 'b'])).rejects.toThrow(/returned 1 vectors for 2 inputs/)
  })

  it('toVectorLiteral formats a pgvector literal', () => {
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]')
  })
})
