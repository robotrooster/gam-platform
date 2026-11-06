/**
 * 10/31 (Nic) — counting the cash drawer down: what the screens actually render.
 *
 * Written because I had built four states and never once seen them, and saying
 * "the first real look should be yours" is not verification. This renders the
 * component for real against a fake API and reads the DOM, so the four states
 * and the arithmetic on screen are evidence rather than a claim.
 *
 * The component lives in packages/shared-ui so the two register apps cannot
 * drift (pos-parity). Testing it from the landlord app tests the same file the
 * standalone register renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DrawerCount } from '../../../../packages/shared-ui/DrawerCount'

const server = vi.hoisted(() => ({
  registers: [] as any[],
  shift: null as any,
  posts: [] as { url: string; body: any }[],
  patches: [] as { url: string; body: any }[],
  errors: [] as string[],
}))

const api = {
  get: async (url: string) => {
    if (url.startsWith('/pos/registers?')) return server.registers
    if (url.startsWith('/pos/registers/shifts?')) return { shifts: [], summary: {} }
    if (url.startsWith('/pos/registers/shifts/')) return server.shift
    throw new Error(`unexpected GET ${url}`)
  },
  post: async (url: string, body?: any) => { server.posts.push({ url, body }); return {} },
  patch: async (url: string, body?: any) => { server.patches.push({ url, body }); return {} },
  toastError: (m: string) => { server.errors.push(m) },
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  server.registers = []
  server.shift = null
  server.posts = []
  server.patches = []
  server.errors = []
  try { localStorage.clear() } catch { /* fine */ }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

const show = async (canConfigure = true) => {
  await act(async () => {
    root.render(<DrawerCount propertyId="prop-1" api={api as any} canConfigure={canConfigure} />)
  })
  await act(async () => { await Promise.resolve() })
}
/**
 * React ignores a plain `el.value = x` on a controlled input — it tracks the
 * value itself. Going through the prototype's setter is what makes onChange
 * fire, the same helper RecordPaymentWindow.test.tsx uses.
 */
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

const text = () => host.textContent ?? ''
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const clickText = async (label: string) => {
  const b = buttons().find(x => (x.textContent ?? '').includes(label))
  if (!b) throw new Error(`no button matching "${label}" — buttons: ${buttons().map(x => x.textContent).join(' | ')}`)
  await act(async () => { b.click() })
  await act(async () => { await Promise.resolve() })
}

const REGISTER = {
  id: 'reg-1', name: 'Register 1', status: 'active',
  startingCashCents: 10000, startingCashBreakdown: { '500': 5, '100': 75 },
  varianceReasonOverCents: 500,
  openShiftId: null, openShiftWho: null, openShiftOpeningCents: null,
}

describe('no registers yet', () => {
  it('offers to add one, and says what a register is', async () => {
    await show()
    expect(text()).toMatch(/No registers here yet/)
    expect(text()).toMatch(/one cash drawer/)
    // His own reason for per-register amounts.
    expect(text()).toMatch(/break coverage/)
    expect(text()).toMatch(/Confirm and add it/)
  })

  it('tells somebody without permission who to ask, and offers no form', async () => {
    await show(false)
    expect(text()).toMatch(/Ask the owner or a manager/)
    expect(buttons().some(b => (b.textContent ?? '').includes('Confirm and add it'))).toBe(false)
  })

  it('suggests $100 and never writes it without a press', async () => {
    await show()
    const amount = Array.from(host.querySelectorAll('input')).find(i => (i as HTMLInputElement).value === '100')
    expect(amount, 'the suggestion is in the box').toBeTruthy()
    expect(server.posts, 'nothing is written until somebody confirms').toHaveLength(0)
  })
})

describe('this tablet has not been claimed', () => {
  it('asks which register, once, and remembers the answer', async () => {
    server.registers = [REGISTER, { ...REGISTER, id: 'reg-2', name: 'Register 2', startingCashCents: 4000 }]
    await show()
    expect(text()).toMatch(/Which register is this\?/)
    expect(text()).toMatch(/never again/)
    expect(text()).toMatch(/starts with \$100\.00/)
    expect(text()).toMatch(/starts with \$40\.00/)

    await clickText('Register 2')
    expect(text()).toMatch(/Register 2/)
    expect(text()).toMatch(/Start the shift/)
    // Remembered per device, per property.
    expect(localStorage.getItem('gam.register.device.prop-1')).toBe('reg-2')
  })
})

describe('claimed, nobody has said what stays in the drawer', () => {
  it('refuses to start and says why', async () => {
    server.registers = [{ ...REGISTER, startingCashCents: null, startingCashBreakdown: null }]
    await show()
    await clickText('Register 1')
    expect(text()).toMatch(/nothing to count down to/)
    expect(buttons().some(b => (b.textContent ?? '').includes('Start the shift'))).toBe(false)
  })
})

describe('ready to start', () => {
  it('shows the amount and the bills, in his own words', async () => {
    server.registers = [REGISTER]
    await show()
    await clickText('Register 1')
    expect(text()).toMatch(/\$100\.00/)
    // "five 5s and 75 1s" — why a bare total is not enough.
    expect(text()).toMatch(/5 × \$5/)
    expect(text()).toMatch(/75 × \$1/)
    await clickText('Start the shift')
    expect(server.posts.map(p => p.url)).toContain('/pos/registers/reg-1/shifts')
  })
})

describe('counting it down', () => {
  beforeEach(() => {
    // This tablet is already claimed — that is set once per device and never
    // asked again, so the count screen is what a cashier actually opens onto.
    try { localStorage.setItem('gam.register.device.prop-1', 'reg-1') } catch { /* fine */ }
    server.registers = [{ ...REGISTER, openShiftId: 'shift-1', openShiftOpeningCents: 10000 }]
    server.shift = {
      id: 'shift-1', registerName: 'Register 1', varianceReasonOverCents: 500,
      money: { openingCents: 10000, cashSalesCents: 4000, cashRefundsCents: 0, expectedCents: 14000 },
      leads: [],
    }
  })

  it('shows what the drawer should hold, built from its parts', async () => {
    await show()
    expect(text()).toMatch(/counting down/)
    expect(text()).toMatch(/Started with/)
    expect(text()).toMatch(/Cash taken in/)
    expect(text()).toMatch(/Should be in the drawer/)
    expect(text()).toMatch(/\$140\.00/)
  })

  it('a balanced count says so, and the button says what it leaves behind', async () => {
    await show()
    await clickText('Just the total')
    await type(host.querySelector('input.mono') as HTMLInputElement, '140')
    expect(text()).toMatch(/Balanced/)
    expect(text()).toMatch(/Leave \$100\.00 and close the shift/)
  })

  it('a short count names the gap and asks what happened', async () => {
    await show()
    await clickText('Just the total')
    await type(host.querySelector('input.mono') as HTMLInputElement, '120')
    expect(text()).toMatch(/Short/)
    expect(text()).toMatch(/\$20\.00/)
    expect(text()).toMatch(/What happened\?/)
    // Over the threshold it will not close until there is a note.
    const close = buttons().find(b => (b.textContent ?? '').includes('close the shift'))!
    expect(close.disabled).toBe(true)
  })

  it('shows the leads, with an exact match called out and no accusation', async () => {
    server.shift.leads = [
      { kind: 'other_drawer', amountCents: 2000, explainsItExactly: true, ref: 'tx-1',
        what: 'A $20.00 cash sale at 03:28 PM was rung into Back Counter, not this drawer.' },
      { kind: 'open_ticket', amountCents: 900, explainsItExactly: false, ref: 'ot-1',
        what: 'A ticket from 02:10 PM is still open for $9.00.' },
    ]
    await show()
    await clickText('Just the total')
    await type(host.querySelector('input.mono') as HTMLInputElement, '120')
    expect(text()).toMatch(/This accounts for it exactly/)
    expect(text()).toMatch(/rung into Back Counter/)
    expect(text()).toMatch(/still open for \$9\.00/)
    expect(text()).not.toMatch(/theft|stole|steal/i)
  })

  it('says plainly when nothing explains the difference', async () => {
    await show()
    await clickText('Just the total')
    await type(host.querySelector('input.mono') as HTMLInputElement, '120')
    expect(text()).toMatch(/Nothing in this shift accounts for the difference/)
    expect(text()).toMatch(/retracing/)
  })

  it('counting the bills adds them up and sends the breakdown', async () => {
    await show()
    const denoms = Array.from(host.querySelectorAll('input.mono')) as HTMLInputElement[]
    // The $20 box is third in the list (100, 50, 20, ...).
    await type(denoms[2], '7')
    expect(text()).toMatch(/\$140\.00/)
    expect(text()).toMatch(/Balanced/)
    await clickText('close the shift')
    const sent = server.posts.find(p => p.url.includes('/count'))!
    expect(sent.body.countedCents).toBe(14000)
    expect(sent.body.countedBreakdown).toEqual({ '2000': 7 })
  })
})
