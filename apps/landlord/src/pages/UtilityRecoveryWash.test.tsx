// @vitest-environment jsdom
/**
 * 10/20 (Nic) — CALL IT A WASH, on the screen.
 *
 *   "I would like to keep track of money that wasn't refunded versus electric
 *    that should have been billed that wasn't charged to see how close we
 *    actually get to evening out. You know, because people leave at various
 *    times and we try to be generous with it, but I want to make sure that it's
 *    somewhat fair."
 *
 * So the card has to say which WAY it leans, in both directions, in words a
 * landlord reads without being taught the vocabulary. "You came out ahead by"
 * and "You came out short by" are both printed; a single signed figure, or a
 * number that only ever read as a win, would not answer what he asked.
 *
 * And the named slices must read as PARTS of the gap, never as additions to it.
 * Nic's standing rule is that every dollar is counted exactly once, and the
 * screen is the last place it can go wrong after the API got it right.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({ recovery: null as any }))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    if (url.startsWith('/utility/recovery')) return server.recovery
    return []
  },
  apiPost: async () => ({ success: true }),
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDelete: async () => ({}),
}))
vi.mock('../components/dialogs', () => {
  const toast = () => {}
  ;(toast as any).error = () => {}
  return { toast, appConfirm: async () => true }
})
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ has: () => true, perms: [] }) }))
vi.mock('../../../../packages/shared-ui/MeterWalk', () => ({ ReadingWalkModal: () => null }))

import { RecoveryCard } from './UtilityMetersPage'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  server.recovery = null
})

/** The shape GET /api/utility/recovery returns, with only what is under test set. */
function recovery(over: {
  lines?: any[]
  totals?: any
}) {
  return {
    from: '2026-01-01', to: '2026-12-31',
    lines: over.lines ?? [],
    totals: {
      spent: 0, recovered: 0, collected: 0, workTrade: 0, stillOwed: 0,
      fromBills: 0, fromSales: 0, inTheRate: 0,
      propertyUsed: 0, ownerOccupied: 0, vacantSpaces: 0,
      somebodysUsage: 0, earlyDepartureWash: 0, notRecovered: null, unattributed: null,
      earlyDepartures: {
        departures: 0, moneyKept: 0, moneyKeptBeforeTax: 0, lodgingTaxOwed: 0,
        utilityAbsorbed: 0, evenedOutBy: 0, awaitingClosingRead: 0, heldStubs: 0,
      },
      ...over.totals,
    },
  }
}

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <RecoveryCard propertyId="p1" />
        </QueryClientProvider>
      </MemoryRouter>,
    )
  })
  await act(async () => { await Promise.resolve() })
  return host.textContent ?? ''
}

describe('the recovery card, early departures', () => {
  it('puts the money kept and the utilities never billed side by side, with how many people left', async () => {
    server.recovery = recovery({
      lines: [{ utilityType: 'electric', spent: 1000, recovered: 300, collected: 300, workTrade: 0,
                stillOwed: 0, ownerOccupied: 0, earlyDepartureWash: 18.40, notRecovered: 700, unattributed: 681.60 }],
      totals: { spent: 1000, recovered: 300, collected: 300, earlyDepartureWash: 18.40,
                notRecovered: 700, unattributed: 681.60,
                earlyDepartures: { departures: 2, moneyKept: 51, utilityAbsorbed: 18.40,
                                   evenedOutBy: 32.60, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('When someone leaves early and you keep the money')
    expect(text).toContain('Money you kept')
    expect(text).toContain('$51.00')
    expect(text).toContain('Utilities you never billed them')
    expect(text).toContain('$18.40')
    expect(text).toContain('2 people left before the day they had paid through')
  })

  it('says you came out AHEAD when the money kept covered the utilities', async () => {
    server.recovery = recovery({
      totals: { spent: 1000, recovered: 300, earlyDepartureWash: 18.40, notRecovered: 700, unattributed: 681.60,
                earlyDepartures: { departures: 1, moneyKept: 51, utilityAbsorbed: 18.40,
                                   evenedOutBy: 32.60, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('You came out ahead by')
    expect(text).toContain('$32.60')
    expect(text).not.toContain('You came out short by')
    expect(text).toContain('One person left before the day they had paid through')
  })

  // The direction that matters. He is trying to find out whether being generous
  // is costing him, so the short case has to be as plain as the other one.
  it('says you came out SHORT when the utilities cost more than was kept', async () => {
    server.recovery = recovery({
      totals: { spent: 1000, recovered: 300, earlyDepartureWash: 75, notRecovered: 700, unattributed: 625,
                earlyDepartures: { departures: 1, moneyKept: 20, utilityAbsorbed: 75,
                                   evenedOutBy: -55, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('You came out short by')
    expect(text).toContain('$55.00')
    // Never a bare minus sign in front of a dollar figure — the words carry the sign.
    expect(text).not.toContain('-$55.00')
    expect(text).not.toContain('You came out ahead by')
  })

  it('a departure whose final utility amount has not landed is said out loud, not quietly left out', async () => {
    server.recovery = recovery({
      totals: { spent: 1000, recovered: 300, notRecovered: 700, unattributed: 700,
                earlyDepartures: { departures: 1, moneyKept: 51, utilityAbsorbed: 0,
                                   evenedOutBy: 51, awaitingClosingRead: 1, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('still waiting on its final utility amount')
  })

  // THE DOUBLE-COUNT, as a reader sees it. The three parts are indented under
  // the whole gap and the footnote says in as many words that they are inside
  // it, so nobody adds them together and reports the same dollar twice.
  it('shows the three parts as a breakdown of the gap, never as an addition to it', async () => {
    server.recovery = recovery({
      lines: [{ utilityType: 'electric', spent: 1000, recovered: 300, collected: 300, workTrade: 0,
                stillOwed: 0, propertyUsed: 125, ownerOccupied: 100, vacantSpaces: 25,
                somebodysUsage: 150, earlyDepartureWash: 150, notRecovered: 700, unattributed: 425 }],
      totals: { spent: 1000, recovered: 300, collected: 300, fromBills: 300,
                propertyUsed: 125, ownerOccupied: 100, vacantSpaces: 25,
                somebodysUsage: 150, earlyDepartureWash: 150, notRecovered: 700, unattributed: 425,
                earlyDepartures: { departures: 1, moneyKept: 51, moneyKeptBeforeTax: 51,
                                   lodgingTaxOwed: 0, utilityAbsorbed: 150,
                                   evenedOutBy: -99, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('Charged but never billed')
    expect(text).toContain('$700.00')
    // The three, in Nic's own division.
    expect(text).toContain('The park used it')
    expect(text).toContain('$125.00')
    expect(text).toContain('Somebody used it, never billed')
    expect(text).toContain('$150.00')
    expect(text).toContain('Not accounted for')
    expect(text).toContain('$425.00')
    expect(text).toContain('already counted inside')
    // 700 is the whole gap; the parts are inside it, so no inflated figure appears.
    expect(text).not.toContain('$1,400.00')
    // and the per-utility table carries both named parts as their own columns
    expect(text).toContain('Somebody used it')
  })

  /**
   * 10/20 (Nic): "it's $269 each at 2 weeks, but it's also plus the short-term
   * lodging tax… even though they weren't charged the tax needs to be factored
   * in." The screen shows the NET and spells out the subtraction underneath,
   * because a figure that quietly dropped $71.02 would look like a bug to the
   * one person who knows what was in the till.
   */
  it('shows the money kept NET of the lodging tax, with the subtraction spelled out', async () => {
    server.recovery = recovery({
      totals: { earlyDepartures: { departures: 2, moneyKept: 30.98, moneyKeptBeforeTax: 102,
                                   lodgingTaxOwed: 71.02, utilityAbsorbed: 162.54,
                                   evenedOutBy: -131.56, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('Money you kept')
    expect(text).toContain('$30.98')
    expect(text).toContain('$102.00 left in the till, less $71.02 of lodging tax')
    expect(text).toContain('that tax comes out of your pocket')
    // It leans HARDER against him with the tax in, and says so.
    expect(text).toContain('You came out short by')
    expect(text).toContain('$131.56')
  })

  it('a property with no lodging tax to owe is told nothing about one', async () => {
    server.recovery = recovery({
      totals: { earlyDepartures: { departures: 1, moneyKept: 51, moneyKeptBeforeTax: 51,
                                   lodgingTaxOwed: 0, utilityAbsorbed: 18.40,
                                   evenedOutBy: 32.60, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('$51.00')
    expect(text).not.toContain('of lodging tax')
    expect(text).not.toContain('comes out of your pocket')
  })

  // 10/20 (Nic): three doors utility money comes back through, named under the
  // total so one number never silently means three different things.
  it('names which of the three ways the utility money came back', async () => {
    server.recovery = recovery({
      totals: { spent: 1000, recovered: 380, collected: 380, fromBills: 300, fromSales: 0,
                inTheRate: 80, notRecovered: 620, unattributed: 620 },
    })
    const text = await render()
    expect(text).toContain('$300.00 on bills')
    expect(text).toContain('$80.00 inside nightly and weekly rates')
    // The door this park has never used is not mentioned at all.
    expect(text).not.toContain('at the register or on a pay link')
  })

  // A property can have early departures and nothing else. RV 10 and RV 11 at
  // Mountain View have no utility bill and no recorded expense between them,
  // which is the exact case this feature was built for; a card that hid itself
  // on an empty spent-and-billed pair would hide the only figures it has.
  it('still renders when the only thing recorded is an early departure', async () => {
    server.recovery = recovery({
      totals: { earlyDepartures: { departures: 2, moneyKept: 102, utilityAbsorbed: 36.80,
                                   evenedOutBy: 65.20, awaitingClosingRead: 0, heldStubs: 0 } },
    })
    const text = await render()
    expect(text).toContain('When someone leaves early and you keep the money')
    expect(text).toContain('$102.00')
  })

  it('a property with no early departures sees none of it', async () => {
    server.recovery = recovery({
      lines: [{ utilityType: 'electric', spent: 1000, recovered: 300, collected: 300, workTrade: 0,
                stillOwed: 0, propertyUsed: 0, ownerOccupied: 0, vacantSpaces: 0,
                somebodysUsage: 0, earlyDepartureWash: 0, notRecovered: 700, unattributed: 700 }],
      totals: { spent: 1000, recovered: 300, collected: 300, fromBills: 300,
                notRecovered: 700, unattributed: 700 },
    })
    const text = await render()
    expect(text).toContain('Charged but never billed')
    expect(text).not.toContain('When someone leaves early')
    expect(text).not.toContain('of lodging tax')
    // The breakdown still reads, and reads ZERO for both named parts — which is
    // the useful answer: none of this $700 is your own spaces and none of it is
    // a person who went unbilled, so all of it is unaccounted for.
    expect(text).toContain('Not accounted for$700.00')
    // And with nothing in either part, the per-utility table carries neither
    // column: the heading appears once, in the breakdown, and not again.
    expect(text.match(/The park used it/g)).toHaveLength(1)
    expect(text.match(/Somebody used it/g)).toHaveLength(1)
  })
})
