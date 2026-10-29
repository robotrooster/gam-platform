// @vitest-environment jsdom
/**
 * 10/13 (Nic): "landlords need a birthday on their profile" — the Settings →
 * Account birthday box. It shows the landlord's own saved birthday, saves a
 * change through PATCH /auth/me, clears it when emptied, says a refusal, and
 * is not shown at all to anyone but a landlord account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  dob: null as string | null,
  patches: [] as any[],
  refuse: null as null | string,
  role: 'landlord',
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url !== '/auth/me') throw new Error(`unexpected GET ${url}`)
    return { id: 'u1', role: server.role, dateOfBirth: server.dob }
  },
  apiPatch: async (url: string, body: any) => {
    if (url !== '/auth/me') throw new Error(`unexpected PATCH ${url}`)
    server.patches.push(body)
    if (server.refuse) throw httpError(400, server.refuse)
    server.dob = body.dateOfBirth
    return { id: 'u1', date_of_birth: server.dob }
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: server.role } }) }))

import { BirthdayField } from './BirthdayField'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.dob = null; server.patches = []; server.refuse = null; server.role = 'landlord'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const box = () => host.querySelector('input[type="date"]') as HTMLInputElement | null
const save = () => [...host.querySelectorAll('button')].find(b => /^Save$/.test((b.textContent ?? '').trim())) as HTMLButtonElement
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
    root.render(<QueryClientProvider client={qc}><BirthdayField /></QueryClientProvider>)
  })
}

describe('the landlord birthday box', () => {
  it('shows the saved birthday, and Save stays off until it changes', async () => {
    server.dob = '1979-10-14'
    await open()
    await until(() => box()?.value === '1979-10-14', 'the saved birthday')
    expect(text()).toContain('Your birthday')
    expect(save().disabled).toBe(true)
    expect(save().className).toContain('btn-primary')
  })

  it('a new date saves through PATCH /auth/me and reads Saved', async () => {
    await open()
    await until(() => !!box(), 'the box')
    await type(box()!, '1980-04-23')
    expect(save().disabled).toBe(false)
    await act(async () => { save().click() })
    await until(() => text().includes('Saved'), 'the saved note')
    expect(server.patches).toEqual([{ dateOfBirth: '1980-04-23' }])
  })

  it('emptying the box clears the birthday (sends null)', async () => {
    server.dob = '1979-10-14'
    await open()
    await until(() => box()?.value === '1979-10-14', 'the saved birthday')
    await type(box()!, '')
    await act(async () => { save().click() })
    await until(() => server.patches.length === 1, 'the save')
    expect(server.patches[0]).toEqual({ dateOfBirth: null })
  })

  it('a refusal is said under the box', async () => {
    server.refuse = 'That birthday is not a date in the past.'
    await open()
    await until(() => !!box(), 'the box')
    await type(box()!, '1980-04-23')
    await act(async () => { save().click() })
    await until(() => text().includes('not a date in the past'), 'the refusal')
  })

  it('is not shown to a team member', async () => {
    server.role = 'property_manager'
    await open()
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(box()).toBeNull()
    expect(text()).toBe('')
  })
})
