// @vitest-environment jsdom
/**
 * 10/20 (Nic) — THE SCREEN THAT BRINGS IN RESERVATIONS THAT ALREADY EXIST.
 *
 * What is read off the page here is what Nic has to be able to see at a glance:
 * which of these guests keeps a space they were promised, which ones GAM is
 * free to move, what needs a look before anything lands, and that pressing the
 * button emails nobody.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  posted: [] as { url: string; body: any }[],
  validate: null as any,
  commit: null as any,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (_url: string) => ({ data: { csv: '', columns: [{ field: 'guest_name', names: ['guest', 'name'] }] } }),
  apiPost: async (url: string, body: any) => {
    server.posted.push({ url, body })
    if (url.endsWith('/validate')) return { data: server.validate }
    return { data: server.commit }
  },
}))
const toasted: string[] = []
vi.mock('../components/dialogs', () => ({ toast: (m: string) => { toasted.push(m) } }))

let ReservationImportModal: any, stayLockWords: any, STAY_LOCK_REASON_LABEL: any
let container: HTMLDivElement, root: Root

beforeEach(async () => {
  server.posted = []; toasted.length = 0
  ;({ ReservationImportModal, stayLockWords, STAY_LOCK_REASON_LABEL } = await import('./ReservationImport'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const render = async (props: any = {}) => {
  await act(async () => {
    root.render(<ReservationImportModal
      propertyId="p1" propertyName="Mountain View RV Park"
      onClose={() => {}} onDone={() => {}} {...props} />)
  })
}
const text = () => container.textContent ?? ''
const buttonSaying = (needle: string) =>
  Array.from(container.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(needle))
const click = async (el: Element | undefined) => {
  expect(el, 'button is on the page').toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}
const type = async (el: Element, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const previewOf = (rows: any[], over: any = {}) => ({
  rows,
  summary: {
    total: rows.length,
    blockers: rows.reduce((n, r) => n + (r.issues ?? []).filter((i: any) => i.severity === 'block').length, 0),
    warnings: 0,
    ready: rows.filter(r => !(r.issues ?? []).some((i: any) => i.severity === 'block')).length,
    alreadyIn: 0, locked: rows.filter(r => r.lockedToSite).length,
    placed: rows.filter(r => r.placedByGam).length,
    depositsRecorded: 0, depositTotal: 0,
    ...over.summary,
  },
  notes: over.notes ?? [],
})

const row = (over: any = {}) => ({
  rowIndex: 0, guestName: 'Dale Carter', email: 'dale@example.com', phone: '', propertyName: '',
  unitNumber: 'RV 14', checkIn: '2027-03-06', checkOut: '2027-03-13', nights: 7,
  totalAmount: 286.75, depositPaid: null, depositMethod: null, depositRef: '', externalRef: '',
  notes: '', toldOutsideGam: true, siteId: 'u1', siteNumber: 'RV 14', lockedToSite: true,
  placedByGam: false, alreadyIn: false, issues: [], extra: null, ...over,
})

describe('the two doors, in order', () => {
  it('opens on the old system\'s file and says these booked first', async () => {
    await render()
    expect(text()).toContain('The old system\'s schedule')
    expect(text()).toContain('These booked first')
    expect(text()).toContain('Nobody is emailed')
  })

  it('the typed-in door says what it is for', async () => {
    await render()
    await click(buttonSaying('Typed in from a text'))
    expect(text()).toContain('into whatever is left')
  })

  it('will not check an empty file', async () => {
    await render()
    expect((buttonSaying('Check the file') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the preview', () => {
  it('shows a promised space as locked, with the reason', async () => {
    server.validate = previewOf([row()])
    await render()
    await type(container.querySelector('textarea')!, 'guest_name,site\nDale Carter,RV 14')
    await click(buttonSaying('Check the file'))
    expect(server.posted[0].url).toContain('/bookings/import/validate')
    expect(server.posted[0].body).toMatchObject({ propertyId: 'p1', door: 'file' })
    expect(text()).toContain('RV 14')
    expect(text()).toContain(STAY_LOCK_REASON_LABEL.promised_before_gam) // wire-ok: a local label map keyed by the stored lock reason
    expect(text()).toContain('1 keeping a promised space')
    expect(buttonSaying('Bring in 1 reservation')).toBeTruthy()
  })

  it('says plainly that a space GAM chose can still be moved', async () => {
    server.validate = previewOf([row({ unitNumber: '', lockedToSite: false, placedByGam: true, siteNumber: 'RV 12' })])
    await render()
    await type(container.querySelector('textarea')!, 'x')
    await click(buttonSaying('Check the file'))
    expect(text()).toContain('not promised, so GAM may move them')
  })

  it('refuses to bring anything in while a row needs a look, and names it', async () => {
    server.validate = previewOf([row({
      issues: [{ severity: 'block', field: 'unitNumber',
                 message: 'RV 14 is not free — Ida Brooks has it. Nobody is moved automatically.' }],
    })])
    await render()
    await type(container.querySelector('textarea')!, 'x')
    await click(buttonSaying('Check the file'))
    expect(text()).toContain('Ida Brooks')
    expect(text()).toContain('two rigs on one pad')
    // The field name is printed in words, never as "unitNumber".
    expect(text()).toContain('Space:')
    expect(text()).not.toContain('unitNumber')
    const bring = Array.from(container.querySelectorAll('button')).find(b => (b.textContent ?? '').startsWith('Bring in'))
    expect((bring as HTMLButtonElement).disabled).toBe(true)
  })

  it('carries the file-level notes — the order, and how dates were read', async () => {
    server.validate = previewOf([row()], {
      notes: ['Mountain View RV Park\'s old schedule has not been brought in yet.',
              'Dates written 03/06/2027 are read American style.'],
    })
    await render()
    await type(container.querySelector('textarea')!, 'x')
    await click(buttonSaying('Check the file'))
    expect(text()).toContain('old schedule has not been brought in yet')
    expect(text()).toContain('American style')
  })

  it('brings them in and says nobody was emailed', async () => {
    server.validate = previewOf([row()])
    server.commit = { committed: { created: 1, skipped: 0 } }
    const done = vi.fn()
    await render({ onDone: done })
    await type(container.querySelector('textarea')!, 'x')
    await click(buttonSaying('Check the file'))
    await click(Array.from(container.querySelectorAll('button')).find(b => (b.textContent ?? '').startsWith('Bring in')))
    expect(server.posted[1].url).toContain('/bookings/import/commit')
    expect(server.posted[1].body.rows[0]).toMatchObject({ guestName: 'Dale Carter', unitNumber: 'RV 14' })
    expect(toasted.join(' ')).toContain('Nobody was emailed')
    expect(done).toHaveBeenCalledWith(1)
  })

  it('an edited space is sent back on the next check, not the one the file had', async () => {
    server.validate = previewOf([row({
      issues: [{ severity: 'block', field: 'unitNumber', message: 'RV 14 is not free those nights.' }],
    })])
    await render()
    await type(container.querySelector('textarea')!, 'x')
    await click(buttonSaying('Check the file'))
    const spaceInput = Array.from(container.querySelectorAll('input')).find(i => (i as HTMLInputElement).value === 'RV 14')!
    await type(spaceInput, 'RV 12')
    server.validate = previewOf([row({ unitNumber: 'RV 12', siteNumber: 'RV 12' })])
    await click(buttonSaying('Check again'))
    expect(server.posted[1].body.rows[0].unitNumber).toBe('RV 12')
  })
})

describe('the words for a lock', () => {
  it('names the promise rather than printing the stored value', () => {
    expect(stayLockWords('promised_before_gam')).toContain('old system')
    expect(stayLockWords('promised_at_the_counter')).toContain('desk')
    // A lock from before any of this: somebody ticked the box.
    expect(stayLockWords(null)).toBe('Locked to this space by hand')
    expect(stayLockWords('something_new')).toBe('Locked to this space by hand')
  })
})
