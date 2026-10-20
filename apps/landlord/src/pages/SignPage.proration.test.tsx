// @vitest-environment jsdom
/**
 * 10/19 (Nic) — THE PRORATED RENT IS CALCULATED, AND THE START DATE IS PICKED.
 *
 *   "Just lock the box so it's not typable. The prorated box. Yeah, we want the
 *    deposit and pet deposit to be typable. The proration is derived from a
 *    mid-month start. That's based on their lease amount. It should be
 *    auto-calculated. That doesn't need to be, that one does not need to be
 *    typable."
 *
 *   "make it so that box can only be a calendar date pick and not possible to
 *    be typed in by hand. That way we're looking at eliminating the possibility
 *    of making mistakes, because eventually I'd like to be able to trust
 *    somebody else to fill out leases."
 *
 * What went wrong: Kay Howard (RV 21) and Clint Cook (RV 18) were both drafted
 * days after they arrived, both dated 10/15 — the day the forms were filled out
 * — and both charged $323.00, the 17 days from the 15th. One was about $38
 * short, the other about $19 over. The proration had stopped following the
 * start date the moment anything was typed into it.
 *
 * Every mocked answer is built as the SERVER sends it (snake_case) and passed
 * through camelCaseKeys — what the API's own outgoing middleware does to every
 * response — so a key renamed on either side fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { camelizeKeys } from '@gam/shared'

// pdf.js never loads in a test: the page only needs a canvas it can size.
vi.mock('../lib/pdfjs', () => ({
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    }),
  }),
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('../components/dialogs', () => ({
  toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }),
  appConfirm: vi.fn(async () => true),
}))

import { SignPage, prorationExplainer } from './SignPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** One landlord-role box on page 1 of the lease. */
function field(id: string, lease_column: string | null, field_type: string, value: string | null, y = 100) {
  return {
    id, template_field_id: `t-${id}`, parent_field_id: null, parent_option: null,
    field_type, signer_role: 'landlord', label: lease_column ?? field_type, lease_column,
    page: 1, x: 50, y, width: 120, height: 20, required: true, value, options: null,
    checkbox_mark: 'x', font_css: null, mine: true,
  }
}

/** The lease behind both Mountain View RV sites: $589 a month, rent due the 1st. */
function leasePayload(over: {
  start?: string | null
  rent?: string
  dueDay?: string
  prorates?: boolean
  existingTenancy?: boolean
  renewsLeaseId?: string | null
  rentDueMode?: string
  dueDayRule?: number
  noDueDayBox?: boolean
} = {}) {
  return {
    signer: { id: 's1', name: 'Nic Rhoades', role: 'landlord', status: 'sent', order_index: 1 },
    document: {
      id: 'doc1', title: 'Mountain View RV Lease', status: 'in_progress', document_type: 'original_lease',
      base_pdf_url: '/uploads/lease.pdf', property_name: 'Mountain View',
      renews_lease_id: over.renewsLeaseId ?? null, unit_number: 'RV 21',
    },
    fields: [
      field('start', 'start_date', 'date', over.start === undefined ? '10/15/2026' : over.start, 100),
      field('end', 'end_date', 'date', '10/14/2027', 130),
      field('rent', 'rent_amount', 'text', over.rent ?? '589.00', 160),
      ...(over.noDueDayBox ? [] : [field('dueday', 'rent_due_day', 'text', over.dueDay ?? '1st', 190)]),
      field('deposit', 'security_deposit', 'text', '500.00', 220),
      field('petdeposit', 'pet_deposit', 'text', '250.00', 250),
      field('firstmonth', 'move_in_first_month_rent', 'text', '0.00', 280),
      field('prorate', 'move_in_proration', 'text', '323.00', 310),
      field('depositmirror', 'move_in_security_deposit', 'text', '500.00', 340),
      field('total', 'move_in_total_due', 'text', '1073.00', 370),
    ],
    deposit_interest_context: null,
    carried_deposit: null,
    carried_rent: null,
    renewal_billing: null,
    property_late_fee: null,
    existing_tenancy: over.existingTenancy === true,
    rent_due_mode: over.rentDueMode ?? 'fixed_day',
    prorates_mid_month_rent: over.prorates !== false,
    // What the server reads off the property (or the invite) for a form with no
    // "rent is due on the" box — which is every template that prints a
    // prorated-rent line.
    rent_due_day_rule: over.dueDayRule ?? 1,
    readOnly: false,
    waitingOn: null,
    closedReason: null,
    packageDocs: [],
  }
}

let host: HTMLDivElement
let root: Root
let payload: any

beforeEach(() => {
  toasts.length = 0
  payload = leasePayload()
  // SigPreview draws the font samples on a canvas; jsdom has none.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: () => {}, fillText: () => {}, set font(_v: string) {}, set fillStyle(_v: string) {},
    set textBaseline(_v: string) {},
  } as any)
  // The field boxes are positioned from the container's own width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('/esign/sign/')) return { success: true, data: camelizeKeys(payload) }
      throw new Error(`unexpected fetch ${url}`)
    },
  })))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function settle(times = 12) {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

/** Render the signing page and walk past the one-time signature setup. */
async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/sign/doc1']}>
          <Routes><Route path="/sign/:token" element={<SignPage/>}/></Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await settle()
  const go = Array.from(host.querySelectorAll('button'))
    .find(b => /Continue to Document/.test(b.textContent || '')) as HTMLButtonElement
  expect(go).toBeTruthy()
  await act(async () => { go.click() })
  await settle()
}

const boxText = (id: string) => (host.querySelector('#field-' + id) as HTMLElement | null)?.textContent ?? null
const overlay = () => Array.from(host.querySelectorAll('div')).find(d => d.style.position === 'fixed') ?? null
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
  await settle(4)
}
const pickDay = (iso: string) => host.querySelector(`[data-day="${iso}"]`)
/** Type into a box the way a person does — React's own value tracker needs the native setter. */
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(4)
}

describe('the prorated rent follows the date that is picked', () => {
  it('Oct 14 on a $589 lease due the 1st is the 18/31 share, and Oct 10 is 22/31', async () => {
    await open()
    // What the two Mountain View leases were signed at: 17 days from 10/15.
    expect(boxText('prorate')).toBe('323.00')

    await click(host.querySelector('#field-start'))
    await click(pickDay('2026-10-14'))
    expect(boxText('prorate')).toBe('342.00')          // 589 × 18/31

    await click(pickDay('2026-10-10'))
    expect(boxText('prorate')).toBe('418.00')          // 589 × 22/31
  })

  it('the editor stays open when a day is picked — Blu signed nine leases through it', async () => {
    await open()
    await click(host.querySelector('#field-start'))
    expect(pickDay('2026-10-14')).toBeTruthy()
    await click(pickDay('2026-10-14'))
    // Still open: the grid, the read-back and Save are all still on screen.
    expect(pickDay('2026-10-16')).toBeTruthy()
    expect(host.textContent).toContain('Wednesday, October 14, 2026')
    expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent === 'Save')).toBe(true)
  })

  it('the start date cannot be typed — there is no input in the picker', async () => {
    await open()
    await click(host.querySelector('#field-start'))
    const open_ = overlay()!
    expect(open_.querySelectorAll('input').length).toBe(0)
    expect(open_.querySelectorAll('textarea').length).toBe(0)
    // And the month moves by clicking, not by typing a month in.
    await click(Array.from(open_.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Next month'))
    expect(host.textContent).toContain('November 2026')
  })

  it('the full days in the real month, never a flat 30 — February and a 31-day month', async () => {
    payload = leasePayload({ start: '02/14/2026' })
    await open()
    expect(boxText('prorate')).toBe('315.54')          // 589 × 15/28, not 294.50
    expect(boxText('prorate')).not.toBe('294.50')

    await click(host.querySelector('#field-start'))
    await click(pickDay('2026-02-15'))
    expect(boxText('prorate')).toBe('294.50')          // 589 × 14/28 — the same figure a flat 30 fakes for the 14th
  })
})

describe('the prorated box is not typable', () => {
  it('clicking it opens an explainer with nothing to type into', async () => {
    await open()
    await click(host.querySelector('#field-prorate'))
    const open_ = overlay()!
    expect(open_.textContent).toContain('Prorated rent — worked out for you')
    expect(open_.querySelectorAll('input').length).toBe(0)
    expect(open_.querySelectorAll('textarea').length).toBe(0)
    expect(open_.querySelectorAll('select').length).toBe(0)
    // No Save either: there is nothing here to commit.
    expect(Array.from(open_.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Close'])
    expect(open_.textContent).toContain('17 days — October 15 up to November 1 — out of the 31')
  })

  it('a stale figure in the box is overwritten, not kept', async () => {
    // A draft from before this change, where somebody typed over the line.
    payload = leasePayload()
    payload.fields.find((f: any) => f.id === 'prorate').value = '100.00'
    await open()
    expect(boxText('prorate')).toBe('323.00')
  })

  it('a property that answers No to mid-month proration charges the whole month', async () => {
    payload = leasePayload({ prorates: false })
    await open()
    expect(boxText('prorate')).toBe('589.00')
    await click(host.querySelector('#field-prorate'))
    expect(overlay()!.textContent).toContain('bills a whole month as a whole month')
  })

  it('an onboarding resident and a renewal both still read $0', async () => {
    payload = leasePayload({ existingTenancy: true })
    await open()
    expect(boxText('prorate')).toBe('0.00')
    expect(boxText('firstmonth')).toBe('589.00')
    await act(async () => root.unmount())

    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    payload = leasePayload({ renewsLeaseId: 'lease-before' })
    await open()
    expect(boxText('prorate')).toBe('0.00')
    expect(boxText('firstmonth')).toBe('0.00')
  })
})

describe('the deposits are still typed', () => {
  it('the security deposit and the pet deposit open focused, ready to type (S632)', async () => {
    await open()
    for (const [id, was] of [['deposit', '500.00'], ['petdeposit', '250.00']] as const) {
      await click(host.querySelector('#field-' + id))
      const input = overlay()!.querySelector('input') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe(was)
      // Typing a new amount sticks — these two are the landlord's to set.
      await type(input, '600.00')
      await click(Array.from(overlay()!.querySelectorAll('button')).find(b => b.textContent === 'Save'))
      expect(boxText(id)).toBe('600.00')
    }
  })
})

describe('the words beside the figure', () => {
  const base = {
    figure: '323.00', startIso: '2026-10-15', rent: 589, dueDay: 1,
    prorates: true, moveInDay: false, renewal: false, existingTenancy: false,
    propertyName: 'Mountain View',
  }
  it('counts the real days of the real month', () => {
    expect(prorationExplainer(base).words).toBe(
      '17 days — October 15 up to November 1 — out of the 31 in that period, at $589.00 a month: $323.00.')
    expect(prorationExplainer({ ...base, startIso: '2026-02-14', figure: '315.54' }).words)
      .toContain('out of the 28 in that period')
  })
  it('says why it is $0 when it is $0', () => {
    expect(prorationExplainer({ ...base, renewal: true }).words).toContain('bills no rent on this page')
    expect(prorationExplainer({ ...base, existingTenancy: true }).words).toContain('already lives here')
    expect(prorationExplainer({ ...base, moveInDay: true }).words).toContain('move-in day')
    expect(prorationExplainer({ ...base, startIso: '2026-10-01' }).words).toContain('nothing to prorate')
  })
  it('asks for the start date when there is not one yet', () => {
    expect(prorationExplainer({ ...base, startIso: null }).words).toBe(
      'Pick the lease start date and this figure fills itself in from it.')
  })

  // 10/19 review: the amber note under the sentence used to say "the start date
  // is what to fix" in all five cases, including the three where moving the
  // start date changes nothing — the three a clerk is most likely to question.
  it('names the start date as the lever only where the start date IS the lever', () => {
    expect(prorationExplainer(base).lever).toContain('the start date is what to fix')
    expect(prorationExplainer({ ...base, startIso: '2026-10-01' }).lever).toContain('the start date is what to fix')
    expect(prorationExplainer({ ...base, startIso: null }).lever).toContain('the start date is what to fix')
  })
  it('says the start date does NOT move it on a renewal, an onboarding resident, a whole-month park', () => {
    for (const over of [{ renewal: true }, { existingTenancy: true }, { prorates: false }, { moveInDay: true }]) {
      const { lever } = prorationExplainer({ ...base, ...over })
      expect(lever).toContain('The start date does not move it')
      expect(lever).not.toContain('the start date is what to fix')
    }
    expect(prorationExplainer({ ...base, existingTenancy: true }).lever).toContain('their invite')
    expect(prorationExplainer({ ...base, prorates: false }).lever).toContain('property setting')
  })
})

// 10/19 review — THE DAY RENT IS DUE, WHEN THE FORM HAS NO BOX FOR IT.
//
// Not one of the six templates that prints a prorated-rent line carries a
// "rent is due on the" box, so the page had nothing to read and used the 1st.
// At a park due on the 15th the draft stamped the right figure and this page
// overwrote it with the one for the 1st — and with the box locked there was no
// way to put the right number back.
describe("the park's own due day, with no due-day box on the form", () => {
  it('a park due the 15th prorates to the 15th, not to the 1st', async () => {
    payload = leasePayload({ noDueDayBox: true, dueDayRule: 15, start: '10/20/2026' })
    await open()
    // 10/20 up to 11/15 is 26 of the 31 days in that period: $494.00.
    // To the 1st it would be 12/31 = $228.00, and the month between would be
    // billed by nothing at all.
    expect(boxText('prorate')).toBe('494.00')
    await click(host.querySelector('#field-prorate'))
    expect(overlay()!.textContent).toContain('26 days — October 20 up to November 15')
  })

  it('and the mirror case does not double-charge: 10/10 to the 15th is 5 days', async () => {
    payload = leasePayload({ noDueDayBox: true, dueDayRule: 15, start: '10/10/2026' })
    await open()
    // 10/10 up to 10/15 is 5 of the 30 days from 9/15: $98.17. To the 1st it
    // would be $418.00, and the regular run would bill the whole month again
    // on the 15th.
    expect(boxText('prorate')).toBe('98.17')
  })

  it('a due-day box on the form still wins over the park rule', async () => {
    payload = leasePayload({ dueDay: '1st', dueDayRule: 15, start: '10/20/2026' })
    await open()
    expect(boxText('prorate')).toBe('228.00')          // 589 × 12/31
  })
})
