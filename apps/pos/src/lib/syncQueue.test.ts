/**
 * POS sync queue tests.
 *
 * Pins:
 *   - enqueue → drain → IndexedDB row cleanup + id mapping
 *   - FIFO ordering (OPEN_SESSION before downstream ADD_ITEM)
 *   - parent_not_resolved_yet self-pause when an *_ITEM enqueues
 *     before its parent OPEN_SESSION drains
 *   - 4xx discard (no retry, row removed with console.warn)
 *   - 5xx retry (row stays, attempts++ , nextAttemptAt scheduled
 *     to BACKOFF_MS[attempts])
 *   - clearAll / preloadMapping / subscribe (status emission)
 *   - offline short-circuit (currentStatus.online=false → no API calls)
 *
 * Module state is shared across imports, so each test calls
 * `vi.resetModules()` + a fresh `indexedDB` factory + resets the api
 * mock. The module re-runs its top-level `void drain()` on import;
 * tests await that initial drain before acting.
 */

import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type * as SQModule from './syncQueue'

// Mocked api — the module under test imports from './api'.
const apiMock = {
  post:   vi.fn<any[], any>(),
  patch:  vi.fn<any[], any>(),
  delete: vi.fn<any[], any>(),
}
vi.mock('./api', () => ({ api: apiMock }))

// Re-imported per test for fresh module state.
let SQ: typeof SQModule

// Polling helpers ───────────────────────────────────────────────────────────

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Waits until the queue's `syncing` flag turns false. Drain completion. */
async function waitUntilIdle(maxMs = 1500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (!SQ.getStatus().syncing) return
    await tick()
  }
  throw new Error('queue still syncing after ' + maxMs + 'ms')
}

/** Helper to make a 4xx axios-style error. */
function http4xx(status: number, body: any = {}): Error {
  const e: any = new Error('http ' + status)
  e.response = { status, data: body }
  return e
}

/** 5xx axios-style error. */
function http5xx(status = 500, body: any = {}): Error {
  const e: any = new Error('http ' + status)
  e.response = { status, data: body }
  return e
}

// Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Fresh IndexedDB per test — fake-indexeddb persists across tests
  // unless the factory is replaced.
  ;(globalThis as any).indexedDB = new IDBFactory()

  apiMock.post.mockReset()
  apiMock.patch.mockReset()
  apiMock.delete.mockReset()

  vi.resetModules()
  SQ = await import('./syncQueue')

  // The module fires `void refreshPendingCount().then(() => void drain())`
  // at import time. Let it finish before the test acts.
  await waitUntilIdle()
})

afterEach(async () => {
  // Defensive cleanup so a setTimeout from one test doesn't fire under
  // the next test's module instance.
  try { await SQ.clearAll() } catch { /* ignore */ }
})

// Tests ─────────────────────────────────────────────────────────────────────

describe('syncQueue — happy path', () => {
  it('enqueue → drain → api.post called, queue row removed, mapping persisted', async () => {
    apiMock.post.mockResolvedValueOnce({ data: { data: { id: 'srv-sess-1' } } })

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION',
      clientSessionId,
      payload: { propertyId: 'p1' },
    })
    await waitUntilIdle()

    expect(apiMock.post).toHaveBeenCalledTimes(1)
    expect(apiMock.post).toHaveBeenCalledWith('/pos/sessions', { propertyId: 'p1' })
    expect(SQ.getStatus().pendingCount).toBe(0)
    expect(await SQ.resolveServerId(clientSessionId)).toBe('srv-sess-1')
  })

  it('FIFO: OPEN_SESSION drains before downstream ADD_ITEM (same cycle)', async () => {
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { id: 'srv-sess-2' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'srv-item-1' } } })

    const clientSessionId = SQ.mintClientId()
    const clientItemId    = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION', clientSessionId,
      payload: { propertyId: 'p1' },
    })
    await SQ.enqueue({
      op: 'ADD_ITEM', clientSessionId, clientItemId,
      payload: { sku: 'A1', qty: 1 },
    })
    await waitUntilIdle()

    expect(apiMock.post).toHaveBeenCalledTimes(2)
    expect(apiMock.post.mock.calls[0][0]).toBe('/pos/sessions')
    expect(apiMock.post.mock.calls[1][0]).toBe('/pos/sessions/srv-sess-2/items')
    expect(await SQ.resolveServerId(clientItemId)).toBe('srv-item-1')
    expect(SQ.getStatus().pendingCount).toBe(0)
  })

  it('PATCH_ITEM after ADD_ITEM resolves both ids correctly', async () => {
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { id: 'srv-sess-3' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'srv-item-2' } } })
    apiMock.patch.mockResolvedValueOnce({ data: {} })

    const clientSessionId = SQ.mintClientId()
    const clientItemId    = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION', clientSessionId, payload: {},
    })
    await SQ.enqueue({
      op: 'ADD_ITEM', clientSessionId, clientItemId,
      payload: { sku: 'A1', qty: 1 },
    })
    await SQ.enqueue({
      op: 'PATCH_ITEM', clientSessionId, clientItemId,
      payload: { qty: 3 },
    })
    await waitUntilIdle()

    expect(apiMock.patch).toHaveBeenCalledWith(
      '/pos/sessions/srv-sess-3/items/srv-item-2',
      { qty: 3 },
    )
    expect(SQ.getStatus().pendingCount).toBe(0)
  })

  it('VOID_SESSION and COMPLETE_SESSION resolve and post to the right paths', async () => {
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { id: 'srv-sess-v1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} })

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })
    await SQ.enqueue({ op: 'VOID_SESSION', clientSessionId, payload: { reason: 'oops' } })
    await SQ.enqueue({ op: 'COMPLETE_SESSION', clientSessionId, payload: { transactionId: 'tx-1' } })
    await waitUntilIdle()

    const paths = apiMock.post.mock.calls.map((c) => c[0])
    expect(paths).toEqual([
      '/pos/sessions',
      '/pos/sessions/srv-sess-v1/void',
      '/pos/sessions/srv-sess-v1/complete',
    ])
  })

  it('DELETE_ITEM hits the server delete endpoint', async () => {
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { id: 'srv-sess-d1' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'srv-item-d1' } } })
    apiMock.delete.mockResolvedValueOnce({ data: {} })

    const clientSessionId = SQ.mintClientId()
    const clientItemId    = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })
    await SQ.enqueue({ op: 'ADD_ITEM', clientSessionId, clientItemId, payload: {} })
    await SQ.enqueue({ op: 'DELETE_ITEM', clientSessionId, clientItemId, payload: {} })
    await waitUntilIdle()

    expect(apiMock.delete).toHaveBeenCalledWith('/pos/sessions/srv-sess-d1/items/srv-item-d1')
    expect(SQ.getStatus().pendingCount).toBe(0)
  })
})

describe('syncQueue — errors and retries', () => {
  it('4xx response: row discarded (no retry, removed from queue)', async () => {
    apiMock.post.mockRejectedValueOnce(http4xx(409, { error: 'already_voided' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION', clientSessionId, payload: { propertyId: 'p1' },
    })
    await waitUntilIdle()

    expect(SQ.getStatus().pendingCount).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('5xx response: row retained with attempts=1 and future nextAttemptAt', async () => {
    apiMock.post.mockRejectedValueOnce(http5xx(503))

    const t0 = Date.now()
    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION', clientSessionId, payload: { propertyId: 'p1' },
    })
    await waitUntilIdle()

    // Row should still be queued.
    expect(SQ.getStatus().pendingCount).toBe(1)

    // Read the underlying row to verify retry bookkeeping.
    const req = indexedDB.open('gam_pos_offline_v1', 2)
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror   = () => rej(req.error)
    })
    const rows: any[] = await new Promise((res, rej) => {
      const r = db.transaction('queue').objectStore('queue').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror   = () => rej(r.error)
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].nextAttemptAt).toBeGreaterThanOrEqual(t0 + 4_000)
    expect(rows[0].nextAttemptAt).toBeLessThanOrEqual(t0 + 6_000)  // 5s window
    expect(rows[0].lastError).toBeDefined()
  })

  it('network error (no response): treated like 5xx (retry)', async () => {
    apiMock.post.mockRejectedValueOnce(new Error('Network Error'))

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({
      op: 'OPEN_SESSION', clientSessionId, payload: {},
    })
    await waitUntilIdle()

    expect(SQ.getStatus().pendingCount).toBe(1)
  })

  it('ADD_ITEM enqueued before OPEN_SESSION drains: self-pauses with retry backoff', async () => {
    // ADD_ITEM only — no prior OPEN_SESSION to resolve clientSessionId.
    const clientSessionId = SQ.mintClientId()
    const clientItemId    = SQ.mintClientId()
    await SQ.enqueue({
      op: 'ADD_ITEM', clientSessionId, clientItemId,
      payload: { sku: 'A1', qty: 1 },
    })
    await waitUntilIdle()

    // Self-paused: row still queued, attempts++.
    expect(SQ.getStatus().pendingCount).toBe(1)
    expect(apiMock.post).not.toHaveBeenCalled()

    const req = indexedDB.open('gam_pos_offline_v1', 2)
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror   = () => rej(req.error)
    })
    const rows: any[] = await new Promise((res, rej) => {
      const r = db.transaction('queue').objectStore('queue').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror   = () => rej(r.error)
    })
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].lastError).toBe('session_not_resolved_yet')
  })

  it('PATCH_ITEM without resolved item id: self-pauses', async () => {
    apiMock.post.mockResolvedValueOnce({ data: { data: { id: 'srv-sess-p1' } } })

    const clientSessionId = SQ.mintClientId()
    const clientItemId    = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })
    // PATCH before ADD_ITEM — clientItemId has no mapping yet.
    await SQ.enqueue({
      op: 'PATCH_ITEM', clientSessionId, clientItemId,
      payload: { qty: 5 },
    })
    await waitUntilIdle()

    // OPEN resolved, PATCH stuck.
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    expect(apiMock.patch).not.toHaveBeenCalled()
    expect(SQ.getStatus().pendingCount).toBe(1)
  })
})

describe('syncQueue — utilities', () => {
  it('clearAll wipes queue + mappings', async () => {
    apiMock.post.mockResolvedValueOnce({ data: { data: { id: 'srv-c1' } } })
    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })
    await waitUntilIdle()
    expect(await SQ.resolveServerId(clientSessionId)).toBe('srv-c1')

    // Now enqueue a fresh pending one and clearAll.
    apiMock.post.mockRejectedValueOnce(http5xx(503))
    const c2 = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId: c2, payload: {} })
    await waitUntilIdle()
    expect(SQ.getStatus().pendingCount).toBe(1)

    await SQ.clearAll()
    expect(SQ.getStatus().pendingCount).toBe(0)
    expect(await SQ.resolveServerId(clientSessionId)).toBeUndefined()
  })

  it('preloadMapping registers a server id for resume-tab flow', async () => {
    await SQ.preloadMapping('c-known', 'srv-known')
    expect(await SQ.resolveServerId('c-known')).toBe('srv-known')

    // Future enqueues using c-known resolve immediately.
    apiMock.patch.mockResolvedValueOnce({ data: {} })
    await SQ.enqueue({
      op: 'PATCH_SESSION', clientSessionId: 'c-known',
      payload: { taxRate: 8.6 },
    })
    await waitUntilIdle()
    expect(apiMock.patch).toHaveBeenCalledWith(
      '/pos/sessions/srv-known', { taxRate: 8.6 },
    )
  })

  it('subscribe emits status updates on enqueue + drain', async () => {
    apiMock.post.mockResolvedValueOnce({ data: { data: { id: 'srv-sub-1' } } })

    const seen: Array<{ pendingCount: number; syncing: boolean }> = []
    const unsubscribe = SQ.subscribe((s) => {
      seen.push({ pendingCount: s.pendingCount, syncing: s.syncing })
    })

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })
    await waitUntilIdle()
    unsubscribe()

    // Should have seen at least: initial (0), syncing=true, pendingCount=1
    // ramping back to 0 after drain.
    const finalState = seen[seen.length - 1]
    expect(finalState.pendingCount).toBe(0)
    expect(finalState.syncing).toBe(false)
    // Saw the "in-flight" state at some point.
    expect(seen.some((s) => s.syncing === true)).toBe(true)
  })

  it('mintClientId returns unique ids', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(SQ.mintClientId())
    expect(ids.size).toBe(50)
  })
})

describe('syncQueue — offline', () => {
  it('offline: drain short-circuits, no API calls fire', async () => {
    // Flip the navigator.onLine flag + dispatch the offline event.
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    })
    window.dispatchEvent(new Event('offline'))
    // Status reflects offline.
    await tick()
    expect(SQ.getStatus().online).toBe(false)

    const clientSessionId = SQ.mintClientId()
    await SQ.enqueue({ op: 'OPEN_SESSION', clientSessionId, payload: {} })

    // Drain returns immediately because online=false.
    await SQ.drain()
    await tick()

    expect(apiMock.post).not.toHaveBeenCalled()
    expect(SQ.getStatus().pendingCount).toBe(1)

    // Restore for the next test.
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => true,
    })
    window.dispatchEvent(new Event('online'))
  })
})
