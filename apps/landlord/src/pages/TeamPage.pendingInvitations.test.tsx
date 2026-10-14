// @vitest-environment jsdom
/**
 * 10/13 evening (Nic): "team invites expire after 24 HOURS ... Add RESEND and
 * WITHDRAW buttons on each pending invitation (Team page)."
 *
 * The Team page's pending list, driven here: each row has Resend and Withdraw
 * (gold: both do something), Withdraw asks first (in-app, never a browser
 * dialog), Expires shows a time (a 24-hour link's date is nearly always
 * "tomorrow") or "Expired", and the server's own sentence is shown when it
 * refuses. The routes are pinned in apps/api
 * routes/teamInviteResendWithdraw1013.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const calls = vi.hoisted(() => ({
  posts: [] as string[],
  fail: null as null | { status: number; error: string },
  confirmAnswer: true,
  confirms: [] as Array<{ message: string; opts: any }>,
  toasts: [] as string[],
  errors: [] as string[],
}))
vi.mock('../lib/api', () => ({
  apiGet: async () => [],
  apiPatch: async () => ({}),
  apiDel: async () => ({}),
  apiPost: async (url: string) => {
    calls.posts.push(url)
    if (calls.fail) throw Object.assign(new Error(calls.fail.error), { response: { status: calls.fail.status, data: { success: false, error: calls.fail.error } } })
    return { success: true, data: {} }
  },
}))
vi.mock('../components/dialogs', () => {
  const toast = (t: string) => { calls.toasts.push(t) }
  ;(toast as any).error = (t: string) => { calls.errors.push(t) }
  return {
    toast,
    appConfirm: async (message: string, opts: any) => { calls.confirms.push({ message, opts }); return calls.confirmAnswer },
  }
})

import { PendingInvitations, spansCompanies, type Invitation } from './TeamPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let el: HTMLDivElement
let onChanged: ReturnType<typeof vi.fn>

const inv = (o: Partial<Invitation> = {}): Invitation => ({
  id: 'inv1', email: 'kay.keeper@example.com', role: 'maintenance', status: 'pending',
  expiresAt: '2026-10-14T23:30:00Z', createdAt: '2026-10-13T23:30:00Z', expired: false,
  ...o,
})

async function render(invitations: Invitation[]) {
  await act(async () => {
    root.render(<PendingInvitations invitations={invitations} properties={[]} onChanged={onChanged} />)
  })
}
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const rowOf = (id: string) => el.querySelector(`[data-invitation="${id}"]`) as HTMLTableRowElement
const buttonIn = (id: string, label: string) => {
  const b = [...rowOf(id).querySelectorAll('button')].find(x => x.textContent?.trim() === label)
  if (!b) throw new Error(`no ${label} on ${id}: ${rowOf(id)?.textContent}`)
  return b as HTMLButtonElement
}
async function press(id: string, label: string) {
  await act(async () => { buttonIn(id, label).click() })
  await flush()
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  onChanged = vi.fn()
  calls.posts = []
  calls.fail = null
  calls.confirmAnswer = true
  calls.confirms = []
  calls.toasts = []
  calls.errors = []
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('10/13: each pending invitation has Resend and Withdraw', () => {
  it('every row carries both, gold (both do something), and Expires shows a time', async () => {
    await render([inv({ id: 'a' }), inv({ id: 'b', email: 'other@example.com', role: 'bookkeeper', companyWide: true })])
    expect(el.textContent).toContain('Pending invitations')
    for (const id of ['a', 'b']) {
      for (const label of ['Resend', 'Withdraw']) {
        expect(buttonIn(id, label).className).toBe('btn btn-primary btn-sm')
      }
    }
    const expires = rowOf('a').querySelectorAll('td')[3].textContent ?? ''
    expect(expires).toMatch(/\d{1,2}:\d{2}/)
    expect(expires).not.toContain('Expired')
  })

  it('a lapsed link says Expired, and still offers Resend and Withdraw', async () => {
    await render([inv({ id: 'gone', expired: true })])
    expect(rowOf('gone').querySelectorAll('td')[3].textContent).toBe('Expired')
    expect(buttonIn('gone', 'Resend')).toBeTruthy()
    expect(buttonIn('gone', 'Withdraw')).toBeTruthy()
  })

  it('no pending invitation: no list at all', async () => {
    await render([])
    expect(el.textContent).toBe('')
  })
})

describe('10/13: Resend', () => {
  it('mails a new link (24 hours) and refreshes the list', async () => {
    await render([inv()])
    await press('inv1', 'Resend')
    expect(calls.posts).toEqual(['/scopes/invitations/inv1/resend'])
    expect(calls.toasts).toEqual([
      'A new link is on its way to kay.keeper@example.com. It works for 24 hours, and the earlier link no longer works.',
    ])
    expect(calls.confirms).toEqual([])   // nothing to confirm: nothing is taken away
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("a refusal shows the server's own sentence, and the list is refreshed", async () => {
    calls.fail = { status: 400, error: "They've already accepted this invitation and are on your team." }
    await render([inv()])
    await press('inv1', 'Resend')
    expect(calls.errors).toEqual(["They've already accepted this invitation and are on your team."])
    expect(calls.toasts).toEqual([])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('10/13: Withdraw', () => {
  it('asks first, in the app; Cancel withdraws nothing', async () => {
    calls.confirmAnswer = false
    await render([inv()])
    await press('inv1', 'Withdraw')
    expect(calls.confirms).toEqual([{
      message: 'Withdraw the invitation to kay.keeper@example.com? The link in their email stops working right away.',
      opts: { title: 'Withdraw invitation', confirmLabel: 'Withdraw', danger: true },
    }])
    expect(calls.posts).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('confirmed: withdraws, says the link no longer works, refreshes the list', async () => {
    await render([inv()])
    await press('inv1', 'Withdraw')
    expect(calls.posts).toEqual(['/scopes/invitations/inv1/revoke'])
    expect(calls.toasts).toEqual(['Invitation to kay.keeper@example.com withdrawn. Its link no longer works.'])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("a refusal shows the server's own sentence", async () => {
    calls.fail = { status: 400, error: 'This invitation was already withdrawn.' }
    await render([inv()])
    await press('inv1', 'Withdraw')
    expect(calls.errors).toEqual(['This invitation was already withdrawn.'])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

// 10/13 review: the same address may be invited to two of the account's
// companies (one pending invitation per company, role and address). The rows
// looked alike, and Withdraw named only the email, so the owner could take
// back the wrong company's invitation.
describe("10/13 review: an owner of two companies sees which company each invitation is for", () => {
  it('the same address invited to both companies: each row names its company, and the question and the answer name it too', async () => {
    const both = [
      inv({ id: 'op', landlordId: 'L-oak', companyName: 'Oak Park' }),
      inv({ id: 'mv', landlordId: 'L-mtn', companyName: 'Mountain View' }),
    ]
    expect(spansCompanies(both)).toBe(true)
    await act(async () => {
      root.render(<PendingInvitations invitations={both} properties={[]} onChanged={onChanged} multiCompany />)
    })
    expect([...el.querySelectorAll('th')].map(t => t.textContent)).toEqual(['Email', 'Company', 'Role', 'Sent', 'Expires', ''])
    expect(rowOf('op').querySelectorAll('td')[1].textContent).toBe('Oak Park')
    expect(rowOf('mv').querySelectorAll('td')[1].textContent).toBe('Mountain View')

    await press('mv', 'Withdraw')
    expect(calls.confirms.map(c => c.message)).toEqual([
      'Withdraw the invitation to kay.keeper@example.com (Mountain View)? The link in their email stops working right away.',
    ])
    expect(calls.posts).toEqual(['/scopes/invitations/mv/revoke'])
    expect(calls.toasts).toEqual(['Invitation to kay.keeper@example.com (Mountain View) withdrawn. Its link no longer works.'])

    await press('op', 'Resend')
    expect(calls.posts).toEqual(['/scopes/invitations/mv/revoke', '/scopes/invitations/op/resend'])
    expect(calls.toasts[1]).toBe('A new link is on its way to kay.keeper@example.com (Oak Park). It works for 24 hours, and the earlier link no longer works.')
  })

  it('one company: no Company column, and the rows read as before', async () => {
    const one = [inv({ id: 'a', landlordId: 'L-oak', companyName: 'Oak Park' }), inv({ id: 'b', email: 'b@example.com', landlordId: 'L-oak', companyName: 'Oak Park' })]
    expect(spansCompanies(one)).toBe(false)
    await act(async () => {
      root.render(<PendingInvitations invitations={one} properties={[]} onChanged={onChanged} multiCompany={spansCompanies(one)} />)
    })
    expect([...el.querySelectorAll('th')].map(t => t.textContent)).toEqual(['Email', 'Role', 'Sent', 'Expires', ''])
    expect(el.textContent).not.toContain('Oak Park')
  })

  it("the Team page counts members' companies too: one invitation, members in two companies, still names the company", () => {
    expect(spansCompanies([{ landlordId: 'L-oak' }, { landlordId: 'L-mtn' }, inv({ landlordId: 'L-oak' })])).toBe(true)
    expect(spansCompanies([{ landlordId: 'L-oak' }, inv({ landlordId: 'L-oak' })])).toBe(false)
    expect(spansCompanies([])).toBe(false)
  })
})
