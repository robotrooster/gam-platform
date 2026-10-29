// @vitest-environment jsdom
/**
 * 10/17 (Nic) — the signing banner only asks for the queue it is allowed to
 * read.
 *
 *   Nic, 10/17: "Yes, fix it."
 *
 * The banner polled the landlord's signing queue every 30 seconds from every
 * landlord-portal session. The queue is gated on Sign leases, so the register
 * clerk's browser collected a refusal each time — 2,389 of them on 10/17, with
 * the refusals that meant something buried underneath. Nobody who is refused
 * could have had a row to read either: a document only ever names a signer who
 * holds Sign leases. So the screen stops asking, rather than swallowing the
 * answer, and the banner still works for everyone it ever worked for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const seat = vi.hoisted(() => ({ maySign: false }))

vi.mock('./lib/permissions', () => ({ usePerms: () => ({ can: () => seat.maySign, isOwner: seat.maySign }) }))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'onsite_manager' }, logout: () => {} }) }))
vi.mock('./lib/api', () => ({ apiGet: async () => [], apiPost: async () => ({}) }))
vi.mock('./components/NotificationBell', () => ({ NotificationBell: () => null }))
vi.mock('./components/ChatWidget', () => ({ ChatWidget: () => null }))
vi.mock('./components/dialogs', () => ({
  DialogHost: () => null,
  toast: Object.assign(() => {}, { error: () => {} }),
  appConfirm: async () => false,
}))

import { PendingSignBanner } from './components/layout/Layout'

const asked: string[] = []
let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

beforeEach(() => {
  asked.length = 0
  seat.maySign = false
  localStorage.setItem('gam_token', 'tok')
  ;(globalThis as any).fetch = vi.fn(async (url: string) => {
    asked.push(String(url))
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: [{ documentId: 'd1', title: 'Lease — Site 14', status: 'sent', renewsLeaseId: null }],
      }),
    } as any
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root!.unmount() })
  host!.remove()
  root = null; host = null
})

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><PendingSignBanner /></MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await flush()
  qc.clear()
}

describe('10/17 the signing banner stops asking for a queue it may not read', () => {
  it('the register clerk never asks: no request, no banner', async () => {
    await render()
    expect(asked).toEqual([])
    expect(host!.textContent).toBe('')
  })

  it('a signer still gets the banner, and it still reads the queue once', async () => {
    seat.maySign = true
    await render()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('/api/esign/landlord-pending')
    expect(host!.textContent).toContain('Lease — Site 14')
    expect(host!.textContent).toContain('You sign first')
  })
})
