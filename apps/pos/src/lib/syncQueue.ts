// S264: POS offline-tolerant mutation queue.
//
// Cart-editing mutations no longer hit the server directly. They go
// through this queue, which:
//   - persists pending mutations in IndexedDB so a page reload /
//     terminal restart / browser crash doesn't lose them,
//   - drains FIFO whenever the browser is online,
//   - resolves client-side temporary ids (clientSessionId,
//     clientItemId) to the server-assigned ids returned by each
//     successful mutation, so subsequent mutations referencing the
//     same item don't need to wait synchronously,
//   - retries with capped exponential backoff (5s, 30s, 2min, 10min)
//     on 5xx / network errors,
//   - discards with a console log on 4xx (server-wins — the row is
//     already gone or already completed by another path).
//
// Out of scope (Session 3): SSE realtime push of remote mutations.
// Polling-on-tab-refresh stays the cross-terminal visibility model.
//
// Out of scope (forever): optimistic-locking version stamps. Last-
// write-wins is acceptable per the 2-terminal-max + in-person-
// sequential contention model (locked S263).

import { api } from './api'

const DB_NAME    = 'gam_pos_offline_v1'
// v2 (S333): camelCase payload migration. Pre-existing queued rows
// from v1 carry snake_case payloads (property_id, item_name, etc.)
// that the new backend handlers reject as missing required fields.
// On v1→v2 upgrade we wipe the queue store; mappings are safe to
// keep since they're just id strings.
const DB_VERSION = 2
const STORE_Q    = 'queue'         // pending mutation rows
const STORE_MAP  = 'id_mappings'   // clientId → serverId resolutions

export type SyncOp =
  | 'OPEN_SESSION'
  | 'ADD_ITEM'
  | 'PATCH_ITEM'
  | 'DELETE_ITEM'
  | 'PATCH_SESSION'
  | 'VOID_SESSION'
  | 'COMPLETE_SESSION'

export interface QueuedMutation {
  id:                string                 // queue row id (uuid)
  op:                SyncOp
  clientSessionId:   string                 // tag in the local cart
  clientItemId?:     string                 // for *_ITEM ops
  payload:           Record<string, any>    // body to send to the server
  queuedAt:          number                 // Date.now() at enqueue
  attempts:          number                 // 0+ on each fire
  nextAttemptAt:     number                 // Date.now() when ready to fire
  lastError?:        string
}

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const
const TERMINAL_BACKOFF = BACKOFF_MS[BACKOFF_MS.length - 1]

// ── IndexedDB helpers ──────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      const oldVersion = event.oldVersion
      if (!db.objectStoreNames.contains(STORE_Q)) {
        const s = db.createObjectStore(STORE_Q, { keyPath: 'id' })
        s.createIndex('queuedAt', 'queuedAt', { unique: false })
      } else if (oldVersion < 2 && req.transaction) {
        // v1→v2: legacy snake_case payloads would 400 on every drain
        // attempt under the new camelCase backend. Wipe the queue.
        req.transaction.objectStore(STORE_Q).clear()
      }
      if (!db.objectStoreNames.contains(STORE_MAP)) {
        db.createObjectStore(STORE_MAP, { keyPath: 'clientId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function txStore(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(store, mode).objectStore(store)
}

async function dbPut(store: string, value: any): Promise<void> {
  const s = await txStore(store, 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const req = s.put(value)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function dbGetAll<T>(store: string): Promise<T[]> {
  const s = await txStore(store, 'readonly')
  return new Promise<T[]>((resolve, reject) => {
    const req = s.getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror   = () => reject(req.error)
  })
}

async function dbGet<T>(store: string, key: string): Promise<T | undefined> {
  const s = await txStore(store, 'readonly')
  return new Promise<T | undefined>((resolve, reject) => {
    const req = s.get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror   = () => reject(req.error)
  })
}

async function dbDelete(store: string, key: string): Promise<void> {
  const s = await txStore(store, 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const req = s.delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function dbClear(store: string): Promise<void> {
  const s = await txStore(store, 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const req = s.clear()
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

// ── Queue state + listeners ────────────────────────────────────────────────

interface QueueStatus {
  online:        boolean
  pendingCount:  number
  syncing:       boolean
  lastError:     string | null
}

let currentStatus: QueueStatus = {
  online:        typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingCount:  0,
  syncing:       false,
  lastError:     null,
}
const listeners = new Set<(s: QueueStatus) => void>()

function emit() {
  const snap = { ...currentStatus }
  for (const l of listeners) l(snap)
}

export function subscribe(l: (s: QueueStatus) => void): () => void {
  listeners.add(l)
  l(currentStatus)
  return () => listeners.delete(l)
}

export function getStatus(): QueueStatus { return { ...currentStatus } }

// ── ID resolution ──────────────────────────────────────────────────────────

interface IdMapping {
  clientId: string
  serverId: string
}

async function setIdMapping(clientId: string, serverId: string): Promise<void> {
  await dbPut(STORE_MAP, { clientId, serverId })
}

export async function resolveServerId(clientId: string): Promise<string | undefined> {
  const row = await dbGet<IdMapping>(STORE_MAP, clientId)
  return row?.serverId
}

// Used by the resume-tab flow: a session (or item) is already known on
// the server, so the local cart can register the server id as the
// clientId by self-mapping. Future PATCH/DELETE enqueues just resolve
// to themselves and fire synchronously.
export async function preloadMapping(clientId: string, serverId: string): Promise<void> {
  await setIdMapping(clientId, serverId)
}

// Mint a fresh client-side uuid for a new session or item. Used by
// POSPage when generating optimistic ids for offline-tolerant flow.
export function mintClientId(): string { return uuid() }

// ── Public enqueue API ─────────────────────────────────────────────────────

function uuid(): string {
  // Avoid pulling a uuid dep — POS app already runs without it.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID()
  }
  return 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export interface EnqueueArgs {
  op:                SyncOp
  clientSessionId:   string
  clientItemId?:     string
  payload:           Record<string, any>
}

export async function enqueue(args: EnqueueArgs): Promise<string> {
  const row: QueuedMutation = {
    id:               uuid(),
    op:               args.op,
    clientSessionId:  args.clientSessionId,
    clientItemId:     args.clientItemId,
    payload:          args.payload,
    queuedAt:         Date.now(),
    attempts:         0,
    nextAttemptAt:    Date.now(),
  }
  await dbPut(STORE_Q, row)
  await refreshPendingCount()
  void drain()
  return row.id
}

async function refreshPendingCount(): Promise<void> {
  const all = await dbGetAll<QueuedMutation>(STORE_Q)
  currentStatus = { ...currentStatus, pendingCount: all.length }
  emit()
}

export async function clearAll(): Promise<void> {
  await dbClear(STORE_Q)
  await dbClear(STORE_MAP)
  await refreshPendingCount()
}

// ── Drain worker ───────────────────────────────────────────────────────────

let draining = false

export async function drain(): Promise<void> {
  if (draining) return
  if (!currentStatus.online) return
  draining = true
  currentStatus = { ...currentStatus, syncing: true, lastError: null }
  emit()
  try {
    let cycles = 0
    while (cycles++ < 1000) {
      const all = await dbGetAll<QueuedMutation>(STORE_Q)
      const now = Date.now()
      const ready = all
        .filter((m) => m.nextAttemptAt <= now)
        .sort((a, b) => a.queuedAt - b.queuedAt)
      if (ready.length === 0) break
      const m = ready[0]
      const outcome = await fireMutation(m)
      if (outcome === 'success' || outcome === 'discarded') {
        await dbDelete(STORE_Q, m.id)
      } else {
        // Retry: schedule next attempt with backoff.
        const next: QueuedMutation = {
          ...m,
          attempts: m.attempts + 1,
          nextAttemptAt: Date.now() + BACKOFF_MS[Math.min(m.attempts, BACKOFF_MS.length - 1)],
          lastError: outcome,
        }
        await dbPut(STORE_Q, next)
        // Don't loop forever in this drain; sleep schedule re-enters via
        // setTimeout below.
        break
      }
    }
  } finally {
    draining = false
    await refreshPendingCount()
    currentStatus = { ...currentStatus, syncing: false }
    emit()
    // Schedule next drain wake-up if anything is still queued.
    const all = await dbGetAll<QueuedMutation>(STORE_Q)
    if (all.length > 0) {
      const next = Math.min(...all.map((m) => m.nextAttemptAt))
      const delay = Math.max(1000, Math.min(TERMINAL_BACKOFF, next - Date.now()))
      setTimeout(() => { void drain() }, delay)
    }
  }
}

type MutationOutcome = 'success' | 'discarded' | string  // string = error message for retry

async function fireMutation(m: QueuedMutation): Promise<MutationOutcome> {
  try {
    switch (m.op) {
      case 'OPEN_SESSION': {
        const res = await api.post('/pos/sessions', m.payload)
        const serverId = res.data?.data?.id
        if (!serverId) return 'no_id_returned'
        await setIdMapping(m.clientSessionId, serverId)
        return 'success'
      }
      case 'PATCH_SESSION': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        if (!serverSessionId) return 'session_not_resolved_yet'
        await api.patch(`/pos/sessions/${serverSessionId}`, m.payload)
        return 'success'
      }
      case 'VOID_SESSION': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        if (!serverSessionId) return 'session_not_resolved_yet'
        await api.post(`/pos/sessions/${serverSessionId}/void`, m.payload)
        return 'success'
      }
      case 'COMPLETE_SESSION': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        if (!serverSessionId) return 'session_not_resolved_yet'
        await api.post(`/pos/sessions/${serverSessionId}/complete`, m.payload)
        return 'success'
      }
      case 'ADD_ITEM': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        if (!serverSessionId) return 'session_not_resolved_yet'
        const res = await api.post(`/pos/sessions/${serverSessionId}/items`, m.payload)
        const serverItemId = res.data?.data?.id
        if (m.clientItemId && serverItemId) {
          await setIdMapping(m.clientItemId, serverItemId)
        }
        return 'success'
      }
      case 'PATCH_ITEM': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        const serverItemId    = m.clientItemId ? await resolveServerId(m.clientItemId) : undefined
        if (!serverSessionId || !serverItemId) return 'parent_not_resolved_yet'
        await api.patch(`/pos/sessions/${serverSessionId}/items/${serverItemId}`, m.payload)
        return 'success'
      }
      case 'DELETE_ITEM': {
        const serverSessionId = await resolveServerId(m.clientSessionId)
        const serverItemId    = m.clientItemId ? await resolveServerId(m.clientItemId) : undefined
        if (!serverSessionId || !serverItemId) return 'parent_not_resolved_yet'
        await api.delete(`/pos/sessions/${serverSessionId}/items/${serverItemId}`)
        return 'success'
      }
      default:
        return 'unknown_op'
    }
  } catch (e: any) {
    const status = e?.response?.status
    if (status && status >= 400 && status < 500) {
      // 4xx — server-wins. Discard with a log; do not retry.
      console.warn('[pos-sync] 4xx, dropping mutation', m.op, status, e?.response?.data)
      return 'discarded'
    }
    // 5xx / network / timeout → retry path.
    return (e?.message || 'network_error').slice(0, 200)
  }
}

// ── Browser online/offline wiring ──────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    currentStatus = { ...currentStatus, online: true }
    emit()
    void drain()
  })
  window.addEventListener('offline', () => {
    currentStatus = { ...currentStatus, online: false, syncing: false }
    emit()
  })

  // Initial drain on module load (recovers any rows from a prior page life).
  void refreshPendingCount().then(() => void drain())
}
