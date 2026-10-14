// @vitest-environment jsdom
/**
 * 10/13 (Nic) — the Expenses form: where a cost goes and how it was paid are
 * picked when it is logged, never ahead of time.
 *
 *   Nic, 10/13: "each expense is chosen on the split or specific unit or
 *   property at the time of logging. there should never be a default setting
 *   to apply expenses." And on cash on hand: "they don't pick as a setting,
 *   they pick as the expense happens."
 *
 * The busiest logging form: nothing is chosen when it opens and nothing
 * carries over from the last expense; it does not save until where the cost
 * goes and how it was paid are answered. 10/13 review: money out that is not a
 * cost (an owner's draw) is never split — it goes on a unit, a property or the
 * company; a bookkeeper kept to some properties is not offered a split; a bill
 * another record keeps (a work trader's hours) keeps that record's place, and
 * its words still save. The same file ships in GAM Books
 * (financials-parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  gets: {} as Record<string, any>,
  posts: [] as Array<{ url: string; body: any }>,
  patches: [] as Array<{ url: string; body: any }>,
}))

vi.mock('./lib/api', () => {
  const read = async (url: string) => {
    const key = Object.keys(server.gets).sort((a, b) => b.length - a.length).find(k => url === k || url.startsWith(`${k}?`))
    if (!key) throw new Error(`unexpected GET ${url}`)
    return server.gets[key]
  }
  return {
    api: { get: async (url: string) => ({ data: { success: true, data: await read(url) } }) },
    apiGet: read,
    apiPost: async (url: string, body: any) => { server.posts.push({ url, body }); return { success: true, data: { id: 'new1' } } },
    apiPatch: async (url: string, body: any) => { server.patches.push({ url, body }); return { id: url.split('/').pop(), ...body } },
  }
})
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./lib/permissions', () => ({ usePerms: () => ({ can: () => true }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { ExpensesPage } from './financials/ExpensesPage'

const CATEGORIES = [
  { id: 'cat-ins', landlordId: 'c1', direction: 'expense', name: 'Insurance', systemKey: 'insurance', inPicker: true, archived: false, onProfitAndLoss: true },
  { id: 'cat-draw', landlordId: 'c1', direction: 'expense', name: 'Owner draw', systemKey: 'owner_draw', inPicker: true, archived: false, onProfitAndLoss: false },
]
const BILL = {
  id: 'x1', category: 'contractor_payments', categoryId: 'cat-ins', categoryName: 'Contractor payments', onProfitAndLoss: true,
  amount: 80, description: 'Work-trade extra hours, 2026-09: Lee', vendor: null, vendorId: null, vendorName: 'Lee', billNumber: null,
  expenseDay: '2026-10-01', dueDate: '2026-10-01', isCommon: false, unitId: null, propertyId: null, costPlace: null,
  systemLinked: false, placeFixed: true, unitNumber: null, propertyName: null, utilityType: null,
  receiptUrl: null, receiptName: null, fromBank: false, canEdit: true, canRemove: true, bankLineId: null, landlordId: 'c1',
  paid: 0, unpaid: 80, payState: 'unpaid', payments: [], bankPaid: false, canPay: true, maintenanceRequestId: null, migratedFromTable: null,
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const PLACES = ['One unit', 'One property', 'Split across your properties by units', 'The company']
const chosenPlace = () => PLACES.filter(l => button(l)?.className.includes('btn-primary'))
const selectWith = (option: string) => [...host!.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === option)) as HTMLSelectElement
function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const click = async (label: string) => { await act(async () => { button(label)!.click() }); await flush() }

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter><ExpensesPage /></MemoryRouter></QueryClientProvider>)
  })
  await flush()
}
async function fill(category: string, amount: string) {
  await act(async () => { choose(selectWith('Choose a category…'), category) })
  await act(async () => { type(host!.querySelector('input[placeholder="0.00"]') as HTMLInputElement, amount) })
  await flush()
}

beforeEach(() => {
  server.posts = []
  server.patches = []
  server.gets = {
    '/financials/scope': {
      viewer: 'owner', canRemoveExpenses: true, companyWide: true, companies: [{ id: 'c1', name: 'Oak Park Motel and RV LLC' }],
      properties: [{ id: 'p1', name: 'Oak Park', landlordId: 'c1' }],
    },
    '/financials/units': [{ id: 'u1', unitNumber: '7', propertyId: 'p1' }],
    '/expenses': [],
    '/expenses/options': { categories: CATEGORIES, vendors: [], banks: [], canSplit: true },
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('Expenses: where a cost goes and how it was paid are picked when it is logged (10/13, Nic)', () => {
  it('nothing is chosen when the form opens; it does not save until both are answered; nothing carries over', async () => {
    await render()
    expect(text()).toContain('Where does this cost go?')
    for (const l of PLACES.slice(0, 3)) expect(button(l)).toBeTruthy()
    expect(chosenPlace()).toEqual([])
    const paidHow = selectWith('Choose how it was paid…')
    expect(paidHow.value).toBe('')
    await fill('cat-ins', '1200')
    expect(button('Log expense')!.disabled).toBe(true)
    await click('Split across your properties by units')
    expect(text()).toContain('split across all of the company\'s properties by how many units each has')
    // Where it goes is answered; how it was paid is not.
    expect(button('Log expense')!.disabled).toBe(true)
    await act(async () => { choose(paidHow, 'cash') })
    await flush()
    expect(button('Log expense')!.disabled).toBe(false)
    await click('Log expense')
    expect(server.posts[0].url).toBe('/expenses')
    expect(server.posts[0].body).toMatchObject({
      categoryId: 'cat-ins', amount: 1200, costPlace: 'split_by_units', propertyId: null, unitId: null, landlordId: 'c1',
      paid: { method: 'cash' },
    })
    // The next expense asks again.
    expect(chosenPlace()).toEqual([])
    expect(selectWith('Choose how it was paid…').value).toBe('')
    expect(button('Log expense')!.disabled).toBe(true)
  })

  it('a unit: its property and unit are chosen, and sent as the place', async () => {
    await render()
    await fill('cat-ins', '80')
    await click('One unit')
    await act(async () => { choose(selectWith('Select a property…'), 'p1') })
    await flush()
    await act(async () => { choose(selectWith('Select a unit…'), 'u1') })
    await act(async () => { choose(selectWith('Choose how it was paid…'), 'check') })
    await flush()
    await click('Log expense')
    expect(server.posts[0].body).toMatchObject({ costPlace: 'unit', unitId: 'u1', propertyId: null, paid: { method: 'check' } })
  })

  it('an owner\'s draw is not a cost: never split, it may go on the company; a split chosen first is asked again', async () => {
    await render()
    await fill('cat-ins', '500')
    await click('Split across your properties by units')
    expect(chosenPlace()).toEqual(['Split across your properties by units'])
    await act(async () => { choose(selectWith('Choose a category…'), 'cat-draw') })
    await flush()
    expect(text()).toContain('Where does this go?')
    expect(button('Split across your properties by units')).toBeUndefined()
    expect(chosenPlace()).toEqual([])
    await click('The company')
    expect(text()).toContain('Owner draw is not a cost, so it is not split; it goes on the company.')
    await act(async () => { choose(selectWith('Choose how it was paid…'), 'owner_paid') })
    await flush()
    await click('Log expense')
    expect(server.posts[0].body).toMatchObject({ categoryId: 'cat-draw', costPlace: null, propertyId: null, unitId: null, landlordId: 'c1' })
  })

  it('a bookkeeper kept to some properties is not offered a split, nor the company (they reach every property)', async () => {
    server.gets['/expenses/options'] = { ...server.gets['/expenses/options'], canSplit: false }
    await render()
    expect(button('One unit')).toBeTruthy()
    expect(button('One property')).toBeTruthy()
    expect(button('Split across your properties by units')).toBeUndefined()
    await act(async () => { choose(selectWith('Choose a category…'), 'cat-draw') })
    await flush()
    expect(button('One property')).toBeTruthy()
    expect(button('The company')).toBeUndefined()
  })

  it('a bill a work trader\'s hours keep stays where it was put: its words are corrected without asking the place again', async () => {
    server.gets['/expenses'] = [BILL]
    await render()
    await click('Edit')
    expect(text()).toContain('Goes to The company, where the record it is for put it.')
    expect(chosenPlace()).toEqual([])
    const description = [...host!.querySelectorAll('input')].find(i => (i as HTMLInputElement).value === BILL.description) as HTMLInputElement
    await act(async () => { type(description, 'Lee, September extra hours') })
    await flush()
    expect(button('Save changes')!.disabled).toBe(false)
    await click('Save changes')
    expect(server.patches[0].url).toBe('/expenses/x1')
    expect(server.patches[0].body).toMatchObject({ description: 'Lee, September extra hours' })
    expect(server.patches[0].body).not.toHaveProperty('costPlace')
    expect(server.patches[0].body).not.toHaveProperty('propertyId')
  })

  it('a payment on a bill asks how it was paid — nothing chosen for the person', async () => {
    server.gets['/expenses'] = [BILL]
    await render()
    await click('Record payment')
    const how = [...host!.querySelectorAll('select')].filter(s => [...s.options].some(o => o.textContent === 'Choose how it was paid…')).pop() as HTMLSelectElement
    expect(how.value).toBe('')
    expect(button('Save payment')!.disabled).toBe(true)
    await act(async () => { choose(how, 'cash') })
    await flush()
    expect(button('Save payment')!.disabled).toBe(false)
  })
})
