/**
 * 10/20 (Nic, relaying Blu) — TYPING THE PARK'S TASK LIST.
 *
 * Nic asked for "something smooth", and for this screen smooth has a concrete
 * meaning worth holding: a landlord with six jobs in their head types a line,
 * presses enter, and types the next one. No modal, no save button hunt, and the
 * cursor never leaves the box. That behavior is the feature, so it is tested
 * rather than left to whoever next refactors the component.
 *
 * Also held here: the maintenance person's version of the same screen has no
 * way to write the list. Nic: "it's stuff assigned by the landlord himself."
 * The server refuses them anyway (routes/propertyTaskList.ts, and its suite),
 * but a button that 403s is a worse screen than no button.
 *
 * Run: cd apps/landlord && npx vitest run pages/PropertyTaskListTab.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  items: [] as any[],
  posts: [] as { url: string; body: any }[],
  gets: [] as string[],
}))
vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => { server.gets.push(url); return server.items },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    // The API answers with the saved line; the component refetches anyway.
    if (/\/property-task-list\/[^/]+$/.test(url)) {
      server.items = [...server.items, {
        id: `i${server.items.length + 1}`, body: body.body,
        doneAt: null, doneByUserId: null, doneByName: null, addedByUserId: 'u1',
      }]
    }
    return { success: true, data: server.items[server.items.length - 1] }
  },
}))
const perms = vi.hoisted(() => ({ isOwner: true }))
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ isOwner: perms.isOwner, can: () => perms.isOwner }) }))

import { PropertyTaskListTab } from './PropertyTaskListTab'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.items = []
  server.posts = []
  server.gets = []
  perms.isOwner = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const box = () => host.querySelector('input') as HTMLInputElement | null
const buttonSaying = (label: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(label))

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

async function show(kind?: 'job' | 'supply') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <PropertyTaskListTab propertyId="p1" kind={kind} />
      </QueryClientProvider>,
    )
  })
  await settle()
}

// React tracks a controlled input's value through the prototype's setter and
// ignores a plain `input.value = x`, so the change event it sees carries the OLD
// value and onChange never fires. Going through the native setter is what makes
// jsdom typing look like real typing.
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

/** Type into the box and press enter, the way a landlord does. */
async function typeAndEnter(line: string) {
  const input = box()!
  await act(async () => {
    nativeValue.call(input, line)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await settle()
}

describe('the landlord types the list', () => {
  it('adds a line on enter, clears the box, and keeps the cursor in it', async () => {
    await show()
    await typeAndEnter('Fix the meters on row C')

    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].body).toEqual({ body: 'Fix the meters on row C', kind: 'job' })
    expect(text()).toContain('Fix the meters on row C')
    // Empty and still focused — the next line can just be typed.
    expect(box()!.value).toBe('')
    expect(document.activeElement).toBe(box())
  })

  it('takes line after line without a dialog in between', async () => {
    await show()
    for (const line of ['Fix the meters on row C', 'Re-gravel RV 14', 'Swap the laundry bulb'])
      await typeAndEnter(line)

    expect(server.posts.map(p => p.body.body)).toEqual([
      'Fix the meters on row C', 'Re-gravel RV 14', 'Swap the laundry bulb',
    ])
    // Nothing modal ever opened.
    expect(host.querySelector('.modal-overlay')).toBeNull()
    expect(host.querySelector('.modal')).toBeNull()
  })

  it('ignores an empty line rather than saving a blank task', async () => {
    await show()
    await typeAndEnter('   ')
    expect(server.posts).toHaveLength(0)
  })

  // 10/21 (Nic): the words ARE the feature. This screen used to prompt "Fix the
  // meters on row C" and describe itself as "fix the meters, re-gravel a site,
  // swap a bulb" — all three of which he then ruled out: "meter reads should not
  // ever be here, along with changing a broken meter, fixing gravel, whatever…
  // It's an owner that says, hey, I want you to take some pictures of this
  // apartment, get it listed as available." A screen that asks for the wrong
  // thing gets the wrong thing.
  it('asks for the work Nic actually wants here, and says what belongs elsewhere', async () => {
    await show()
    expect(text()).toContain('take pictures of a vacant one and get it listed')
    // Both of the places the wrong thing would otherwise land, named.
    expect(text()).toContain('a maintenance request')
    expect(text()).toContain('a closing read is taken at the counter')
    expect(text()).toContain('Nothing here is timed, counted or reported on')
    // And it no longer invites any of the three he ruled out.
    expect(text()).not.toContain('re-gravel')
    expect(text()).not.toContain('swap a bulb')
    expect(text()).not.toContain('fix the meters')
    const box = host.querySelector('input') as HTMLInputElement
    expect(box.placeholder).toBe('Take pictures of MH 14 and get it listed')
    expect(text()).toContain('Press enter to add it and keep typing.')
  })
})

describe('the maintenance person reads and ticks, nothing else', () => {
  beforeEach(() => { perms.isOwner = false })

  it('has no box to type in and no way to remove a line', async () => {
    server.items = [{
      id: 'i1', body: 'Fix the meters on row C',
      doneAt: null, doneByUserId: null, doneByName: null, addedByUserId: 'u1',
    }]
    await show()

    expect(text()).toContain('Fix the meters on row C')
    expect(box()).toBeNull()
    expect(buttonSaying('Add')).toBeUndefined()
    // The only control on the row is the tick.
    const labels = [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Mark it done'])
  })

  it('ticking posts to this property\'s item and nothing else', async () => {
    server.items = [{
      id: 'i1', body: 'Fix the meters on row C',
      doneAt: null, doneByUserId: null, doneByName: null, addedByUserId: 'u1',
    }]
    await show()

    const tick = [...host.querySelectorAll('button')]
      .find(b => b.getAttribute('aria-label') === 'Mark it done')!
    await act(async () => { tick.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()

    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].url).toBe('/property-task-list/p1/items/i1/done')
  })
})

describe('a ticked line is kept, with who did it', () => {
  it('reads below the open ones, struck through, naming the person', async () => {
    server.items = [
      { id: 'i1', body: 'Fix the meters on row C', addedByUserId: 'u1',
        doneAt: '2026-10-20T18:00:00.000Z', doneByUserId: 'w1', doneByName: 'Dale Pruitt' },
      { id: 'i2', body: 'Swap the laundry bulb', addedByUserId: 'u1',
        doneAt: null, doneByUserId: null, doneByName: null },
    ]
    await show()

    // The open one is read first; the done one is still on the list under "Done".
    expect(text().indexOf('Swap the laundry bulb'))
      .toBeLessThan(text().indexOf('Done by Dale Pruitt'))
    expect(text()).toContain('Done by Dale Pruitt')
    expect(text()).toContain('1 to do')
  })
})

/**
 * 10/21 (Nic), after a stray click on Mountain View's own list:
 *
 *   "I clicked on it and it highlighted and I couldn't unclick it. And then I
 *    tried to X out of it and it deleted it from the list, not completed it. So
 *    whatever was there, I didn't get a chance to read it."
 *
 * The data was never gone — the row sat there with hidden_at stamped on it —
 * but no button on this screen could bring either one back, and a screen with
 * no way back is the same as gone to the person standing at it.
 */
describe('10/21: neither the tick nor the X is one-way for the owner', () => {
  it('a ticked line un-ticks from the same circle', async () => {
    server.items = [{
      id: 'i1', body: 'Fix the meters on row C', addedByUserId: 'u1',
      doneAt: '2026-10-21T20:20:00.000Z', doneByUserId: 'u1', doneByName: 'Nic Rhoades',
    }]
    await show()
    const circle = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Un-tick it')!
    expect(circle).toBeTruthy()
    expect((circle as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { circle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(server.posts.map(p => p.url)).toEqual(['/property-task-list/p1/items/i1/undone'])
  })

  it('a line taken off the list is readable under its own heading, with a way back', async () => {
    server.items = [
      { id: 'i1', body: 'Swap the laundry bulb', addedByUserId: 'u1',
        doneAt: null, doneByUserId: null, doneByName: null, hiddenAt: null },
      { id: 'i2', body: 'Final electric read — RV 44, take it the day they leave', addedByUserId: 'u1',
        doneAt: null, doneByUserId: null, doneByName: null, hiddenAt: '2026-10-21T20:20:00.000Z' },
    ]
    await show()
    // Not among the jobs, and not counted as one to do …
    expect(text()).toContain('1 to do')
    expect(text()).toContain('Taken off the list (1)')
    // … and one click reads it again.
    const fold = [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Taken off the list'))!
    await act(async () => { fold.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(text()).toContain('Final electric read — RV 44')

    const back = [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Put it back'))!
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(server.posts.map(p => p.url)).toEqual(['/property-task-list/p1/items/i2/unhide'])
  })

  it('the X says it is not the same as done, and where the line goes', async () => {
    server.items = [{
      id: 'i1', body: 'Fix the meters on row C', addedByUserId: 'u1',
      doneAt: null, doneByUserId: null, doneByName: null, hiddenAt: null,
    }]
    await show()
    const x = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Take it off the list')!
    expect(x.getAttribute('title')).toContain('not the same as done')
    expect(x.getAttribute('title')).toContain('put it back')
  })

  it('the maintenance person gets no un-tick, no X and no removed pile', async () => {
    perms.isOwner = false
    server.items = [
      { id: 'i1', body: 'Fix the meters on row C', addedByUserId: 'u1',
        doneAt: '2026-10-21T20:20:00.000Z', doneByUserId: 'w1', doneByName: 'Dale Pruitt', hiddenAt: null },
    ]
    await show()
    const labels = [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Done'])
    expect(text()).not.toContain('Taken off the list')
  })
})

/**
 * 10/21 (Nic) — THE SUPPLY LIST, WHICH IS THE TASK LIST WITH THE RULES THE
 * OTHER WAY ROUND.
 *
 *   "We also need a way for maybe maintenance people or work trade people to
 *    put in sort of a collected shopping cart pool of, hey, we need to buy some
 *    new paint brushes and new trash bags. Like, anybody can contribute to a
 *    list of things to purchase. The owner can consult that list when either
 *    ordering online or running to the store. But that way he doesn't have text
 *    messages from like 5 or 6 different people saying we need this and we need
 *    this, and, you know, consolidate the list all in one spot."
 *
 * So: anybody working the park WRITES, and only the owner ticks it bought.
 * Inverted from the task list, on the same screen, which is why the rules are
 * tested rather than trusted to whoever reads the component next.
 */
describe('10/21: the supply list — anybody adds, the owner buys', () => {
  const supply = (over: any = {}) => ({
    id: 'i1', body: 'Trash bags — the 55 gallon ones', kind: 'supply',
    addedByUserId: 'w1', addedByName: 'Dale Pruitt', mine: false,
    doneAt: null, doneByUserId: null, doneByName: null, hiddenAt: null, ...over,
  })

  it('asks for things to buy, in Nic\'s words, and says where a line lives', async () => {
    perms.isOwner = true
    await show('supply')
    expect(text()).toContain('Things to buy for this property')
    expect(text()).toContain('paint brushes, trash bags')
    expect(text()).toContain('one list stands in for six text messages')
    const box = host.querySelector('input') as HTMLInputElement
    expect(box.placeholder).toBe('Trash bags — the 55 gallon ones')
  })

  it('the maintenance person CAN add a line here, which they cannot on the task list', async () => {
    perms.isOwner = false
    await show('supply')
    const box = host.querySelector('input') as HTMLInputElement
    expect(box).toBeTruthy()
    await typeAndEnter('Two gallons of flat white')
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].body).toEqual({ body: 'Two gallons of flat white', kind: 'supply' })
  })

  it('but only the owner marks it bought', async () => {
    perms.isOwner = false
    server.items = [supply()]
    await show('supply')
    const circle = [...host.querySelectorAll('button')]
      .find(b => b.getAttribute('aria-label') === 'Only the owner marks this one') as HTMLButtonElement
    expect(circle).toBeTruthy()
    expect(circle.disabled).toBe(true)

    perms.isOwner = true
    await show('supply')
    const ownerCircle = [...host.querySelectorAll('button')]
      .find(b => b.getAttribute('aria-label') === 'Mark it bought') as HTMLButtonElement
    expect(ownerCircle.disabled).toBe(false)
    await act(async () => { ownerCircle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(server.posts.map(p => p.url)).toEqual(['/property-task-list/p1/items/i1/done'])
  })

  it('a bought line reads "Bought by", not "Done by"', async () => {
    perms.isOwner = true
    server.items = [supply({ doneAt: '2026-10-21T20:00:00.000Z', doneByUserId: 'u1', doneByName: 'Nic Rhoades' })]
    await show('supply')
    expect(text()).toContain('Bought by Nic Rhoades')
    expect(text()).toContain('Bought')
    expect(text()).not.toContain('Done by')
  })

  const hasX = () => [...host.querySelectorAll('button')]
    .some(b => b.getAttribute('aria-label') === 'Take it off the list')

  it('whoever asked for it can take their own request back while it is unbought', async () => {
    perms.isOwner = false
    server.items = [supply({ mine: true })]
    await show('supply')
    expect(hasX()).toBe(true)
  })

  it('but not somebody else\'s request — that is not theirs to cancel', async () => {
    perms.isOwner = false
    server.items = [supply({ mine: false })]
    await show('supply')
    expect(hasX()).toBe(false)
  })

  it('nor their own once it has been bought — the owner spent the money', async () => {
    perms.isOwner = false
    server.items = [supply({ mine: true, doneAt: '2026-10-21T20:00:00.000Z', doneByName: 'Nic Rhoades' })]
    await show('supply')
    expect(hasX()).toBe(false)
  })

  it('says who asked for each thing, which is the point of pooling them', async () => {
    perms.isOwner = true
    server.items = [supply(), supply({ id: 'i2', body: 'Paint brushes', addedByName: 'Bill Geisman' })]
    await show('supply')
    expect(text()).toContain('Asked for by Dale Pruitt')
    expect(text()).toContain('Asked for by Bill Geisman')
  })

  it('reads the park\'s supply list, not its task list', async () => {
    perms.isOwner = true
    await show('supply')
    expect(server.gets.some(u => u.includes('kind=supply'))).toBe(true)
    expect(server.gets.some(u => u.includes('kind=job'))).toBe(false)
  })
})
