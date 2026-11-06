/**
 * The contractor marketplace, landlord side — what the screen actually renders.
 *
 * 10/31. Written because the server half has 52 tests and the screen had none,
 * and "it typechecks" is not the same as having seen it.
 *
 * The load-bearing assertions are the ones about MONEY and PRIVACY, because
 * those are the two things Nic decided and the two things a later change could
 * quietly break:
 *
 *  - the settle step states the contractor's share and GAM's share IN THE PAGE
 *    before anything is committed, and one click never starts it
 *  - a bid from someone who does not meet the job's insurance requirement is
 *    shown with the gap named, and is still awardable — warn loudly, let them
 *    through
 *  - the page never asks for, and never displays, anything that would leak one
 *    contractor's price to another
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  jobs: [] as any[],
  bids: [] as any[],
  properties: [] as any[],
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  confirms: [] as { message: string; title?: string }[],
  confirmAnswer: true,
  toasts: [] as string[],
  user: { role: 'landlord', permissions: {} } as any,
}))

vi.mock('../lib/api', () => ({
  api: { get: async () => ({ data: { success: true, data: [] } }) },
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/marketplace/jobs') return server.jobs
    if (url === '/marketplace/rate') return { percent: 3 }
    if (url === '/properties') return server.properties
    if (/^\/marketplace\/jobs\/[^/]+\/bids$/.test(url)) return server.bids
    if (/^\/marketplace\/jobs\/[^/]+$/.test(url)) return server.jobs[0]
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url.endsWith('/complete')) {
      return { success: true, data: {
        job: { ...server.jobs[0], status: 'completed', finalAmount: body?.finalAmount ?? 4000 },
        cutAmount: 138, contractorNet: 4462 } }
    }
    return { success: true, data: {} }
  }),
  apiPatch: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
  apiPut: vi.fn(async () => ({})),
}))
vi.mock('../components/dialogs', () => ({
  toast: (t: string) => { server.toasts.push(t) },
  appConfirm: async (message: string, opts?: any) => {
    server.confirms.push({ message, title: opts?.title })
    return server.confirmAnswer
  },
}))
vi.mock('../lib/permissions', () => ({
  usePerms: () => ({
    can: (k: string) => server.user.role === 'landlord'
      || server.user.permissions?.[k] === true,
    isOwner: server.user.role === 'landlord',
  }),
}))

import { MarketplacePage } from './MarketplacePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const openJob = (over: any = {}) => ({
  id: 'job1', propertyId: 'prop1', propertyName: 'Oak Park',
  title: 'Replace the water heater in space 12',
  description: 'The 40-gallon unit is leaking from the base and needs replacing.',
  trades: ['plumbing'], requiresInsured: false, requiresBonded: false,
  status: 'open', bidsCloseAt: null, awardedBidId: null, awardedAmount: null,
  finalAmount: null, completedAt: null, cutPercentSnapshot: null,
  createdAt: '2026-10-31T12:00:00Z', bidCount: '0', ...over,
})

const bid = (over: any = {}) => ({
  id: 'bid1', amount: '4000.00', notes: null, daysToComplete: 3,
  insuredAtBid: true, bondedAtBid: true, status: 'submitted',
  createdAt: '2026-10-31T13:00:00Z',
  contractorName: 'Bob Kowalski', contractorBusinessName: null,
  contractorRating: null, contractorCompletedJobs: 7, ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.jobs = []; server.bids = []; server.properties = []
  server.gets = []; server.posts = []; server.confirms = []; server.toasts = []
  server.confirmAnswer = true
  server.user = { role: 'landlord', permissions: {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MarketplacePage /></QueryClientProvider>)
  })
}
const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
const button = (re: RegExp) =>
  [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function click(re: RegExp, what = String(re)) {
  await until(() => !!button(re), `the ${what} button`)
  await act(async () => { button(re)!.click() })
}
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('the empty board', () => {
  it('explains what the page is for and states the price', async () => {
    await render()
    await until(() => text().includes('No jobs posted yet'), 'the empty state')
    expect(text()).toMatch(/keeps 3% of a job once it is finished/)
    expect(text()).toMatch(/nothing at all if it never is/)
  })
})

describe('the jobs list', () => {
  it('groups jobs by where they are up to, and counts bids only while open', async () => {
    server.jobs = [
      openJob({ id: 'j1', title: 'Water heater', bidCount: '3' }),
      openJob({ id: 'j2', title: 'Mow the common area', status: 'awarded',
                awardedAmount: '250.00', bidCount: '2' }),
      openJob({ id: 'j3', title: 'Re-roof MH 4', status: 'completed',
                awardedAmount: '8000.00', finalAmount: '8400.00', cutPercentSnapshot: '3.000' }),
    ]
    await render()
    await until(() => text().includes('Water heater'), 'the open job')
    expect(text()).toContain('Taking bids')
    expect(text()).toContain('Work awarded')
    expect(text()).toContain('Finished')
    expect(text()).toContain('3 bids')
    // An awarded job shows its money, not a bid count — bidding is over.
    expect(text()).toContain('$250.00')
  })

  it('says "No bids yet" rather than showing a zero', async () => {
    server.jobs = [openJob({ bidCount: '0' })]
    await render()
    await until(() => text().includes('No bids yet'), 'the no-bids line')
  })

  it('names the requirement on the card when one is set', async () => {
    server.jobs = [openJob({ requiresInsured: true, requiresBonded: true })]
    await render()
    await until(() => text().includes('Insured + bonded'), 'the requirement')
  })
})

describe('posting a job', () => {
  it('will not post until a property, a title, details and a trade are all chosen', async () => {
    server.properties = [{ id: 'prop1', name: 'Oak Park' }]
    await render()
    await click(/Post a job/)
    await until(() => text().includes('Post a job for bids'), 'the form')

    const post = button(/Post for bids/)!
    expect((post as HTMLButtonElement).disabled).toBe(true)

    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'prop1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await type(host.querySelector('input') as HTMLInputElement, 'Replace the water heater')
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(area, 'The 40-gallon unit is leaking from the base.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Still no trade picked.
    expect((button(/Post for bids/) as HTMLButtonElement).disabled).toBe(true)
    await click(/^Plumbing$/)
    expect((button(/Post for bids/) as HTMLButtonElement).disabled).toBe(false)

    await click(/Post for bids/)
    await until(() => server.posts.length > 0, 'the post')
    expect(server.posts[0].url).toBe('/marketplace/jobs')
    expect(server.posts[0].body.propertyId).toBe('prop1')
    expect(server.posts[0].body.trades).toEqual(['plumbing'])
  })

  it('offers no default property and no "all properties"', async () => {
    server.properties = [{ id: 'prop1', name: 'Oak Park' }, { id: 'prop2', name: 'Mountain View' }]
    await render()
    await click(/Post a job/)
    await until(() => !!host.querySelector('select'), 'the property select')
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('')
    const options = [...select.querySelectorAll('option')].map(o => o.textContent)
    expect(options).toEqual(['Choose a property…', 'Oak Park', 'Mountain View'])
  })

  it('says the requirement is per job and does not carry over', async () => {
    server.properties = [{ id: 'prop1', name: 'Oak Park' }]
    await render()
    await click(/Post a job/)
    await until(() => text().includes('Requirements for this job'), 'the requirement block')
    expect(text()).toMatch(/nothing carries over from the property/)
    expect(text()).toMatch(/Contractors who don't meet it can still bid/)
  })
})

describe('reading the bids', () => {
  it('says out loud that only the landlord can see them', async () => {
    server.jobs = [openJob({ bidCount: '1' })]
    server.bids = [bid()]
    await render()
    await click(/Water heater|water heater/)
    await until(() => text().includes('Only you can see these'), 'the privacy line')
    expect(text()).toMatch(/No contractor is shown another's price/)
  })

  it('shows the bid, who made it, and their finished-job count', async () => {
    server.jobs = [openJob({ bidCount: '1' })]
    server.bids = [bid({ notes: 'Can start Monday', contractorBusinessName: 'Kowalski Plumbing' })]
    await render()
    await click(/water heater/)
    await until(() => text().includes('Kowalski Plumbing'), 'the bid')
    expect(text()).toContain('$4,000.00')
    expect(text()).toContain('7 finished through GAM')
    expect(text()).toContain('about 3 days')
    expect(text()).toContain('Can start Monday')
  })

  it('tells a landlord with no bids that contractors can see the job', async () => {
    server.jobs = [openJob()]
    server.bids = []
    await render()
    await click(/water heater/)
    await until(() => text().includes('No bids yet'), 'the no-bids note')
    expect(text()).toMatch(/Contractors in the area see this job/)
  })
})

describe('the insurance gap — warn loudly, let them through', () => {
  it('names the gap on a bid that does not meet the requirement, and still allows the award', async () => {
    server.jobs = [openJob({ requiresInsured: true, bidCount: '1' })]
    server.bids = [bid({ insuredAtBid: false })]
    await render()
    await click(/water heater/)
    await until(() => text().includes('You asked for someone'), 'the gap warning')
    expect(text()).toMatch(/You can still award it — it's your property/)

    // The award button is present, not disabled.
    const award = button(/Award at/) as HTMLButtonElement
    expect(award).toBeTruthy()
    expect(award.disabled).toBe(false)

    await click(/Award at/)
    await until(() => server.confirms.length > 0, 'the confirmation')
    // The confirmation repeats the gap rather than hiding it behind a generic yes.
    expect(server.confirms[0].message).toMatch(/did not have the insurance or bond you asked for/)
    await until(() => server.posts.some(p => p.url.endsWith('/award')), 'the award')
    expect(server.posts.find(p => p.url.endsWith('/award'))!.body).toEqual({ bidId: 'bid1' })
  })

  it('does not warn when the bid meets the requirement, and says nothing is charged yet', async () => {
    server.jobs = [openJob({ requiresInsured: true, bidCount: '1' })]
    server.bids = [bid({ insuredAtBid: true, bondedAtBid: true })]
    await render()
    await click(/water heater/)
    await until(() => !!button(/Award at/), 'the award button')
    expect(text()).not.toMatch(/You asked for someone/)
    await click(/Award at/)
    await until(() => server.confirms.length > 0, 'the confirmation')
    expect(server.confirms[0].message).toMatch(/Nothing is charged until the work is finished/)
  })

  it('awards nothing when the landlord backs out of the confirmation', async () => {
    server.jobs = [openJob({ bidCount: '1' })]
    server.bids = [bid()]
    server.confirmAnswer = false
    await render()
    await click(/water heater/)
    await click(/Award at/)
    await until(() => server.confirms.length > 0, 'the confirmation')
    expect(server.posts.some(p => p.url.endsWith('/award'))).toBe(false)
  })
})

describe('settling a finished job', () => {
  const awarded = () => [openJob({
    status: 'awarded', awardedBidId: 'bid1', awardedAmount: '4000.00',
    cutPercentSnapshot: '3.000', bidCount: '1',
  })]

  it('states both shares in the page before anything is committed', async () => {
    server.jobs = awarded()
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await click(/Settle this job/)
    await until(() => text().includes('What it actually finished at'), 'the settle form')
    // The money is spelled out, both sides, at the awarded figure.
    expect(text()).toMatch(/Settling at \$4,000\.00/)
    expect(text()).toContain('$3,880.00')   // the contractor's share
    expect(text()).toContain('$120.00')     // GAM's 3%
    // And NOTHING has been sent by opening the form.
    expect(server.posts.some(p => p.url.endsWith('/complete'))).toBe(false)
  })

  it('re-states both shares when the scope moved and the figure changes', async () => {
    server.jobs = awarded()
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await click(/Settle this job/)
    await until(() => !!host.querySelector('input[type="number"]'), 'the amount field')
    await type(host.querySelector('input[type="number"]') as HTMLInputElement, '4600')
    await until(() => text().includes('$4,462.00'), 'the recomputed share')
    expect(text()).toMatch(/Settling at \$4,600\.00/)
    expect(text()).toContain('$138.00')     // 3% of 4,600
  })

  it('sends the figure only on the explicit second click', async () => {
    server.jobs = awarded()
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await click(/Settle this job/)
    await until(() => !!host.querySelector('input[type="number"]'), 'the amount field')
    await type(host.querySelector('input[type="number"]') as HTMLInputElement, '4600')
    await click(/Settle at \$4,600\.00/)
    await until(() => server.posts.some(p => p.url.endsWith('/complete')), 'the settle')
    expect(server.posts.find(p => p.url.endsWith('/complete'))!.body).toEqual({ finalAmount: 4600 })
    // And the landlord is told where the money went.
    await until(() => server.toasts.length > 0, 'the result')
    expect(server.toasts[0]).toMatch(/GAM's share is \$138\.00/)
    expect(server.toasts[0]).toMatch(/the contractor gets \$4,462\.00/)
  })

  it('settles at the awarded price when the figure is left alone', async () => {
    server.jobs = awarded()
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await click(/Settle this job/)
    await click(/Settle at \$4,000\.00/)
    await until(() => server.posts.some(p => p.url.endsWith('/complete')), 'the settle')
    // No amount sent at all: the server uses what it was awarded at.
    expect(server.posts.find(p => p.url.endsWith('/complete'))!.body).toEqual({})
  })

  it('backs out without sending anything', async () => {
    server.jobs = awarded()
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await click(/Settle this job/)
    await click(/Not yet/)
    await until(() => !!button(/Settle this job/), 'the collapsed card')
    expect(server.posts.some(p => p.url.endsWith('/complete'))).toBe(false)
  })

  it('a finished job says the landlord paid what they agreed', async () => {
    server.jobs = [openJob({
      status: 'completed', awardedAmount: '8000.00', finalAmount: '8400.00',
      cutPercentSnapshot: '3.000', awardedBidId: 'bid1',
    })]
    server.bids = [bid({ status: 'accepted', amount: '8000.00' })]
    await render()
    await click(/water heater/)
    await until(() => text().includes('Finished at $8,400.00'), 'the finished card')
    expect(text()).toMatch(/came off the contractor's payout/)
    expect(text()).toMatch(/You paid the price you agreed/)
  })
})

describe('cancelling', () => {
  it('says how many bidders will be told, and cancels on confirmation', async () => {
    server.jobs = [openJob({ bidCount: '2' })]
    server.bids = [bid({ id: 'b1' }), bid({ id: 'b2', amount: '3500.00' })]
    await render()
    await click(/water heater/)
    await click(/Cancel this job/)
    await until(() => server.confirms.length > 0, 'the confirmation')
    expect(server.confirms[0].message).toMatch(/All 2 contractors who bid will be told/)
    await until(() => server.posts.some(p => p.url.endsWith('/cancel')), 'the cancel')
  })
})

describe('permissions', () => {
  it('a worker without "post" sees no Post a job button', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'marketplace.view': true } }
    server.jobs = [openJob()]
    await render()
    await until(() => text().includes('water heater'), 'the job')
    expect(button(/Post a job/)).toBeUndefined()
  })

  it('a worker without "award" cannot award or settle', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'marketplace.view': true, 'marketplace.post': true } }
    server.jobs = [openJob({ status: 'awarded', awardedBidId: 'bid1', awardedAmount: '4000.00',
                             cutPercentSnapshot: '3.000' })]
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await until(() => text().includes('Bids'), 'the detail')
    expect(button(/Settle this job/)).toBeUndefined()
  })

  it('a worker with award CAN settle', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'marketplace.view': true, 'marketplace.award': true } }
    server.jobs = [openJob({ status: 'awarded', awardedBidId: 'bid1', awardedAmount: '4000.00',
                             cutPercentSnapshot: '3.000' })]
    server.bids = [bid({ status: 'accepted' })]
    await render()
    await click(/water heater/)
    await until(() => !!button(/Settle this job/), 'the settle button')
  })
})

describe('what the page never asks the server for', () => {
  it('reads only its own job list, the rate, and the bids on the job it opened', async () => {
    server.jobs = [openJob({ bidCount: '1' })]
    server.bids = [bid()]
    await render()
    await click(/water heater/)
    await until(() => text().includes('Bob Kowalski'), 'the bid')
    // No aggregate, no cross-job bid read, nothing about other contractors.
    for (const url of server.gets) {
      expect(url).toMatch(/^\/(marketplace\/(jobs|rate)|properties)/)
      expect(url).not.toMatch(/lowest|spread|range|all-bids|contractors\?/)
    }
  })
})
