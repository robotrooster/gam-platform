/**
 * 10/19 (Nic) — THE QUESTION THE INVITE SCREEN ASKS.
 *
 *   "I want to see how that carry forward balance flow goes. I want to see what
 *    triggers, what actually asks the landlord, hey, is your new tenant carrying
 *    forward this balance from this spot?"
 *
 * Inviting somebody onto a space that carries unpaid space rent cannot happen
 * in silence. The landlord answers, because it is a CONDITION OF MOVING IN:
 *
 *   "If Jacob declines, he's not moving into the park. ... Space rent is owed,
 *    and he can buy the trailer all he wants, but he doesn't get to move in
 *    without following the rules of the park, without paying the bills."
 *
 * So there are three things to hold here, and a fourth that is just as
 * important: a space that carries NOTHING must ask nothing at all. Almost every
 * space in GAM carries nothing, and a question on all of them would be noise
 * that trains a landlord to click past the one that matters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  units: [] as any[],
  /** GET /space-carryforward/unit/:id — the claim on the picked space, or null. */
  claim: null as any,
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  /** When set, POST /space-carryforward/:id/assumption fails. */
  assumptionFails: false,
  /** When set, GET /space-carryforward/unit/:id fails (a 403 for a scoped role, or a 500). */
  claimFails: null as null | { status: number; error: string },
  /** When set, that read WAITS on this — the landlord pressing Next first. */
  claimHold: null as null | Promise<void>,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/units') return JSON.parse(JSON.stringify(server.units))
    if (url === '/landlords/me/onboarding-windows') return []
    if (url.startsWith('/space-carryforward/unit/')) {
      if (server.claimFails) {
        throw Object.assign(new Error(server.claimFails.error),
          { response: { status: server.claimFails.status, data: { success: false, error: server.claimFails.error } } })
      }
      if (server.claimHold) await server.claimHold
      return JSON.parse(JSON.stringify(server.claim))
    }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url === '/tenants/invite') {
      return { success: true, data: { leaseDrafted: true, draftBlocked: [], people: [
        { email: body.email, name: `${body.firstName} ${body.lastName}`, inviteSent: false, alreadyOnPlatform: false, needsOwnSignature: false },
      ] } }
    }
    if (/\/space-carryforward\/.+\/assumption$/.test(url)) {
      if (server.assumptionFails) throw Object.assign(new Error('nope'), { response: { status: 500, data: { error: 'nope' } } })
      return { success: true, data: { line: 'Taken on as a condition of moving in', alreadyRecorded: false } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
}))
// The home-sale and document-packet controls belong to the onboarding page and
// are not what this file is about; the real ones drag the whole page in.
vi.mock('./TenantOnboardingPage', () => ({
  HomeSaleToggle: () => null,
  PacketChecklist: () => null,
  homeSalePayload: () => undefined,
  homeSaleComplete: () => true,
  tickedIds: () => [],
}))

import { InviteTenantModal } from './InviteTenantModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** MH 09 at Oak Park: a tenant-owned mobile home, vacant and invitable. */
const mh09 = {
  id: 'u-mh09', unitNumber: 'MH 09', propertyId: 'p-oak', propertyName: 'Oak Park',
  bedrooms: 2, bathrooms: 1, rentAmount: 440, unitType: 'mobile_home', dwellingOwnership: 'tenant',
  tenantId: null, status: 'vacant', pendingInviteCount: 0,
}
/** An ordinary apartment, which never carries anything. */
const apt = {
  id: 'u-a12', unitNumber: 'A12', propertyId: 'p-oak', propertyName: 'Oak Park',
  bedrooms: 1, bathrooms: 1, rentAmount: 900, unitType: 'apartment', dwellingOwnership: 'landlord',
  tenantId: null, status: 'vacant', pendingInviteCount: 0,
}
/** The $880 Rashawn left on MH 09, as the server hands it over. */
const carried = (over: any = {}) => ({
  id: 'cf-1', unitId: 'u-mh09', spaceName: 'MH 09', propertyName: 'Oak Park',
  amount: 880, settledAmount: 0, stillOwed: 880, lateFeesWaived: 95, status: 'open',
  openedOn: '2026-10-19', oldestDueDate: '2026-09-01', settledOn: null, takenOffOn: null,
  owedByName: 'Rashawn Bump', assumedByName: null, assumedLeaseId: null,
  chargeLabel: 'Unpaid space rent left on this space by the previous owner of the home',
  arrangement: null, installments: [], followsToNextLease: true,
  ...over,
})

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn>
beforeEach(() => {
  server.units = [mh09, apt]
  server.claim = null
  server.gets = []
  server.posts = []
  server.assumptionFails = false
  server.claimFails = null
  server.claimHold = null
  onClose = vi.fn()
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
const button = (re: RegExp) => buttons().find(b => re.test(b.textContent ?? ''))
const inputs = () => [...host.querySelectorAll('input')] as HTMLInputElement[]
const radios = () => inputs().filter(i => i.type === 'radio' && i.name === 'assumes')
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

async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}><InviteTenantModal onClose={onClose} /></QueryClientProvider>)
  })
  await until(() => text().includes('Primary resident'), 'the invite form')
  return qc
}

/** Fill in Jacob, go to the unit step and pick a space. */
async function toUnitStep(unitNumber: string) {
  const [first, last, email] = inputs()
  await type(first, 'Jacob')
  await type(last, 'Dalton')
  await type(email, 'jacob@example.test')
  await press(/^Next/)
  await until(() => text().includes(unitNumber), 'the unit list')
  const row = [...host.querySelectorAll('div')].find(d =>
    (d.textContent ?? '').includes(`Unit ${unitNumber}`) && (d.getAttribute('style') ?? '').includes('cursor: pointer'))
  await click(row!)
  // Nobody screens in this walk: the landlord is putting the home's buyer on
  // the space, so the lease drafts now rather than a background check going out.
  const returningRadio = () => [...host.querySelectorAll('label')]
    .find(l => (l.textContent ?? '').includes('Returning resident'))
    ?.querySelector('input[type=radio]') as HTMLInputElement | undefined
  await until(() => !!returningRadio(), 'the screening choices')
  await click(returningRadio()!)
  await until(() => returningRadio()!.checked, 'the returning-resident choice')
}

describe('inviting someone to a space that carries a balance', () => {
  it('asks the question, with the figure and whose it was', async () => {
    server.claim = carried()
    await open()
    await toUnitStep('MH 09')

    await until(() => radios().length === 2, 'the question')
    // The figure, the space, and the man who left it.
    expect(text()).toContain('MH 09 carries $880.00 of unpaid space rent')
    expect(text()).toContain('Rashawn Bump')
    expect(text()).toContain('Is the new resident taking this balance on?')
    // The two promises the resident will ask about.
    expect(text()).toMatch(/never gets a late fee/)
    expect(text()).toMatch(/not part of the resident.s payment history/)
    // And it reads the space, not a guess from the unit row.
    expect(server.gets).toContain('/space-carryforward/unit/u-mh09')
  })

  it('cannot be skipped in silence — Next refuses until it is answered', async () => {
    server.claim = carried()
    await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')

    // Unanswered: the step does not advance and says what is missing.
    await press(/^Next/)
    expect(text()).toContain('Answer whether they are taking')
    expect(text()).not.toContain('Review and send the invite')
    expect(server.posts).toEqual([])

    // Answered YES: through, and the review screen repeats the condition.
    await click(radios()[0])
    await press(/^Next/)
    await until(() => text().includes('Review and send the invite'), 'the confirm step')
    expect(text()).toContain('Taking on $880.00 of unpaid space rent')
  })

  it('answering NO stops the invite outright, and says why', async () => {
    server.claim = carried()
    await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')

    await click(radios()[1])
    await press(/^Next/)
    // Nic: "If Jacob declines, he's not moving into the park."
    expect(text()).toContain('they do not move onto this space')
    expect(text()).toMatch(/Take the balance off first/)
    expect(text()).not.toContain('Review and send the invite')
    expect(server.posts).toEqual([])
  })

  it('sends the invite and records that the condition was put on him', async () => {
    server.claim = carried()
    await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')
    await click(radios()[0])
    await press(/^Next/)
    await press(/Invite and draft the lease/)
    await until(() => text().includes('Lease drafted'), 'the result')

    // The invite first, then the record — recording a condition on somebody who
    // was never invited would be a lie in the record.
    expect(server.posts.map(p => p.url)).toEqual(['/tenants/invite', '/space-carryforward/cf-1/assumption'])
    expect(server.posts[1].body.residents).toEqual([{ name: 'Jacob Dalton', email: 'jacob@example.test' }])
    // And the result screen says what happens to the money.
    expect(text()).toContain('$880.00')
    expect(text()).toMatch(/moves onto their lease as its own line/)
  })

  it('a failed record never loses the invite — it says what to press instead', async () => {
    server.claim = carried()
    server.assumptionFails = true
    await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')
    await click(radios()[0])
    await press(/^Next/)
    await press(/Invite and draft the lease/)
    await until(() => text().includes('Lease drafted'), 'the result')
    expect(text()).toMatch(/did not save/)
    expect(text()).toContain('What this space carries')
  })

  it('throws the answer away when the landlord picks a different space', async () => {
    server.claim = carried()
    await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')
    await click(radios()[0])
    expect(radios()[0].checked).toBe(true)

    // A yes on MH 09's $880 must not carry across to another space's figure.
    server.claim = carried({ id: 'cf-2', unitId: 'u-a12', spaceName: 'A12', stillOwed: 120 })
    const row = [...host.querySelectorAll('div')].find(d =>
      (d.textContent ?? '').includes('Unit A12') && (d.getAttribute('style') ?? '').includes('cursor: pointer'))
    await click(row!)
    await until(() => radios().length === 2 && text().includes('A12 carries $120.00'), 'the new figure')
    expect(radios().every(r => !r.checked)).toBe(true)
  })
})

describe('inviting someone to a space that carries nothing', () => {
  it('asks nothing at all', async () => {
    server.claim = null
    await open()
    await toUnitStep('A12')

    await press(/^Next/)
    await until(() => text().includes('Review and send the invite'), 'the confirm step')
    expect(radios()).toHaveLength(0)
    expect(text()).not.toMatch(/taking this balance on/)
    expect(text()).not.toMatch(/unpaid space rent/)

    await press(/Invite and draft the lease/)
    await until(() => text().includes('Lease drafted'), 'the result')
    // No record call: there is nothing to record.
    expect(server.posts.map(p => p.url)).toEqual(['/tenants/invite'])
  })

  it('asks nothing on a balance that will not move — the park took the home over', async () => {
    // Still owed by the man who left, but it lands on nobody new, so putting
    // the question in front of the landlord would be asking him to impose a
    // condition the engine would not in fact apply.
    server.claim = carried({ followsToNextLease: false })
    await open()
    await toUnitStep('MH 09')
    await press(/^Next/)
    await until(() => text().includes('Review and send the invite'), 'the confirm step')
    expect(radios()).toHaveLength(0)
  })

  it('asks nothing on a balance that is already paid off', async () => {
    server.claim = carried({ status: 'settled', settledAmount: 880, stillOwed: 0, settledOn: '2026-10-18' })
    await open()
    await toUnitStep('MH 09')
    await press(/^Next/)
    await until(() => text().includes('Review and send the invite'), 'the confirm step')
    expect(radios()).toHaveLength(0)
  })
})

/**
 * THE QUESTION MUST NOT FAIL OPEN. `carries` is null while the read is in the
 * air and null again when it fails, and both guards read `carries &&` — so
 * Next used to walk straight past the question on the one space that has one,
 * the invite went, the lease drafted, the database trigger moved the $880 onto
 * it, and nothing recorded that the condition had ever been put on anybody.
 * The money moves whatever this screen does, which is exactly why the screen
 * must not go quiet.
 */
describe('when the space’s balance cannot be read', () => {
  it('a read that fails stops the invite and says so, with a way to try again', async () => {
    server.claim = carried()
    server.claimFails = { status: 403, error: 'Not authorized for property-scoped actions' }
    await open()
    await toUnitStep('MH 09')
    await until(() => text().includes('could not be read'), 'the refusal')

    // No question (there is nothing to ask about yet) and no way forward.
    expect(radios()).toHaveLength(0)
    await press(/^Next/)
    expect(text()).toContain('nobody can be asked to take it on yet')
    expect(text()).not.toContain('Review and send the invite')
    expect(server.posts).toEqual([])

    // It answers on the retry: the question appears and the invite can go.
    server.claimFails = null
    await press(/Try again/)
    await until(() => radios().length === 2, 'the question')
    expect(text()).toContain('MH 09 carries $880.00 of unpaid space rent')
  })

  it('a read still in the air stops the invite — Next cannot outrun it', async () => {
    server.claim = carried()
    let letItAnswer: () => void = () => {}
    server.claimHold = new Promise<void>(r => { letItAnswer = r })
    await open()
    await toUnitStep('MH 09')
    await until(() => text().includes('Checking whether this space carries'), 'the waiting line')

    await press(/^Next/)
    expect(text()).toContain('Checking what this space carries')
    expect(text()).not.toContain('Review and send the invite')
    expect(server.posts).toEqual([])

    // Once it answers, the question is there to be answered.
    letItAnswer()
    server.claimHold = null
    await until(() => radios().length === 2, 'the question')
  })

  it('a read that fails after the step was passed stops the press itself', async () => {
    server.claim = carried()
    const qc = await open()
    await toUnitStep('MH 09')
    await until(() => radios().length === 2, 'the question')
    await click(radios()[0])
    await press(/^Next/)
    await until(() => text().includes('Review and send the invite'), 'the confirm step')

    // The read happens again, the way the app re-reads it, and fails this time.
    // The press must not send on an answer the screen can no longer stand behind.
    server.claimFails = { status: 500, error: 'boom' }
    await act(async () => { await qc.invalidateQueries(['space-carryforward-unit', 'u-mh09']) })

    await press(/Invite and draft the lease/)
    expect(server.posts).toEqual([])
    // Back on the unit step, where the refusal is.
    await until(() => text().includes('could not be read'), 'the unit step again')
    expect(text()).toContain('nobody can be asked to take it on yet')
  })
})
