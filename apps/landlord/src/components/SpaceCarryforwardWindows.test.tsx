/**
 * 10/19 (Nic) — THE TWO WINDOWS: close the departing resident out, and see what
 * the space carries.
 *
 *   "I wanted to get the payment arrangement situation set up first, and I
 *    wanted to get the setup correctly so I can I want to go through and mark
 *    Rashawn as moved out in the system when it's time to do that."
 *
 * What a screen can get wrong that the engine cannot:
 *
 *   · the close-out window must show all FOUR figures — what becomes the
 *     space's balance, what stays the departing resident's, what late fees go,
 *     and that the lease closes — and write NOTHING until the press.
 *   · on a space this does not work on it must SAY SO, in the server's own
 *     words, rather than hide the action. An RV spot is the live case.
 *   · the balance window must state plainly that a cycle is never fined and
 *     that the balance is outside the resident's payment history, because a
 *     landlord setting an arrangement will be asked about both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  preview: null as any,
  balance: null as any,
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  puts: [] as { url: string; body: any }[],
  /** Queued refusals for the close-out press (status + message). */
  closeOutFails: [] as Array<{ status: number; error: string; then?: () => void }>,
}))

const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url.endsWith('/space-carryforward/preview')) return JSON.parse(JSON.stringify(server.preview))
    if (url.endsWith('/space-carryforward')) return JSON.parse(JSON.stringify(server.balance))
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url.endsWith('/close-out')) {
      const fail = server.closeOutFails.shift()
      if (fail) { fail.then?.(); throw httpError(fail.status, fail.error) }
      return { success: true, data: {
        carryforwardId: 'cf-1', chargeId: 'pay-1', carriedAmount: 880, lateFeesWaived: 95,
        stayedWithDepartingTenant: 1051, leaseEndedOn: '2026-10-19', invoicesExemptedFromLateFees: 2,
      } }
    }
    if (url.endsWith('/take-off')) {
      return { success: true, data: { carryforwardId: 'cf-1', takenOff: 780, keptPaid: 100, chargesVoided: 1 } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
  apiPut: async (url: string, body: any) => {
    server.puts.push({ url, body })
    if (body.amount == null) { server.balance = { ...server.balance, arrangement: null }; return server.balance }
    server.balance = {
      ...server.balance,
      arrangement: { amount: body.amount, dayOfMonth: body.dayOfMonth, startedOn: '2026-10-19' },
    }
    return JSON.parse(JSON.stringify(server.balance))
  },
}))

import { CloseOutSpaceModal } from './CloseOutSpaceModal'
import { SpaceCarriedBalanceModal } from './SpaceCarriedBalanceModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** MH 09's live figures: $880 carries, $1,051 stays, $95 of late fees go. */
const preview = (over: any = {}) => ({
  leaseId: 'L-rashawn', unitId: 'u-mh09', spaceName: 'MH 09', propertyId: 'p-oak', propertyName: 'Oak Park',
  landlordId: 'll-1', departingTenantId: 't-rashawn', departingTenantName: 'Rashawn Bump',
  dwellingOwnership: 'tenant', recordedHomeOwnerName: null, eligible: true, reason: null,
  carries: [
    { id: 'r1', type: 'rent', amount: 440, dueDate: '2026-09-01', label: 'Space rent', detail: null },
    { id: 'r2', type: 'rent', amount: 440, dueDate: '2026-10-01', label: 'Space rent', detail: null },
  ],
  carriesTotal: 880,
  stays: [
    { id: 'u1', type: 'utility', amount: 997, dueDate: '2026-09-01', label: 'Utility', detail: 'August water read' },
    { id: 'u2', type: 'utility', amount: 25, dueDate: '2026-09-01', label: 'Utility', detail: null },
    { id: 'u3', type: 'utility', amount: 25, dueDate: '2026-10-01', label: 'Utility', detail: null },
    { id: 'u4', type: 'utility', amount: 4, dueDate: '2026-10-01', label: 'Utility', detail: null },
  ],
  staysTotal: 1051,
  waives: [{ id: 'f1', type: 'late_fee', amount: 95, dueDate: '2026-10-02', label: 'Late fee', detail: null }],
  waivesTotal: 95,
  oldestDueDate: '2026-09-01', existingCarryforwardId: null,
  ...over,
})

const balance = (over: any = {}) => ({
  id: 'cf-1', unitId: 'u-mh09', spaceName: 'MH 09', propertyName: 'Oak Park',
  amount: 880, settledAmount: 0, stillOwed: 880, lateFeesWaived: 95, status: 'open',
  openedOn: '2026-10-19', oldestDueDate: '2026-09-01', settledOn: null, takenOffOn: null,
  owedByName: 'Rashawn Bump', assumedByName: null, assumedLeaseId: null,
  chargeLabel: 'Unpaid space rent left on this space by the previous owner of the home',
  arrangement: null, installments: [], role: 'origin',
  ...over,
})

const lease = { id: 'L-rashawn', unitNumber: 'MH 09', propertyName: 'Oak Park', names: 'Rashawn Bump' }

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn>
let onClosedOut: ReturnType<typeof vi.fn>
beforeEach(() => {
  server.preview = preview()
  server.balance = balance()
  server.gets = []; server.posts = []; server.puts = []; server.closeOutFails = []
  onClose = vi.fn(); onClosedOut = vi.fn()
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
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

async function openCloseOut() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc()}>
        <CloseOutSpaceModal lease={lease} onClose={onClose} onClosedOut={onClosedOut} />
      </QueryClientProvider>)
  })
}
async function openBalance(opts: { canArrange?: boolean; canTakeOff?: boolean } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc()}>
        <SpaceCarriedBalanceModal leaseId="L-rashawn" onClose={onClose}
          canArrange={opts.canArrange ?? true} canTakeOff={opts.canTakeOff ?? true} />
      </QueryClientProvider>)
  })
  await until(() => text().includes('What this space carries'), 'the balance window')
}

// ── The close-out window ─────────────────────────────────────────────────────

describe('the window that closes a departing resident out', () => {
  it('shows all four figures and writes nothing until the landlord presses', async () => {
    await openCloseOut()
    await until(() => text().includes('$880.00'), 'the figures')

    // 1. what becomes the space's balance
    expect(text()).toContain("Becomes MH 09's balance")
    expect(text()).toContain('$880.00')
    // 2. what stays the departing resident's own debt
    expect(text()).toContain("Stays Rashawn Bump's own debt")
    expect(text()).toContain('$1,051.00')
    // 3. what late fees are voided
    expect(text()).toContain('Dropped outright')
    expect(text()).toContain('$95.00')
    // 4. and that the lease closes, so the space stops counting as occupied
    expect(text()).toContain('And the lease closes')
    expect(text()).toMatch(/stops counting as occupied/)

    // The rows behind each figure, so the total can be checked rather than trusted.
    expect(text().match(/Space rent/g) ?? []).toHaveLength(2)
    expect(text()).toContain('September 1, 2026')

    // Nothing has been sent.
    expect(server.posts).toEqual([])
    // The button names the consequence, not "Confirm".
    expect(button(/Close out — MH 09 carries \$880\.00/)).toBeTruthy()

    await press(/Close out — MH 09 carries/)
    await until(() => server.posts.length === 1, 'the close-out')
    // The figure the landlord saw is the figure sent.
    expect(server.posts[0].body.expectedCarried).toBe(880)
  })

  it('cancelling writes nothing', async () => {
    await openCloseOut()
    await until(() => text().includes('$880.00'), 'the figures')
    await press(/^Cancel$/)
    expect(server.posts).toEqual([])
    expect(onClose).toHaveBeenCalled()
  })

  it('says what happened, and offers the balance it just created', async () => {
    await openCloseOut()
    await press(/Close out — MH 09 carries/)
    await until(() => text().includes('Closed out'), 'the result')
    expect(text()).toContain('MH 09 now carries $880.00')
    expect(text()).toContain('$1,051.00')
    expect(text()).toContain('$95.00')
    // Both are on the hook, and it can only be collected once.
    expect(text()).toMatch(/still owes the \$880\.00 until it is paid/)
    expect(text()).toMatch(/never be collected twice/)
    await press(/See what the space carries/)
    expect(onClosedOut).toHaveBeenCalledWith('cf-1')
  })

  it('a figure that moved under the press is asked again, in place', async () => {
    server.closeOutFails = [{
      status: 409,
      error: 'The unpaid space rent on this space has changed — it is now $440.00, not $880.00. Check the figures and press again.',
      // The server's answer and the screen's next read agree.
      then: () => { server.preview = preview({ carriesTotal: 440, carries: [preview().carries[1]] }) },
    }]
    await openCloseOut()
    await press(/Close out — MH 09 carries \$880\.00/)
    await until(() => text().includes('The figures moved'), 'the re-ask')
    expect(text()).toMatch(/the ones below are the live ones now/)
    // The server's own sentence, with the new figure in it, rides along.
    expect(text()).toContain('it is now $440.00, not $880.00')
    await until(() => !!button(/Close out — MH 09 carries \$440\.00/), 'the new figure on the button')

    // Pressing again sends what it says now.
    await press(/Close out — MH 09 carries \$440\.00/)
    await until(() => server.posts.length === 2, 'the second press')
    expect(server.posts[1].body.expectedCarried).toBe(440)
  })

  it('an RV spot says why this does not apply, and offers no press', async () => {
    server.preview = preview({
      eligible: false,
      reason: 'Only a mobile home space carries unpaid space rent forward. An RV or a park-owned unit leaves nothing behind for the next resident to inherit.',
    })
    await openCloseOut()
    await until(() => text().includes('Nothing carries forward'), 'the refusal')
    expect(text()).toContain('An RV or a park-owned unit leaves nothing behind')
    // Not hidden, and not pressable.
    expect(button(/Close out/)).toBeUndefined()
    // It points at the action that does end a tenancy.
    expect(text()).toMatch(/use .*Move out.* on the lease/i)
    expect(server.posts).toEqual([])
  })

  it('a park-owned home says the park owns it', async () => {
    server.preview = preview({
      eligible: false,
      reason: 'The park owns the home on this space, so nothing carries forward — a vacancy has no next owner to inherit it.',
    })
    await openCloseOut()
    await until(() => text().includes('Nothing carries forward'), 'the refusal')
    expect(text()).toContain('The park owns the home on this space')
    expect(button(/Close out/)).toBeUndefined()
  })

  it('a space that already carries one points at the balance instead', async () => {
    server.preview = preview({
      eligible: false, existingCarryforwardId: 'cf-0',
      reason: 'This space already carries an unpaid space-rent balance. Settle or take off the existing one first.',
    })
    await openCloseOut()
    await until(() => text().includes('already carries'), 'the refusal')
    expect(text()).toMatch(/Open what the space already carries/)
  })
})

// ── The balance window ───────────────────────────────────────────────────────

describe('the window that shows what a space carries', () => {
  it('states the balance, whose it was, and the two promises', async () => {
    await openBalance()
    expect(text()).toContain('MH 09')
    expect(text()).toContain('$880.00')
    expect(text()).toContain('Rashawn Bump')
    expect(text()).toContain('Still owed')
    expect(text()).toContain('Unpaid space rent left on this space by the previous owner of the home')
    // The status reads in words, never the enum value.
    expect(text()).toContain('Still owed')
    expect(text()).not.toMatch(/\bopen\b/)
    // The two promises.
    expect(text()).toMatch(/never gets a late fee/)
    expect(text()).toMatch(/not part of the resident.s payment history/)
    expect(text()).toMatch(/never folded into rent/)
  })

  /**
   * 10/19: the balance follows the space onto ANY lease drafted on it, and only
   * the invite screen asks whether the new resident is taking it on. A lease
   * papered through tenant onboarding, issuance or stay terms inherits a
   * stranger's space rent in silence — so where the server says nobody was ever
   * asked, this window says it plainly, with both ways out.
   */
  it('says when the balance moved onto a resident nobody was asked about', async () => {
    server.balance = balance({
      assumedByName: 'Jacob Dalton', assumedLeaseId: 'L-jacob',
      assumptionRecordedAt: null, movedWithoutBeingAsked: true, role: 'assumed',
    })
    await openBalance()
    expect(text()).toContain('Nobody was asked to take this balance on')
    expect(text()).toContain('Jacob Dalton')
    expect(text()).toMatch(/condition of moving in/)
    // Both doors are named: ask them, or take it off.
    expect(text()).toMatch(/take the balance off/)
  })

  it('says nothing of the sort once somebody was asked', async () => {
    server.balance = balance({
      assumedByName: 'Jacob Dalton', assumedLeaseId: 'L-jacob',
      assumptionRecordedAt: '2026-10-19T12:00:00.000Z', movedWithoutBeingAsked: false, role: 'assumed',
    })
    await openBalance()
    expect(text()).toContain('Taken on with the space by')
    expect(text()).not.toContain('Nobody was asked')
  })

  it('an arrangement can be set, and says what it will ask for', async () => {
    await openBalance()
    expect(text()).toMatch(/Nothing is asked for on a cycle today/)
    const [amount, day] = [...host.querySelectorAll('input.input.mono')] as HTMLInputElement[]
    await type(amount, '100')
    await type(day, '5')
    await press(/Set the arrangement/)
    await until(() => server.puts.length === 1, 'the arrangement')
    expect(server.puts[0].body).toEqual({ amount: 100, dayOfMonth: 5 })
    await until(() => text().includes('Asking $100.00 on the 5th of each month'), 'the confirmation')
  })

  it('refuses a day outside 1–28 and an empty amount, in the window', async () => {
    await openBalance()
    const [amount, day] = [...host.querySelectorAll('input.input.mono')] as HTMLInputElement[]
    await press(/Set the arrangement/)
    expect(text()).toContain('Enter a monthly amount')
    expect(server.puts).toEqual([])
    await type(amount, '100')
    await type(day, '31')
    await press(/Set the arrangement/)
    expect(text()).toMatch(/every month has one/)
    expect(server.puts).toEqual([])
  })

  it('shows the cycles it has asked for, met and missed, with no fee either way', async () => {
    server.balance = balance({
      arrangement: { amount: 100, dayOfMonth: 1, startedOn: '2026-08-01' },
      settledAmount: 100, stillOwed: 780,
      installments: [
        { dueDate: '2026-10-01', amount: 100, status: 'asked', appliedAmount: 0, metOn: null },
        { dueDate: '2026-09-01', amount: 100, status: 'missed', appliedAmount: 40, metOn: null },
        { dueDate: '2026-08-01', amount: 100, status: 'met', appliedAmount: 100, metOn: '2026-08-03' },
      ],
    })
    await openBalance()
    expect(text()).toContain('Cycles asked for')
    expect(text()).toContain('Asked for this month')
    // The label itself carries the promise: missed costs nothing.
    expect(text()).toContain('Not paid (no late fee)')
    expect(text()).toContain('$40.00 came in')
    expect(text()).toContain('Paid')
    expect(text()).toContain('Aug 3, 2026')
    // Already asking: the control changes it rather than setting a second one.
    expect(button(/Change the arrangement/)).toBeTruthy()
    expect(button(/Stop asking/)).toBeTruthy()
  })

  it('stopping the asking keeps the balance owed', async () => {
    server.balance = balance({ arrangement: { amount: 100, dayOfMonth: 1, startedOn: '2026-08-01' } })
    await openBalance()
    await press(/Stop asking/)
    await until(() => server.puts.length === 1, 'the stop')
    expect(server.puts[0].body).toEqual({ amount: null, dayOfMonth: null })
    await until(() => text().includes('The balance is still owed'), 'the confirmation')
  })

  it('the take-off door asks once, in the window, and says what it costs', async () => {
    server.balance = balance({ settledAmount: 100, stillOwed: 780 })
    await openBalance()
    await press(/Take this balance off/)
    // No native confirm: the question is in the window, with the figures.
    expect(text()).toMatch(/Take \$780\.00 off and nobody is asked for it again/)
    expect(text()).toContain('Rashawn Bump')
    expect(text()).toMatch(/\$100\.00 already paid stays recorded/)
    expect(server.posts).toEqual([])

    // Backing out writes nothing.
    await press(/Keep it owed/)
    expect(server.posts).toEqual([])

    await press(/Take this balance off/)
    await press(/Take \$780\.00 off/)
    await until(() => server.posts.length === 1, 'the take-off')
    expect(server.posts[0].url).toContain('/take-off')
    await until(() => text().includes('Taken off.'), 'the confirmation')
    expect(text()).toMatch(/\$780\.00 is owed by nobody now/)
  })

  it('a balance already taken off offers neither an arrangement nor another take-off', async () => {
    server.balance = balance({ status: 'voided', stillOwed: 0, takenOffOn: '2026-10-19', settledAmount: 100 })
    await openBalance()
    expect(text()).toContain('Taken off')
    expect(button(/Set the arrangement/)).toBeUndefined()
    expect(button(/Take this balance off/)).toBeUndefined()
  })

  it('a paid-off balance reads as paid off, with the day', async () => {
    server.balance = balance({ status: 'settled', settledAmount: 880, stillOwed: 0, settledOn: '2026-12-02' })
    await openBalance()
    expect(text()).toContain('Paid off')
    expect(text()).toContain('Dec 2, 2026')
    expect(button(/Set the arrangement/)).toBeUndefined()
  })

  it('without the permissions, the controls are not there — the balance still reads', async () => {
    await openBalance({ canArrange: false, canTakeOff: false })
    expect(text()).toContain('$880.00')
    expect(button(/Set the arrangement/)).toBeUndefined()
    expect(button(/Take this balance off/)).toBeUndefined()
  })

  it('a space carrying nothing says so plainly', async () => {
    server.balance = null
    await openBalance()
    expect(text()).toMatch(/carries no unpaid space rent/)
  })
})
