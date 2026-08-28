/**
 * S628 — the queue behaves like a queue.
 *
 * The behaviour being pinned is the one that was missing when the model server
 * aborted four times in an hour: too many people at once should make everybody
 * wait, not take the machine down and lose every conversation in flight.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { withConcurrencySlot, gateStats, queuePositionMessage, __resetGate } from './concurrencyGate'

const defer = () => {
  let release!: () => void
  const p = new Promise<void>((r) => { release = r })
  return { p, release }
}

beforeEach(() => {
  __resetGate()
  process.env.AGENT_MAX_CONCURRENT = '2'
})

describe('the concurrency gate', () => {
  it('runs up to the limit at once', async () => {
    const a = defer(), b = defer()
    let started = 0
    void withConcurrencySlot(async () => { started++; await a.p })
    void withConcurrencySlot(async () => { started++; await b.p })
    await new Promise((r) => setImmediate(r))
    expect(started).toBe(2)
    a.release(); b.release()
  })

  it('makes the next one WAIT rather than refusing it', async () => {
    // The whole point. A tenant told "try again later" is a tenant who does not
    // pay their rent tonight.
    const a = defer(), b = defer()
    let thirdStarted = false
    void withConcurrencySlot(async () => { await a.p })
    void withConcurrencySlot(async () => { await b.p })
    const third = withConcurrencySlot(async () => { thirdStarted = true; return 'done' })
    await new Promise((r) => setImmediate(r))
    expect(thirdStarted).toBe(false)
    expect(gateStats().waiting).toBe(1)

    a.release()
    await expect(third).resolves.toBe('done')
    expect(thirdStarted).toBe(true)
    b.release()
  })

  it('tells the caller where they are, so what they are told is true', async () => {
    const a = defer(), b = defer()
    const positions: number[] = []
    void withConcurrencySlot(async () => { await a.p })
    void withConcurrencySlot(async () => { await b.p })
    void withConcurrencySlot(async () => {}, (n) => positions.push(n))
    void withConcurrencySlot(async () => {}, (n) => positions.push(n))
    await new Promise((r) => setImmediate(r))
    expect(positions).toEqual([1, 2])
    a.release(); b.release()
  })

  it('frees the slot when a generation throws — one bad turn is not an outage', async () => {
    // Without the finally, a single failed generation wedges the queue shut and
    // everybody behind it waits forever. That would turn a transient model
    // error into a total outage, which is worse than the crash it replaces.
    const a = defer()
    void withConcurrencySlot(async () => { await a.p })
    await expect(withConcurrencySlot(async () => { throw new Error('model died') }))
      .rejects.toThrow('model died')
    expect(gateStats().active).toBe(1)
    a.release()
    await expect(withConcurrencySlot(async () => 'ok')).resolves.toBe('ok')
  })

  it('serves waiters in the order they arrived', async () => {
    // FIFO, so a busy period cannot starve whoever has been holding longest.
    process.env.AGENT_MAX_CONCURRENT = '1'
    const a = defer()
    const order: string[] = []
    void withConcurrencySlot(async () => { await a.p })
    const first = withConcurrencySlot(async () => { order.push('first') })
    const second = withConcurrencySlot(async () => { order.push('second') })
    await new Promise((r) => setImmediate(r))
    a.release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('says something true and human about the wait', () => {
    expect(queuePositionMessage(0)).toBeNull()
    expect(queuePositionMessage(1)).toMatch(/moment/i)
    expect(queuePositionMessage(5)).toMatch(/ahead of you/i)
    // Never a number the person would have to interpret.
    expect(queuePositionMessage(5)).not.toMatch(/\bposition\b|\bqueue\b|#\d/)
  })
})
