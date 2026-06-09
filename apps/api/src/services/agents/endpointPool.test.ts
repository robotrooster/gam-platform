/**
 * EndpointPool — least-in-flight routing, failover, and no leaked load.
 */

import { describe, it, expect } from 'vitest'
import { EndpointPool, RetryableEndpointError, isRetryableStatus, getPool, __resetPoolsForTest } from './endpointPool'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('EndpointPool', () => {
  it('runs against the single endpoint and returns the result', async () => {
    const pool = new EndpointPool(['a'])
    expect(await pool.run(async (ep) => `hit:${ep}`)).toBe('hit:a')
    expect(pool.stats()).toEqual({ a: 0 })
  })

  it('routes concurrent calls to different workers (least-in-flight)', async () => {
    const pool = new EndpointPool(['a', 'b'])
    const g1 = deferred<void>()
    const g2 = deferred<void>()
    let used1 = ''
    let used2 = ''
    const p1 = pool.run(async (ep) => { used1 = ep; await g1.promise; return ep })
    const p2 = pool.run(async (ep) => { used2 = ep; await g2.promise; return ep })

    // both in flight on distinct workers
    expect(new Set([used1, used2])).toEqual(new Set(['a', 'b']))
    expect(pool.stats()).toEqual({ a: 1, b: 1 })

    g1.resolve(); g2.resolve()
    await Promise.all([p1, p2])
    expect(pool.stats()).toEqual({ a: 0, b: 0 }) // no leaked load
  })

  it('fails over to another worker on a retryable error', async () => {
    const pool = new EndpointPool(['a', 'b'])
    const seen: string[] = []
    const result = await pool.run(async (ep) => {
      seen.push(ep)
      if (ep === 'a') throw new RetryableEndpointError('a is down')
      return 'ok-on-b'
    })
    expect(result).toBe('ok-on-b')
    expect(seen).toEqual(['a', 'b']) // tried a, failed over to b
    expect(pool.stats()).toEqual({ a: 0, b: 0 })
  })

  it('does NOT fail over on a non-retryable (deterministic) error', async () => {
    const pool = new EndpointPool(['a', 'b'])
    const seen: string[] = []
    await expect(
      pool.run(async (ep) => { seen.push(ep); throw new Error('bad request 400') })
    ).rejects.toThrow('bad request 400')
    expect(seen).toHaveLength(1) // no failover
    expect(pool.stats()).toEqual({ a: 0, b: 0 })
  })

  it('throws the last error when every worker fails retryably', async () => {
    const pool = new EndpointPool(['a', 'b'])
    await expect(
      pool.run(async (ep) => { throw new RetryableEndpointError(`down:${ep}`) })
    ).rejects.toThrow(/down:/)
    expect(pool.stats()).toEqual({ a: 0, b: 0 })
  })

  it('getPool memoizes by endpoint list (preserves in-flight); reset clears it', () => {
    __resetPoolsForTest()
    const p1 = getPool(['x', 'y'])
    const p2 = getPool(['x', 'y'])
    expect(p1).toBe(p2)
    expect(getPool(['x'])).not.toBe(p1)
    __resetPoolsForTest()
    expect(getPool(['x', 'y'])).not.toBe(p1)
  })

  it('classifies retryable HTTP statuses', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true)
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false)
  })
})
