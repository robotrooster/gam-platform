/**
 * 10/19 (Nic) — WHILE A WORK TRADE IS PAUSED, IS THE SPACE STILL BEING USED?
 *
 *   "A paused work trade that counts hours should continue to count hours. If, I
 *    mean, basically the landlord needs to have a way to set whether they occupy
 *    the spot or not. Because if somebody wants to work more hours in the winter
 *    but leave their camper occupying the space in the summer, that's one
 *    situation. If people take their camper home for the summer with them and
 *    it's not occupying the spot, then there would be no reason for it to
 *    continue to track hours."
 *
 * The window is ONE component both portals render (packages/shared-ui), so this
 * covers what the landlord is asked and what the tenant is told, side by side.
 * What the month close then does is pinned in apps/api
 * jobs/workTradeSettlement.test.ts.
 *
 * The thing worth testing hardest is that the two sides never read different
 * stories about the same space — the banner used to say "nothing is owed and
 * nothing is billed until they are back" on EVERY paused agreement, including
 * ones whose month still closed and still left the unworked part owed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  patches: [] as { url: string; body: any }[],
  agreement: {} as any,
  standing: null as any,
  /** Set to make the next PATCH refuse, the way the route refuses a stale one. */
  refusePatch: null as string | null,
}))

const api = {
  get: async (url: string) => {
    if (url.endsWith('/standing')) return server.standing
    if (url.includes('/extra-hours')) return []
    if (url.includes('reading-runs')) return []
    if (url === '/work-trade/jobs') return { mine: [], available: [], toCheck: [] }
    return {
      agreement: server.agreement, logs: [], jobs: [],
      stats: { target: 80, hoursApprovedThisMonth: 0, pendingCount: 0, creditPct: 0, reviewBy: '2026-07-31' },
      record: { submitted: 0 },
    }
  },
  post: async () => ({}),
  patch: async (url: string, body: any) => {
    server.patches.push({ url, body })
    if (server.refusePatch) throw new Error(server.refusePatch)
    return {}
  },
}

import { WorkTradePanel } from '../../../../packages/shared-ui/WorkTradePanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.patches = []
  server.refusePatch = null
  server.standing = { carriedHours: 0, catchUpHours: 0, bankedHours: 0, carriedValue: 0,
                      hoursNotCounted: false, summary: '', extraHours: { mode: 'bank', recent: [], summary: null } }
  server.agreement = {
    id: 'a1', status: 'paused', tracksHours: true, pausedSpaceOccupied: null,
    tenantFirst: 'Pat', tenantLast: 'Q', unitNumber: 'RV 50', propertyName: 'Mountain View',
    coveredCharges: ['rent'], skills: [], fieldPermissions: [], trusted: false,
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const button = (label: string) => buttons().find(b => (b.textContent ?? '').trim() === label)
const until = async (f: () => boolean, what: string) => {
  for (let i = 0; i < 80; i++) {
    if (f()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function show(side: 'landlord' | 'tenant' = 'landlord') {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc()}>
        <WorkTradePanel agreementId="a1" side={side} api={api as any} />
      </QueryClientProvider>)
  })
  await until(() => text().includes('RV 50'), 'the window to load')
}

describe('the landlord is asked about the space', () => {
  it('asks it as a question about a camper, not as a flag', async () => {
    await show()
    expect(text()).toContain('Is the space still being used?')
    expect(text()).toContain('A camper left parked on the spot over the summer is still using it')
    expect(button('Still being used')).toBeTruthy()
    expect(button('The space is empty')).toBeTruthy()
  })

  it('unanswered says hours are STILL counting, rather than looking settled', async () => {
    await show()
    // The live default: lease hibernation pauses an agreement with nobody in
    // front of a screen, and an arriving column must move nobody's bill.
    expect(text()).toContain('Hours are still counting, because nobody has said yet')
    expect(buttons().filter(b => b.className.includes('btn-primary'))
      .map(b => (b.textContent ?? '').trim())).not.toContain('The space is empty')
  })

  it('saves each answer on its own, without touching the pause', async () => {
    await show()
    await act(async () => { button('The space is empty')!.click() })
    await until(() => server.patches.length === 1, 'the answer saved')
    expect(server.patches[0]).toEqual({ url: '/work-trade/a1', body: { spaceOccupiedWhilePaused: false } })
  })

  // The answer stopping the count covers every month still open outright, which
  // CLEARS hours carried over from months when the space was in use. That is the
  // landlord's money, so it is priced in front of them while they can still pick
  // the other answer.
  it('prices the catch-up the empty answer would clear, before it is given', async () => {
    server.standing = { ...server.standing, carriedHours: 20, carriedValue: 125 }
    await show()
    expect(text()).toContain('20 hrs behind from earlier months')
    expect(text()).toContain('$125.00')
    expect(text()).toContain('that catch-up is cleared')
  })

  it('stops warning once the answer is already empty — there is nothing left to clear', async () => {
    server.agreement = { ...server.agreement, pausedSpaceOccupied: false }
    server.standing = { ...server.standing, carriedHours: 0, carriedValue: 0, hoursNotCounted: true }
    await show()
    expect(text()).not.toContain('that catch-up is cleared')
  })

  it('asks the same question in the same step as pausing', async () => {
    server.agreement = { ...server.agreement, status: 'active' }
    await show()
    await act(async () => { button('Pause this agreement')!.click() })
    expect(text()).toContain('While it is paused, is the space still being used?')
    await act(async () => { button('Still being used')!.click() })
    await until(() => server.patches.length === 1, 'the pause saved')
    expect(server.patches[0]).toEqual({
      url: '/work-trade/a1', body: { status: 'paused', spaceOccupiedWhilePaused: true } })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10/19 (review) — THE WARNING BELONGS ON THE CARD WHERE THE ANSWER IS GIVEN.
  //
  // The priced warning above only rendered on the ALREADY-PAUSED card, i.e.
  // after the trade was paused. The pause-now card is where "The space is
  // empty" gets picked for the FIRST time, and it showed nothing about earlier
  // months — so a landlord could clear a $250 catch-up having read only "No
  // hours are counted while this is paused". It is effectively irreversible:
  // the next close settles those periods and loadOpenPeriods only ever reopens
  // `open` ones.
  it('prices the catch-up on the PAUSE-NOW card too, before either answer', async () => {
    server.agreement = { ...server.agreement, status: 'active' }
    server.standing = { ...server.standing, carriedHours: 40, carriedValue: 250 }
    await show()
    await act(async () => { button('Pause this agreement')!.click() })
    expect(text()).toContain('40 hrs behind from earlier months')
    expect(text()).toContain('$250.00')
    expect(text()).toContain('that catch-up is cleared')
    // And it is on screen while BOTH answers are still a click away.
    expect(button('Still being used')).toBeTruthy()
    expect(button('The space is empty')).toBeTruthy()
  })

  it('says nothing about a catch-up on the pause-now card when there is none', async () => {
    server.agreement = { ...server.agreement, status: 'active' }
    await show()
    await act(async () => { button('Pause this agreement')!.click() })
    expect(text()).not.toContain('that catch-up is cleared')
  })

  // 10/19 (review): and neither answer covers the NEXT bill, because the billing
  // run only covers a running agreement (services/workTradeCredit
  // loadWorkTradeCreditContext). The landlord doing the pausing reads that
  // before clicking, rather than discovering it from a tenant's invoice.
  it('says what neither answer does to the next bill', async () => {
    server.agreement = { ...server.agreement, status: 'active' }
    await show()
    await act(async () => { button('Pause this agreement')!.click() })
    expect(text()).toContain('is not covered by the trade')
  })

  // Waking a trade whose LEASE is still asleep would leave it counting hours
  // against a month that bills nothing, and the lease would still expect to be
  // the thing that resumes it.
  it('does not offer to restart a trade that lease hibernation paused', async () => {
    server.agreement = { ...server.agreement, pausedByHibernation: true }
    await show()
    expect(button('Start this agreement again')).toBeUndefined()
    expect(text()).toContain('Waking the lease back up starts the work trade again too')
  })
})

describe('both sides read the same true sentence', () => {
  it('space in use: hours keep counting, and each side is told so', async () => {
    server.agreement = { ...server.agreement, pausedSpaceOccupied: true }
    await show('landlord')
    expect(text()).toContain('the space is still being used — hours keep counting')
    // The hours card is still there: there IS a target, and it is being met or missed.
    expect(text()).toContain('This month')

    await act(() => root.unmount())
    root = createRoot(host)
    await show('tenant')
    expect(text()).toContain('your space is still being used, so your hours keep counting')
    expect(text()).toContain('This month')
    // The tenant is never offered the landlord's controls.
    expect(button('The space is empty')).toBeUndefined()
  })

  it('space empty: no target is shown to either side, and neither is told anything is owed', async () => {
    server.agreement = { ...server.agreement, pausedSpaceOccupied: false }
    server.standing = { ...server.standing, hoursNotCounted: true }
    await show('landlord')
    expect(text()).toContain('the space is empty — no hours are being counted')
    // No "0 of 80 hrs" and no "Bill covered 0%" against somebody who is away.
    expect(text()).not.toContain('This month')
    expect(text()).toContain('There is no target to meet, and nothing falls behind')

    await act(() => root.unmount())
    root = createRoot(host)
    await show('tenant')
    expect(text()).toContain('your space is empty, so no hours are being counted')
    // 10/19 (review): the months ALREADY BILLED under the trade are covered at
    // the next close, and that is as far as it goes. The banner used to say
    // "The charges it covers are not billed while it is paused", which is a
    // promise about the next bill that the billing run does not keep — it only
    // covers a RUNNING agreement (services/workTradeCredit
    // loadWorkTradeCreditContext), so a month billed during the pause goes out
    // at its full amount and late-fee eligible. Said plainly to both sides
    // instead, until Nic decides whether a paused month should be covered.
    expect(text()).toContain('covered at the next month close')
    expect(text()).toContain('is not covered by the trade')
    expect(text()).not.toContain('This month')
  })

  // 10/19 (review) — AND NOT WHERE NOTHING BILLS AT ALL.
  //
  // Both work trades paused at Mountain View today sit on HIBERNATING leases,
  // and a hibernating lease bills nothing (jobs/invoiceGeneration gates on
  // is_hibernating). Telling that landlord and that tenant about an uncovered
  // bill would be the same false sentence pointing the other way, so the window
  // says nothing about bills on a hibernation pause.
  it('says nothing about an uncovered bill when the spot is hibernating', async () => {
    server.agreement = { ...server.agreement, pausedByHibernation: true, pausedSpaceOccupied: false }
    server.standing = { ...server.standing, hoursNotCounted: true }
    for (const side of ['landlord', 'tenant'] as const) {
      await act(() => root.unmount())
      root = createRoot(host)
      await show(side)
      expect(text()).not.toContain('is not covered by the trade')
      // The honest half is still there: no hours, and the open months settle.
      expect(text()).toContain('no hours are being counted')
      expect(text()).toContain('covered at the next month close')
    }
  })

  // The old banner said this to everybody. It was only ever true for one of them.
  it('never claims nothing is owed on a trade that is still counting hours', async () => {
    server.agreement = { ...server.agreement, pausedSpaceOccupied: true }
    await show('tenant')
    expect(text()).not.toContain('nothing is owed')
  })

  it('a trade that never counted hours is not asked the question at all', async () => {
    server.agreement = { ...server.agreement, tracksHours: false }
    await show('landlord')
    expect(text()).toContain('No hours are counted on this agreement either way')
    expect(text()).not.toContain('Is the space still being used?')
  })

  // 10/19 (review): the question is drawn from the agreement this window
  // fetched, so a lease woken in another tab leaves it on screen for a trade
  // that is running again. The server refuses the answer in that state; the
  // window has to take the stale control away rather than leave it to be
  // clicked again, and the landlord has to be told why.
  it('takes the question away when the trade turns out to be running again', async () => {
    await show()
    expect(text()).toContain('Is the space still being used?')

    // The trade was resumed elsewhere while this window sat open.
    server.agreement = { ...server.agreement, status: 'active' }
    server.refusePatch = 'This work trade is running, so there is no pause to answer about the space.'
    await act(async () => { button('The space is empty')!.click() })

    await until(() => !text().includes('Is the space still being used?'),
      'the stale question to disappear')
    expect(text()).toContain('Active')
  })
})
