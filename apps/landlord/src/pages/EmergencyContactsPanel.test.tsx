// @vitest-environment jsdom
/**
 * The emergency contact list at the Front Desk (S640). Staff screens are
 * foolproof (decisions.md, Nic 10/2): a save that took reads as saved, an edit
 * can be backed out with one button, and a refusal is said once with its next
 * step — never an empty roster.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  rows: [] as any[],
  puts: [] as any[],
  posts: [] as { url: string; body: any }[],
  /** When set, GET /emergency-contacts is refused with this status and sentence. */
  refuseList: null as null | { status: number; error: string },
  /** When set, PUT /emergency-contacts is refused with this status and sentence. */
  refuseSave: null as null | { status: number; error: string },
  /** When set, POST /emergency-contacts/confirm is refused with this status and sentence. */
  refuseConfirm: null as null | { status: number; error: string },
  /** How many times the roster was read. */
  gets: 0,
  /** Run once, just before the next refusal is thrown (the world changed meanwhile). */
  thenRows: null as null | any[],
  /** When set, the roster passes through the API's own response converter (the wire). */
  wire: null as null | ((x: any) => any),
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url !== '/emergency-contacts') throw new Error(`unexpected GET ${url}`)
    server.gets++
    if (server.refuseList) throw httpError(server.refuseList.status, server.refuseList.error)
    return (server.wire ?? ((x: any) => x))(JSON.parse(JSON.stringify(server.rows)))
  },
  // routes/emergencyContacts.ts PUT: the phone is stored as 10 bare digits (a
  // leading 1 dropped), the name and relationship trimmed.
  apiPut: async (url: string, body: any) => {
    if (url !== '/emergency-contacts') throw new Error(`unexpected PUT ${url}`)
    server.puts.push(body)
    if (server.refuseSave) {
      if (server.thenRows) { server.rows = server.thenRows; server.thenRows = null }
      throw httpError(server.refuseSave.status, server.refuseSave.error)
    }
    const digits = String(body.phone ?? '').replace(/\D/g, '')
    const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    const row = server.rows.find(r => r.tenantId === body.tenantId)
    Object.assign(row, {
      contactName: String(body.name ?? '').trim() || null,
      contactPhone: phone || null,
      contactRelationship: String(body.relationship ?? '').trim() || null,
      contactConfirmedAt: new Date().toISOString(),
    })
    return { success: true, data: {} }
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.refuseConfirm) {
      if (server.thenRows) { server.rows = server.thenRows; server.thenRows = null }
      throw httpError(server.refuseConfirm.status, server.refuseConfirm.error)
    }
    return { success: true, data: {} }
  },
}))

const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }))
vi.mock('../components/dialogs', () => {
  const toast = (t: string) => { toasts.info.push(t) }
  ;(toast as any).error = (t: string) => { toasts.error.push(t) }
  return { toast }
})

import { EmergencyContactsPanel } from './EmergencyContactsPanel'
import { camelCaseKeys } from '../../../api/src/lib/caseConversion'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const kim = () => ({
  tenantId: 't1', tenantFirst: 'Kim', tenantLast: 'Harland', tenantPhone: null,
  unitNumber: 'MH 04', propertyName: 'Oak Park', propertyId: 'p1',
  contactId: null, contactName: null, contactPhone: null, contactRelationship: null,
  contactRaw: null, contactSource: null, contactConfirmedAt: null, sharedWithCount: 0, suggestion: null,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.rows = [kim()]; server.puts = []; server.posts = []
  server.refuseList = null; server.refuseSave = null; server.refuseConfirm = null
  server.gets = 0; server.thenRows = null; server.wire = null
  toasts.info = []; toasts.error = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
const button = (re: RegExp) => buttons().find(b => re.test((b.textContent ?? '').trim())) as HTMLButtonElement | undefined
const inputs = () => [...host.querySelectorAll('tbody input')] as HTMLInputElement[]
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><EmergencyContactsPanel /></QueryClientProvider>)
  })
  await until(() => text().includes('Kim Harland') || !!host.querySelector('[role="alert"]'), 'the roster')
}

describe('saving an emergency contact', () => {
  it('a phone typed the way the box shows it saves, and the row then reads "Still good" with no Save', async () => {
    await open()
    const [name, phone, rel] = inputs()
    await type(name, 'Rosa Harland ')
    await type(phone, '(520) 555-0142')
    await type(rel, 'Sister')
    await act(async () => { button(/^Save$/)!.click() })
    await until(() => !!button(/Still good/), 'the saved row')
    expect(server.puts).toEqual([{ tenantId: 't1', name: 'Rosa Harland ', phone: '(520) 555-0142', relationship: 'Sister' }])
    expect(button(/^Save$/)).toBeUndefined()
    expect(button(/^Cancel$/)).toBeUndefined()
    // The stored 10 digits are shown written out.
    expect(inputs()[1].value).toBe('(520) 555-0142')
    expect(inputs()[0].value).toBe('Rosa Harland')
    expect(toasts.info).toEqual(['Saved.'])
  })

  it('a stored number shown written out is not a change: the row offers "Still good", not Save', async () => {
    server.rows = [{ ...kim(), contactName: 'Rosa Harland', contactPhone: '5205550142', contactConfirmedAt: new Date().toISOString() }]
    await open()
    expect(inputs()[1].value).toBe('(520) 555-0142')
    expect(button(/Still good/)).toBeTruthy()
    expect(button(/^Save$/)).toBeUndefined()
    // A leading 1 or a trailing space is not a change either.
    await type(inputs()[1], '1 520 555 0142')
    await type(inputs()[0], 'Rosa Harland  ')
    expect(button(/^Save$/)).toBeUndefined()
  })

  it('Cancel puts back the stored values and sends nothing', async () => {
    server.rows = [{ ...kim(), contactName: 'Rosa Harland', contactPhone: '5205550142', contactRelationship: 'Sister' }]
    await open()
    await type(inputs()[0], 'Somebody Else')
    await type(inputs()[1], '602 555 9999')
    expect(button(/^Save$/)).toBeTruthy()
    const cancel = button(/^Cancel$/)!
    expect(cancel.className).toContain('btn-ghost')
    await act(async () => { cancel.click() })
    expect(inputs()[0].value).toBe('Rosa Harland')
    expect(inputs()[1].value).toBe('(520) 555-0142')
    expect(inputs()[2].value).toBe('Sister')
    expect(button(/^Save$/)).toBeUndefined()
    expect(server.puts).toHaveLength(0)
    expect(server.posts).toHaveLength(0)
  })

  it('a save the server refuses for a reason says that reason once and keeps the draft', async () => {
    server.refuseSave = { status: 400, error: 'That phone number needs to be 10 digits.' }
    await open()
    await type(inputs()[1], '555-0142')
    await act(async () => { button(/^Save$/)!.click() })
    await until(() => toasts.error.length === 1, 'the refusal')
    expect(toasts.error).toEqual(['That phone number needs to be 10 digits.'])
    expect(inputs()[1].value).toBe('555-0142')
    expect(button(/^Save$/)).toBeTruthy()
  })
})

describe('a refused emergency contact list', () => {
  it('a bare switch refusal names the switch and says to sign in again', async () => {
    server.refuseList = { status: 403, error: 'Insufficient permissions' }
    await open()
    expect(text()).toContain('The emergency contact list is not open to you right now.')
    expect(text()).toContain('"Front desk to-do list"')
    expect(text()).not.toContain('Nobody is on a space right now.')
  })

  it('a refusal with its own reason says that reason, not the switch', async () => {
    server.refuseList = { status: 403, error: 'You are not assigned to this property' }
    await open()
    expect(text()).toContain('You are not assigned to this property.')
    expect(text()).not.toContain('sign out and back in')
    expect(text()).not.toContain('ask the owner to turn on')
  })
})

describe('a stale row is read again in place', () => {
  it('a save refused because the resident left (404) says so once, reads the roster again, and the row is gone', async () => {
    server.rows = [kim(), { ...kim(), tenantId: 't2', tenantFirst: 'Russ', tenantLast: 'Fuller', unitNumber: 'RV 02' }]
    server.refuseSave = { status: 404, error: 'Not found' }
    await open()
    await type(inputs()[1], '(520) 555-0142')
    const before = server.gets
    server.thenRows = [{ ...kim(), tenantId: 't2', tenantFirst: 'Russ', tenantLast: 'Fuller', unitNumber: 'RV 02' }]
    await act(async () => { button(/^Save$/)!.click() })
    await until(() => toasts.error.length === 1, 'the refusal')
    expect(toasts.error).toEqual(['That resident is no longer on a space here. The list has been read again.'])
    await until(() => server.gets > before && !text().includes('Kim Harland'), 'the roster read again')
    expect(text()).toContain('Russ Fuller')
  })

  it('"Still good" refused because nothing is on file any more (404) says so once and reads the roster again', async () => {
    server.rows = [{ ...kim(), contactName: 'Rosa Harland', contactPhone: '5205550142' }]
    server.refuseConfirm = { status: 404, error: 'Nothing on file to confirm' }
    await open()
    const before = server.gets
    server.thenRows = [kim()]
    await act(async () => { button(/Still good/)!.click() })
    await until(() => toasts.error.length === 1, 'the refusal')
    expect(toasts.error).toEqual(['There is no contact on file to confirm any more. The list has been read again.'])
    await until(() => server.gets > before && !button(/Still good/), 'the roster read again')
    expect(text()).toContain('Nothing on file')
  })
})

describe('the roster counts only what the desk can fix', () => {
  const ownerUse = () => ({ ...kim(), tenantId: null, tenantFirst: 'Owner', tenantLast: '', tenantPhone: null,
    unitNumber: 'MH 01', propertyId: 'p1' })

  it('an owner-use space is not counted as a resident with no number, and sorts after the residents', async () => {
    server.rows = [ownerUse(), { ...kim(), contactName: 'Rosa Harland', contactPhone: '5205550142',
      contactConfirmedAt: new Date().toISOString() }]
    await open()
    expect(text()).not.toMatch(/no number to call/)
    expect(text()).not.toContain('While you\u2019re here')
    const firstCells = [...host.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td')?.textContent ?? '')
    expect(firstCells[0]).toContain('Kim Harland')
    expect(firstCells[1]).toContain('owner-use space')
  })

  it('a resident with no number is still counted beside an owner-use space', async () => {
    server.rows = [ownerUse(), kim()]
    await open()
    expect(text()).toContain('1 resident has no number to call')
  })

  it('the suggested number is offered with a gold button that fills the box', async () => {
    server.rows = [{ ...kim(), contactName: 'Rosa Harland',
      suggestion: { phone: '5205550142', fromName: 'Rosa Harland', context: 'on file for Rosa Harland' } }]
    await open()
    const use = button(/use \(520\) 555-0142/)!
    expect(use.className).toContain('btn-primary')
    await act(async () => { use.click() })
    expect(inputs()[1].value).toBe('(520) 555-0142')
  })
})

describe('the roster as it arrives on the wire', () => {
  it('reads the server\'s snake_case rows: the phone written out, "Still good", and the other households it covers', async () => {
    server.wire = (x: any) => camelCaseKeys(x)
    server.rows = [{
      tenant_id: 't1', tenant_first: 'Kim', tenant_last: 'Harland', tenant_phone: null,
      unit_number: 'MH 04', property_name: 'Oak Park', property_id: 'p1',
      contact_id: 'c1', contact_name: 'Rosa Harland', contact_phone: '5205550142', contact_relationship: 'Sister',
      contact_raw: null, contact_source: 'desk', contact_confirmed_at: new Date().toISOString(),
      shared_with_count: 2, suggestion: null,
    }]
    await open()
    expect(inputs()[1].value).toBe('(520) 555-0142')
    expect(button(/Still good/)).toBeTruthy()
    expect(text()).toContain('also the contact for 1 other household')
  })
})
