/**
 * 10/19 (Nic): "Fix invite flag overridden in first 28 days."
 *
 * "Already lives here" is a MONEY answer, not a screening answer. Ticked, the
 * resident's first bill is one whole month's rent and nothing else — no
 * prorated part-month, no security deposit, no pet or utility deposit, no
 * move-in fee — because nothing about their tenancy started the day they
 * signed, only the paperwork did.
 *
 * Two things were wrong on this screen and both of them move real money:
 *
 *   1. The option was offered only while THIS PROPERTY'S onboarding window was
 *      open, but the server's rule for it is that window OR the landlord's own
 *      28 days. Between a property's window closing on day 14 and the
 *      account's 28th day the option therefore vanished while the server would
 *      still have taken it, so a sitting resident papered on day 20 was billed
 *      the whole new-move-in packet with no box anywhere to say otherwise.
 *
 *   2. It read as a background-check question ("skip background check"), so a
 *      landlord could pick it without knowing it zeroes the deposits. Once the
 *      lease is signed there is no putting that back — the proration box on
 *      the signing page is locked.
 *
 * Skipping the background check is still the property's window alone (S579,
 * and it never reopens). In the band they are papered as a sitting resident
 * and they screen anyway, and the copy has to say so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  units: [] as any[],
  windows: [] as any[],
  posts: [] as { url: string; body: any }[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/units') return JSON.parse(JSON.stringify(server.units))
    if (url === '/landlords/me/onboarding-windows') return JSON.parse(JSON.stringify(server.windows))
    if (url.startsWith('/space-carryforward/unit/')) return null
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url === '/tenants/invite') {
      return { success: true, data: { leaseDrafted: true, draftBlocked: [], people: [
        { email: body.email, name: 'Kay Howard', inviteSent: false, alreadyOnPlatform: false, needsOwnSignature: false },
      ] } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
}))
vi.mock('./TenantOnboardingPage', () => ({
  HomeSaleToggle: () => null,
  PacketChecklist: () => null,
  homeSalePayload: () => undefined,
  homeSaleComplete: () => true,
  tickedIds: () => [],
}))

import { InviteTenantModal } from './InviteTenantModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const apt = {
  id: 'u-a12', unitNumber: 'A12', propertyId: 'p-mv', propertyName: 'Mountain View',
  bedrooms: 1, bathrooms: 1, rentAmount: 500, unitType: 'apartment', dwellingOwnership: 'landlord',
  tenantId: null, status: 'vacant', pendingInviteCount: 0,
}

/**
 * The window row as /landlords/me/onboarding-windows hands it over.
 * `open` is this property's 14 days (the background-check waive);
 * `existingTenancyOpen` is the server's own answer to "may this invite say they
 * already live here" — this window OR the landlord's 28 days.
 */
const window_ = (over: any = {}) => ({
  propertyId: 'p-mv', propertyName: 'Mountain View',
  open: true, accountWindowOpen: true, existingTenancyOpen: true,
  daysRemaining: 9, windowDays: 14, unitCount: 6, returningAllowanceLeft: 1,
  lateFeeWaiver: null, draftRosterCount: 0, lateInMonth: false, nextRentDueDate: null,
  ...over,
})
/** Day 20: the property's 14 days are up, the landlord's 28 are not. */
const inTheBand = () => window_({ open: false, daysRemaining: 0, accountWindowOpen: true, existingTenancyOpen: true })
/** An established account, no property onboarding running. */
const noWindow = () => window_({ open: false, daysRemaining: 0, accountWindowOpen: false, existingTenancyOpen: false })

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.units = [apt]
  server.windows = [window_()]
  server.posts = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const inputs = () => [...host.querySelectorAll('input')] as HTMLInputElement[]
const buttons = () => [...host.querySelectorAll('button')]
const button = (re: RegExp) => buttons().find(b => re.test(b.textContent ?? ''))
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function press(re: RegExp) {
  await until(() => !!button(re) && !button(re)!.disabled, `an enabled ${re} button`)
  await act(async () => { button(re)!.click() })
}
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }

/** The "Already lives here" choice, by its own words rather than its position. */
const sittingLabel = () => [...host.querySelectorAll('label')]
  .find(l => (l.textContent ?? '').includes('They already live here'))
const sittingRadio = () => sittingLabel()?.querySelector('input[type=radio]') as HTMLInputElement | undefined

async function toUnitStep() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}><InviteTenantModal onClose={vi.fn()} /></QueryClientProvider>)
  })
  await until(() => text().includes('Primary resident'), 'the invite form')
  const [first, last, email] = inputs()
  await type(first, 'Kay')
  await type(last, 'Howard')
  await type(email, 'kay@example.test')
  await press(/^Next/)
  await until(() => text().includes('A12'), 'the unit list')
  const row = [...host.querySelectorAll('div')].find(d =>
    (d.textContent ?? '').includes('Unit A12') && (d.getAttribute('style') ?? '').includes('cursor: pointer'))
  await click(row!)
  await until(() => text().includes('New applicant'), 'the screening choices')
}

describe('the "already lives here" choice on the invite', () => {
  it('says what it costs, not just that the background check is skipped', async () => {
    await toUnitStep()
    await until(() => !!sittingRadio(), 'the already-lives-here choice')
    const said = sittingLabel()!.textContent ?? ''
    expect(said).toContain('their tenancy started before today')
    expect(said).toMatch(/one whole month.s rent and nothing else/)
    expect(said).toContain('no security deposit')
    expect(said).toContain('no pet or utility deposit')
    expect(said).toContain('no move-in fee')
    expect(said).toMatch(/once the lease is signed this cannot be changed/)
    // The property's window is open here, so it does waive the check.
    expect(said).toMatch(/without a background check/)
  })

  it('is still offered after the property window closes, inside the landlord 28 days', async () => {
    server.windows = [inTheBand()]
    await toUnitStep()
    await until(() => !!sittingRadio(), 'the already-lives-here choice in the band')
    const said = sittingLabel()!.textContent ?? ''
    // The money half still applies...
    expect(said).toMatch(/one whole month.s rent and nothing else/)
    // ...and the screening half does not, which it says plainly.
    expect(said).toMatch(/still complete a background check/)
    expect(said).not.toMatch(/without a background check/)
  })

  it('and picking it there sends the answer to the server', async () => {
    server.windows = [inTheBand()]
    await toUnitStep()
    await until(() => !!sittingRadio(), 'the already-lives-here choice')
    await click(sittingRadio()!)
    await until(() => sittingRadio()!.checked, 'the choice to take')
    await press(/^Next/)
    await press(/Send|Invite|Draft/)
    await until(() => server.posts.length > 0, 'the invite call')
    const invite = server.posts.find(p => p.url === '/tenants/invite')!
    expect(invite.body.existingResident).toBe(true)
  })

  it('is not offered at all once both windows are shut', async () => {
    server.windows = [noWindow()]
    await toUnitStep()
    // The other two doors are there; this one is not.
    expect(text()).toContain('New applicant')
    expect(sittingRadio()).toBeUndefined()
  })

  it('a new applicant at an open window never sends the answer', async () => {
    await toUnitStep()
    await until(() => !!sittingRadio(), 'the choices')
    await press(/^Next/)
    await press(/Send|Invite|Draft/)
    await until(() => server.posts.length > 0, 'the invite call')
    // 'screen' is the default, so this goes out as a property-level invite with
    // no existing-tenancy answer on it at all.
    for (const p of server.posts) expect(p.body.existingResident).toBeUndefined()
  })
})
