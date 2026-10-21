/**
 * 10/20 (Nic) — "SEND A DOCUMENT FOR SIGNATURE" ON THE RESIDENT'S OWN PAGE.
 *
 * Blu could not get his work-trade form signed. Nic: "can he just go into
 * Curtis's file, add a template that way, and have it signed to him?"
 *
 * What this pins is the half a landlord actually sees: the form list says who
 * will sign before anything is sent, a form whose boxes cannot be filled from
 * here is not selectable and says where it CAN be sent from, and one press
 * raises the document and sends it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const server = vi.hoisted(() => ({
  signing: null as any,
  posts: [] as { url: string; body: any }[],
  postError: null as any,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.startsWith('/tenants/t1/profile')) return {
      tenant: { firstName: 'Curtis', lastName: 'Bell', email: 'curtis@example.test', phone: null,
                achVerified: true, accountCreated: '2026-01-05T17:00:00.000Z' },
      units: [{ id: 'u1', unitNumber: 'Lot 1', propertyName: 'Mattoon', isCurrent: true }],
      payments: [], maintenance: [],
      stats: { onTimeRate: null, firstPayment: null, tenantMonths: 2, totalPaid: 0, unitsOccupied: 1 },
      credit: null,
    }
    if (url.startsWith('/esign/resident-forms/')) return JSON.parse(JSON.stringify(server.signing))
    return []
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.postError) throw server.postError
    return { success: true, data: { id: 'doc1', willSign: server.signing.forms[0].willSign } }
  },
  apiPatch: async () => ({ success: true, data: {} }),
}))
const auth = vi.hoisted(() => ({ user: { role: 'landlord', permissions: {} as Record<string, boolean> } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }))
const dialogs = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }), appConfirm: vi.fn(async () => false) }))
vi.mock('../components/dialogs', () => dialogs)

import { TenantDetailPage } from './TenantDetailPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const signing = (over: any = {}) => ({
  resident: { name: 'Curtis Bell', unitLabel: 'Lot 1', propertyName: 'Mattoon' },
  forms: [
    { id: 'wt', name: 'Mattoon Work Trade', purposeLabel: 'Work-Trade Addendum',
      suggestedTitle: 'Mattoon Work Trade — Curtis Bell (Lot 1)',
      willSign: [{ role: 'landlord', label: 'Landlord', name: 'Blu Landlord' },
                 { role: 'primary', label: 'Primary Tenant', name: 'Curtis Bell' }],
      leftOff: [], sendable: true, reason: null },
    { id: 'bos', name: 'Bill of sale', purposeLabel: 'Other Document',
      suggestedTitle: 'Bill of sale — Curtis Bell (Lot 1)',
      willSign: [], leftOff: [], sendable: false,
      reason: "This form has a Witness box, and Curtis Bell's page has nobody to put there. " +
        'Send it from GoldSign → New Contract, where you type in each person who signs.' },
  ],
  documents: [],
  ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.posts = []; server.postError = null; server.signing = signing()
  auth.user = { role: 'landlord', permissions: {} }
  dialogs.toast.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const text = () => host.textContent ?? ''
const btn = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/tenants/t1']}>
          <Routes><Route path="/tenants/:id" element={<TenantDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('Curtis Bell'), 'the resident page')
}
async function openModal() {
  await render()
  await until(() => !!btn(/Send a document for signature/), 'the signing button')
  await act(async () => { btn(/Send a document for signature/)!.click() })
}
const formRows = () => [...host.querySelectorAll('.modal label')]

describe("the resident page's signing door", () => {
  it('says who signs before anything is sent, and sends it in one press', async () => {
    await openModal()
    const rows = formRows()
    expect(rows[0].textContent).toContain('Mattoon Work Trade')
    expect(rows[0].textContent).toContain('Signed by Blu Landlord (Landlord) and Curtis Bell (Primary Tenant).')
    // One sendable form, so it is already chosen with its name filled in.
    const title = host.querySelector('.modal input.form-input') as HTMLInputElement
    expect(title.value).toBe('Mattoon Work Trade — Curtis Bell (Lot 1)')

    await act(async () => { btn(/^Send for signature$/)!.click() })
    await until(() => server.posts.length === 2, 'the create and the send')
    expect(server.posts[0]).toEqual({ url: '/esign/resident-documents',
      body: { tenantId: 't1', templateId: 'wt', title: 'Mattoon Work Trade — Curtis Bell (Lot 1)' } })
    // Sending is the step that mails each of them their link.
    expect(server.posts[1].url).toBe('/esign/documents/doc1/send')
    expect(dialogs.toast).toHaveBeenCalledWith('Sent for signature to Blu Landlord and Curtis Bell.')
  })

  // D9: a box offered is a box somebody can be put in — on the screen too.
  it('will not let a form it cannot fill be chosen, and says where it can be sent', async () => {
    await openModal()
    const row = formRows()[1]
    expect(row.textContent).toContain('Witness box')
    expect(row.textContent).toContain('New Contract')
    expect((row.querySelector('input[type=radio]') as HTMLInputElement).disabled).toBe(true)
    await act(async () => { (row.querySelector('input[type=radio]') as HTMLInputElement).click() })
    // Pressing it selects nothing — the form that CAN be sent stays the chosen one.
    expect((row.querySelector('input[type=radio]') as HTMLInputElement).checked).toBe(false)
    expect((host.querySelector('.modal input.form-input') as HTMLInputElement).value)
      .toBe('Mattoon Work Trade — Curtis Bell (Lot 1)')
    expect(server.posts).toEqual([])
  })

  it('has nothing to send when every form needs somebody this page cannot fill', async () => {
    server.signing = signing({ forms: [signing().forms[1]] })
    await openModal()
    expect((btn(/^Send for signature$/) as HTMLButtonElement).disabled).toBe(true)
    expect(host.querySelector('.modal input.form-input')).toBeNull()
    expect(server.posts).toEqual([])
  })

  it('says which box is left off when the household does not fill it', async () => {
    server.signing = signing({ forms: [{
      ...signing().forms[0],
      leftOff: [{ role: 'co_tenant_1', label: 'Co-Tenant 1' }],
    }] })
    await openModal()
    expect(formRows()[0].textContent).toContain('Co-Tenant 1 has nobody on this lease')
    expect(formRows()[0].textContent).toContain('left off')
  })

  it('shows what is already out for signature and who it waits on', async () => {
    server.signing = signing({ documents: [
      { id: 'd1', title: 'Mattoon Work Trade — Curtis Bell', status: 'sent',
        waitingOn: 'Curtis Bell', createdAt: '2026-10-20T18:00:00.000Z' },
      { id: 'd2', title: 'Park rules — Curtis Bell', status: 'completed',
        waitingOn: null, createdAt: '2026-09-01T18:00:00.000Z' },
    ] })
    await render()
    await until(() => text().includes('Mattoon Work Trade — Curtis Bell'), 'the signing list')
    expect(text()).toContain('waiting on Curtis Bell')
    // memory: gam-no-raw-enums-in-ui — the status reads as words.
    expect(text()).toContain('Sent')
    expect(text()).toContain('Completed')
    expect(text()).not.toContain('in_progress')
  })

  it('is not shown to someone who may not send documents', async () => {
    auth.user = { role: 'property_manager', permissions: { 'leases.create': true } }
    await render()
    expect(btn(/Send a document for signature/)).toBeUndefined()
  })

  it('keeps the modal open and says why when the server refuses', async () => {
    server.postError = { response: { data: { error: 'That form has no PDF yet — add one in GoldSign → Templates.' } } }
    await openModal()
    await act(async () => { btn(/^Send for signature$/)!.click() })
    await until(() => text().includes('no PDF yet'), 'the refusal')
    expect(btn(/^Send for signature$/)).toBeTruthy()
    expect(dialogs.toast).not.toHaveBeenCalled()
  })
})
