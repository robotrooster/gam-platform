/**
 * TurnGate — admit up to maxConcurrency, queue the rest, shed past queueMax,
 * and hand released slots to waiters. No leaked slots.
 */

import { describe, it, expect } from 'vitest'
import { TurnGate } from './turnGate'

const cfg = (over = {}) => ({ maxConcurrency: 2, queueMax: 2, queueWaitMs: 10_000, ...over })

describe('TurnGate', () => {
  it('admits up to maxConcurrency immediately', async () => {
    const g = new TurnGate(cfg())
    const a = await g.acquire()
    const b = await g.acquire()
    expect(a).toBeTypeOf('function')
    expect(b).toBeTypeOf('function')
    expect(g.stats().inFlight).toBe(2)
  })

  it('queues beyond maxConcurrency, then sheds beyond queueMax', async () => {
    const g = new TurnGate(cfg())
    await g.acquire() // 1 in flight
    await g.acquire() // 2 in flight (full)
    const w1 = g.acquire() // queued (1)
    const w2 = g.acquire() // queued (2, full)
    const shed = await g.acquire() // queue full -> shed

    expect(shed).toBeNull()
    expect(g.stats().queued).toBe(2)
    // (don't leave w1/w2 dangling for the test runner)
    void w1; void w2
  })

  it('hands a released slot to the next waiter', async () => {
    const g = new TurnGate(cfg({ maxConcurrency: 1, queueMax: 5 }))
    const first = (await g.acquire()) as () => void
    let secondGot = false
    const secondP = g.acquire().then((slot) => { secondGot = slot !== null })

    expect(secondGot).toBe(false) // still queued
    first() // release -> waiter admitted
    await secondP
    expect(secondGot).toBe(true)
    expect(g.stats().inFlight).toBe(1) // the waiter now holds the slot
  })

  it('sheds a waiter whose wait budget elapses', async () => {
    const g = new TurnGate(cfg({ maxConcurrency: 1, queueMax: 5, queueWaitMs: 5 }))
    await g.acquire() // hold the only slot
    const shed = await g.acquire() // must wait, then time out
    expect(shed).toBeNull()
    expect(g.stats().queued).toBe(0) // waiter removed on timeout
  })

  it('release is idempotent (double-release does not over-free)', async () => {
    const g = new TurnGate(cfg({ maxConcurrency: 1, queueMax: 5 }))
    const rel = (await g.acquire()) as () => void
    rel()
    rel()
    expect(g.stats().inFlight).toBe(0)
  })
})
