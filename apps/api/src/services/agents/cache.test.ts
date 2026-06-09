/**
 * LruCache + normalizeQuestion (Step: scale P4).
 */

import { describe, it, expect } from 'vitest'
import { LruCache, normalizeQuestion } from './cache'

describe('normalizeQuestion', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeQuestion('  When   is my\nRENT  due? ')).toBe('when is my rent due?')
  })
})

describe('LruCache', () => {
  it('stores and returns values', () => {
    const c = new LruCache<number>(10, 60_000)
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    expect(c.get('missing')).toBeUndefined()
  })

  it('evicts the least-recently-used when over capacity', () => {
    const c = new LruCache<number>(2, 60_000)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // 'a' is now most-recent
    c.set('c', 3) // evicts 'b' (LRU)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('expires entries past their TTL', () => {
    const c = new LruCache<number>(10, -1) // already-expired TTL
    c.set('a', 1)
    expect(c.get('a')).toBeUndefined()
  })

  it('clear empties the cache', () => {
    const c = new LruCache<number>(10, 60_000)
    c.set('a', 1)
    c.clear()
    expect(c.size).toBe(0)
  })
})
