// @vitest-environment jsdom
/**
 * Step 9 (final fix) — the deposit-return page shows the SERVER's money
 * figures (refund_amount, gap_amount, prepaid_credit_used, prepaid_credit_left,
 * deposit_interest_credited, the interest still owed) and never works a refund
 * out itself. Before this it showed deposit + interest − deductions, so the
 * landlord could confirm one refund while finalize paid another. The figures
 * below follow decision #46.2 (move-out deductions come out of the security
 * deposit first; paid-ahead money covers only what the deposit cannot) — the
 * page just shows what the server sends. Staff-screen rules: fresh figures at
 * the moment of action (the confirm's figures go with the finalize, and a 409
 * refetches in place and is said once), Cancel backs out with nothing sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const server = vi.hoisted(() => ({
  answers: [] as any[],          // GET answers, in order (the last one repeats)
  gets: 0,
  patches: [] as any[],
  posts: [] as string[],
  finalizeBodies: [] as any[],
  finalizeFail: null as null | { status: number; error: string },
  finalizeAnswer: { success: true, data: { status: 'sent_refund' } } as any,
  // #47a: answers to the refund buttons, by the end of the URL (an Error is thrown).
  postAnswers: {} as Record<string, any>,
  postBodies: [] as any[],
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

// Fix pass 2: every answer below is written as the SERVER sends it
// (snake_case) and reaches the page through camelizeKeys — what lib/api's
// applyCamelizeInterceptor does to every response — so a key renamed on either
// side fails here. (damage_lines and damage_evidence are passed through
// untouched by it: their items keep the server's own keys.)
vi.mock('../lib/api', async () => ({
  apiGet: async (url: string) => {
    const { camelizeKeys } = await import('@gam/shared')
    if (!url.endsWith('/deposit-return')) throw new Error(`unexpected GET ${url}`)
    const a = server.answers[Math.min(server.gets, server.answers.length - 1)]
    server.gets++
    if (a instanceof Error) throw a
    return camelizeKeys(a)
  },
  apiPatch: async (url: string, body: any) => {
    server.patches.push({ url, body })
    return { id: 'dr1' }
  },
  apiPost: async (url: string, body?: any) => {
    server.posts.push(url)
    if (url.endsWith('/finalize')) {
      server.finalizeBodies.push(body)
      if (server.finalizeFail) { const f = server.finalizeFail; server.finalizeFail = null; throw httpError(f.status, f.error) }
      return server.finalizeAnswer
    }
    server.postBodies.push(body)
    const key = Object.keys(server.postAnswers).find((k) => url.endsWith(k))
    if (key) {
      const a = server.postAnswers[key]
      if (a instanceof Error) throw a
      // Fix pass 2: lib/api's apiPost answers the WHOLE envelope (it does not
      // unwrap .data), its payload camelized as applyCamelizeInterceptor does
      // to a { success, data } body — exactly what the refund buttons receive.
      const { camelizeKeys } = await import('@gam/shared')
      return { success: true, data: camelizeKeys(a) }
    }
    return { success: true, data: { id: 'dr1' } }
  },
}))
vi.mock('../components/dialogs', () => ({ toast: vi.fn() }))

import { DepositReturnPage } from './DepositReturnPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** A saved draft as the API answers it (snake_case; the client camelizes it): $500
 *  deposit, $300 paid ahead, $40 cleaning — under #46.2 the deposit pays the
 *  cleaning, so $460 back, none of the paid-ahead money used, $300 left. */
const draft = (o: Record<string, unknown> = {}) => ({
  id: 'dr1', status: 'draft', finalized_at: null, notes: null,
  total_deposit: 500, interest_accrued: 0, deposit_interest_credited: 0,
  prepaid_credit_used: 0, prepaid_credit_left: 300,
  cleaning_fee_amount: 40, unpaid_balance_amount: 0, unpaid_balance_lines: [],
  final_utility_lines: [], final_utility_total: 0, damage_lines_total: 0, other_deductions_total: 0,
  damage_lines: [], other_deductions: [],
  total_deductions: 40, refund_amount: 460, gap_amount: 0,
  refund_from_gam: 460, refund_from_landlord: 0, closed_at_move_out_lines: [], closed_at_move_out_total: 0,
  approval_threshold: 500, viewer_is_owner: true, move_out_inspection_required: false, move_out_inspection: null,
  ...o,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.answers = [draft()]; server.gets = 0; server.patches = []; server.posts = []; server.finalizeBodies = []
  server.finalizeFail = null; server.finalizeAnswer = { success: true, data: { status: 'sent_refund' } }
  server.postAnswers = {}; server.postBodies = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/leases/lease1/deposit-return']}>
          <Routes>
            <Route path="/leases/:id/deposit-return" element={<DepositReturnPage />} />
            <Route path="/leases/:leaseId/paid-ahead-choice" element={<div>The paid-ahead choice page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('Deposits held'), 'the page')
}
async function click(el: Element | undefined) {
  if (!el) throw new Error(`nothing to click; screen: ${text()}`)
  await act(async () => { (el as HTMLElement).click() })
}
const dialog = () => host.querySelector('[role="dialog"]')
const count = (s: string) => text().split(s).length - 1

describe('Deposit return: the server\'s figures, never the page\'s own sum', () => {
  it('$500 deposit, $300 paid ahead, $40 cleaning: shows the server\'s $460 refund and the $300 paid ahead left for the landlord\'s choice — never $500', async () => {
    await open()
    const tiles = text()
    expect(tiles).toContain('Refund to tenant')
    expect(tiles).toContain('$460.00')
    // None of the paid-ahead money was used, so no "used" tile or row.
    expect(tiles).not.toContain('Paid ahead, used for what the deposit didn\'t cover')
    expect(host.querySelector('[data-testid="money-breakdown"]')!.textContent).toContain('Refund to tenant$460.00')
    // #46.1: the money left waits for the landlord's choice, on its own page.
    expect(host.querySelector('[data-testid="paid-ahead-left"]')?.textContent)
      .toBe('$300.00 the tenant paid ahead is left over — money paid ahead is used only for what the deposit didn\'t cover, and the deposit covered it all. ' +
        'It is not part of the deposit refund: it stays on this lease. After this is finalized, you choose what happens to it — refund it, keep it, or leave it as their credit.')
    expect(text()).not.toContain('until you choose')
  })

  it('before finalize there is no "Choose what happens to it" button — the choice page cannot act yet (draft and preview)', async () => {
    await open()
    expect([...host.querySelector('[data-testid="paid-ahead-left"]')!.querySelectorAll('button')]).toHaveLength(0)
    act(() => root.unmount())
    root = createRoot(host)
    server.answers = [draft({ id: undefined, status: undefined, preview: true })]; server.gets = 0
    await open()
    expect(button(/Begin Move-Out/)).toBeTruthy()
    expect([...host.querySelector('[data-testid="paid-ahead-left"]')!.querySelectorAll('button')]).toHaveLength(0)
  })

  it('on a finalized return the gold button opens the landlord\'s paid-ahead choice page for this lease', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z' })]
    await open()
    const go = [...host.querySelector('[data-testid="paid-ahead-left"]')!.querySelectorAll('button')]
      .find(b => b.textContent === 'Choose what happens to it')
    expect(go?.className).toContain('btn-primary')
    await click(go)
    await until(() => text().includes('The paid-ahead choice page'), 'the choice page')
  })

  it('a team member without "Issue refunds" gets no button on a finalized return — it says the landlord chooses', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', viewer_is_owner: false, viewer_can_decide_paid_ahead: false })]
    await open()
    const line = host.querySelector('[data-testid="paid-ahead-left"]')!
    expect(line.querySelectorAll('button')).toHaveLength(0)
    expect(line.textContent).toContain('it waits for the landlord\'s choice: refund it, keep it, or leave it as their credit.')
  })

  // decisions #47c (Nic): never who HOLDS the deposit — only how each part comes back.
  it('#46.3/#47c: a split refund says how each part comes back — online the way it was paid, the rest at the office — never who holds it, before and in the confirm', async () => {
    server.answers = [draft({ refund_from_gam: 200, refund_from_landlord: 260 })]
    await open()
    const who = '$200.00 goes back to the tenant the way they paid it online; $260.00 is handed back to them at the office — you hand that part back.'
    expect(text()).not.toMatch(/GAM holds|GAM held|holds this deposit|hold this deposit|deposit money paid to/)
    expect(host.querySelector('[data-testid="refund-who"]')?.textContent).toBe(who)
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    // #47a: finalize now SENDS the part paid online (was "This will record a refund of … owed to the tenant").
    expect(dialog()!.textContent).toContain(`This will refund $460.00 to the tenant. ${who}`)
  })

  it('#46.3 to a team member: the landlord — not the viewer — hands back their part; never "paid to you"', async () => {
    server.answers = [draft({ refund_from_gam: 200, refund_from_landlord: 260, viewer_is_owner: false, approval_threshold: 1000 })]
    await open()
    expect(host.querySelector('[data-testid="refund-who"]')?.textContent)
      .toBe('$200.00 goes back to the tenant the way they paid it online; $260.00 is handed back to them at the office — the landlord hands that part back.')
    expect(text()).not.toContain('you hand')
    act(() => root.unmount())
    root = createRoot(host)
    server.answers = [draft({ refund_from_gam: 0, refund_from_landlord: 460, viewer_is_owner: false, approval_threshold: 1000 })]
    server.gets = 0
    await open()
    expect(host.querySelector('[data-testid="refund-who"]')?.textContent)
      .toBe('It is handed back to the tenant at the office — the landlord hands it back.')
    expect(text()).not.toContain('you hand it back')
    expect(text()).not.toMatch(/GAM holds|GAM held|holds this deposit|hold this deposit|deposit money paid to/)
  })

  it('names the household and the space in the header and in the confirm — never an id', async () => {
    server.answers = [draft({ household: { tenant_names: ['Jane Doe', 'Sam Doe'], unit_number: 'RV 22', property_name: 'Oak Park' } })]
    await open()
    expect(host.querySelector('[data-testid="who"]')?.textContent).toBe('Move-out for Jane Doe and Sam Doe — RV 22, Oak Park')
    expect(text()).not.toContain('lease1')
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(dialog()!.querySelector('[data-testid="confirm-who"]')?.textContent).toBe('For Jane Doe and Sam Doe — RV 22, Oak Park')
  })

  it('an unpaid up-front last month\'s rent closed at move-out is named in plain words', async () => {
    server.answers = [draft({ closed_at_move_out_lines: [{ payment_id: 'p8', kind: 'prepaid', label: 'Last month rent', amount: 1000 }], closed_at_move_out_total: 1000 })]
    await open()
    const card = host.querySelector('[data-testid="closed-lines"]')!.textContent!
    expect(card).toContain('Last month rent · Last month\'s rent due up front — never paid$1,000.00')
    expect(card).toContain('A last month\'s rent due up front is not owed either: the months it was for are billed as ordinary rent.')
    expect(card).not.toContain('Rent paid ahead, never paid')
  })

  it('#46.4: never-paid deposits closed at move-out are listed as no longer owed, never as deductions', async () => {
    server.answers = [draft({ closed_at_move_out_lines: [{ payment_id: 'p9', kind: 'deposit', label: 'Pet deposit', amount: 200 }], closed_at_move_out_total: 200 })]
    await open()
    const card = host.querySelector('[data-testid="closed-lines"]')!.textContent!
    expect(card).toContain('No longer owed')
    expect(card).toContain('Pet deposit · Deposit — never paid$200.00')
    expect(card).toContain('they are not taken from the deposit')
    expect(host.querySelector('[data-testid="money-breakdown"]')!.textContent).not.toContain('Pet deposit')
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(dialog()!.textContent).toContain('$200.00 the tenant never paid (Pet deposit) is closed as no longer owed.')
  })

  it('$600 of deductions on a $500 deposit with $300 paid ahead: shows $100 of the paid-ahead money used, $200 left and no refund', async () => {
    server.answers = [draft({ total_deductions: 600, cleaning_fee_amount: 600, prepaid_credit_used: 100, prepaid_credit_left: 200, refund_amount: 0, gap_amount: 0 })]
    await open()
    expect(text()).toContain('Paid ahead, used for what the deposit didn\'t cover')
    expect(host.querySelector('[data-testid="money-breakdown"]')!.textContent)
      .toContain('Paid ahead by the tenant, used for what the deposit didn\'t cover$100.00')
    expect(host.querySelector('[data-testid="paid-ahead-left"]')?.textContent).toContain('$200.00 the tenant paid ahead is left over')
    expect(host.querySelector('[data-testid="money-breakdown"]')!.textContent).toContain('Refund to tenant$0.00')
  })

  it('deductions beyond the deposit and the paid-ahead money: the shortfall shown is the server\'s gap', async () => {
    server.answers = [draft({ total_deposit: 200, total_deductions: 400, prepaid_credit_used: 100, prepaid_credit_left: 0, refund_amount: 0, gap_amount: 100 })]
    await open()
    expect(text()).toContain('Tenant owes')
    expect(text()).toContain('$100.00')
    expect(host.querySelector('[data-testid="paid-ahead-left"]')).toBeNull()
  })

  it('deposit interest still owed and interest credited earlier are listed from the server', async () => {
    server.answers = [draft({ interest_accrued: 2.5, deposit_interest_credited: 3, refund_amount: 465.5 })]
    await open()
    const b = host.querySelector('[data-testid="money-breakdown"]')!.textContent!
    expect(b).toContain('Deposit interest still owed$2.50')
    expect(b).toContain('Deposit interest credited earlier, not yet used$3.00')
    expect(b).toContain('Refund to tenant$465.50')
  })

  it('a team member\'s approval limit is judged on the server refund, not deposit − deductions', async () => {
    // deposit − deductions would be $800 (over the $450 limit); finalize pays $400.
    server.answers = [draft({ viewer_is_owner: false, approval_threshold: 450, total_deposit: 900, total_deductions: 100,
      prepaid_credit_used: 0, prepaid_credit_left: 0, refund_amount: 400 })]
    await open()
    expect(button(/Review & Finalize/)).toBeTruthy()
    expect(button(/Send to Landlord for Approval/)).toBeUndefined()
  })

  it('a refund over the limit sends it for approval, on the server refund', async () => {
    // deposit − deductions would be $460 (under $480); the server refund is $500.
    server.answers = [draft({ viewer_is_owner: false, approval_threshold: 480, refund_amount: 500 })]
    await open()
    expect(button(/Send to Landlord for Approval/)).toBeTruthy()
  })

  it('Review & Finalize saves, reads the figures fresh, the confirm shows the fresh refund, and those figures go with the finalize', async () => {
    server.answers = [draft(), draft({ refund_amount: 430, total_deductions: 70, prepaid_credit_left: 300 })]
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(server.patches).toHaveLength(1)
    expect(server.gets).toBe(2)
    expect(dialog()!.textContent).toContain('This will refund $430.00 to the tenant.')
    // #46.3/#47c: how it comes back — never who holds it, never "comes out of
    // your next payout", never "pays it out" (what is recorded).
    expect(dialog()!.textContent).toContain('It goes back to the tenant the way they paid it online.')
    expect(dialog()!.textContent).not.toMatch(/GAM holds|holds this deposit/)
    expect(dialog()!.textContent).not.toContain('next payout')
    expect(dialog()!.textContent).not.toContain('pays it out')
    expect(dialog()!.textContent).toContain('$300.00 the tenant paid ahead is left over. It is not part of this refund — it stays on this lease, and once this is finalized you choose what happens to it (refund it, keep it, or leave it as their credit).')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Finalize'))
    await until(() => server.posts.some(p => p.endsWith('/finalize')), 'the finalize')
    // Fix pass 3: who refunds which part and the paid-ahead money used go
    // with it too — finalize refuses if any of them moved.
    expect(server.finalizeBodies).toEqual([{
      expectedRefund: 430, expectedGap: 0, expectedPaidAheadUsed: 0,
      expectedRefundFromGam: 460, expectedRefundFromLandlord: 0,
    }])
  })

  it('a deposit paid at the office: the confirm says it is handed back at the office, by you — never who holds it', async () => {
    server.answers = [draft({ refund_from_gam: 0, refund_from_landlord: 460 })]
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(dialog()!.textContent).toContain('It is handed back to the tenant at the office — you hand it back.')
    expect(dialog()!.textContent).not.toMatch(/holds|paid to you|GAM does not send/)
  })

  it('paid-ahead money that paid what the deposit didn\'t cover is said in the confirm', async () => {
    server.answers = [draft({ total_deductions: 600, prepaid_credit_used: 100, prepaid_credit_left: 200, refund_amount: 0 })]
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(dialog()!.textContent).toContain('$100.00 the tenant paid ahead pays what the deposit didn\'t cover.')
  })

  // ── Step 9 final fix (fix pass 1 — decisions #48.6) ──
  const CLEARING = 'A $450.00 bank payment toward rent, made Oct 2, 2026, is still clearing, so the move-out can’t be finalized yet. ' +
    'It should clear by Oct 9, 2026. Finalize once it clears or fails.'

  it('a payment on the tenancy still clearing: the page says so with the day it should clear, before anyone presses Finalize', async () => {
    server.answers = [draft({ payments_clearing: CLEARING })]
    await open()
    expect(host.querySelector('[data-testid="payments-clearing"]')?.textContent).toBe(CLEARING)
    expect(count(CLEARING)).toBe(1)
  })

  it('it cleared since the page opened: Review & Finalize reads fresh, the note is gone, and the confirm opens', async () => {
    server.answers = [draft({ payments_clearing: CLEARING }), draft({ payments_clearing: null })]
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(host.querySelector('[data-testid="payments-clearing"]')).toBeNull()
  })

  it('still clearing at the moment of action: no confirm opens and the fresh note says it once', async () => {
    server.answers = [draft(), draft({ payments_clearing: CLEARING })]
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!host.querySelector('[data-testid="payments-clearing"]'), 'the fresh note')
    expect(dialog()).toBeNull()
    expect(count(CLEARING)).toBe(1)
    expect(server.posts.filter(p => p.endsWith('/finalize'))).toHaveLength(0)
  })

  // Fix pass 2 (review): a payment stuck more than a week is never a dead end.
  const STUCK = 'A payment on this tenancy has been waiting more than a week without clearing or failing, so the move-out can’t be finalized yet. ' +
    'GAM has been told and will check it with the payment processor, then finish or cancel it; you can finalize once it clears or is canceled.'

  it('a payment stuck more than a week: the page says GAM has been told — once — and no finalize is sent', async () => {
    server.answers = [draft({ payments_clearing: STUCK })]
    await open()
    expect(host.querySelector('[data-testid="payments-clearing"]')?.textContent).toBe(STUCK)
    expect(count('GAM has been told')).toBe(1)
    expect(text()).not.toMatch(/should clear by/)
    await click(button(/Review & Finalize/))
    await until(() => !!host.querySelector('[data-testid="payments-clearing-checked"]'), 'the check-again line')
    expect(count('GAM has been told')).toBe(1)
    expect(dialog()).toBeNull()
    expect(server.posts.filter(p => p.endsWith('/finalize'))).toHaveLength(0)
  })

  it('pressing Review & Finalize while still clearing visibly checks again: the note says when it was checked and takes focus — never a press where nothing happens', async () => {
    server.answers = [draft({ payments_clearing: CLEARING })]
    await open()
    const press = button(/Review & Finalize/)!
    expect(press.disabled).toBe(false)
    expect(press.title).toMatch(/still clearing — pressing checks again/)
    await click(press)
    await until(() => !!host.querySelector('[data-testid="payments-clearing-checked"]'), 'the check-again line')
    expect(host.querySelector('[data-testid="payments-clearing-checked"]')!.textContent)
      .toMatch(/^Checked again at \d{1,2}:\d{2}\s?[AP]M — still waiting, so nothing was finalized\.$/)
    expect(document.activeElement).toBe(host.querySelector('[data-testid="payments-clearing"]'))
    expect(count(CLEARING)).toBe(1)
    expect(dialog()).toBeNull()
  })

  it('a payment started between the confirm and the press: the 409 refetches in place and the words are said once, not twice', async () => {
    server.answers = [draft(), draft(), draft({ payments_clearing: CLEARING })]
    server.finalizeFail = { status: 409, error: CLEARING }
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Finalize'))
    await until(() => !!host.querySelector('[data-testid="payments-clearing"]'), 'the refetch')
    expect(count(CLEARING)).toBe(1)
  })

  it('Cancel backs out with nothing sent', async () => {
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel'))
    expect(dialog()).toBeNull()
    expect(server.posts.filter(p => p.endsWith('/finalize'))).toHaveLength(0)
  })

  it('a return waiting for approval: the landlord approves it as staff sent it — nothing re-saved, lines locked', async () => {
    server.answers = [draft({ status: 'awaiting_approval', refund_amount: 700,
      damage_lines: [{ description: 'Broken window', amount: 80, evidenceDocumentIds: ['doc1'] }] })]
    await open()
    expect(button(/Save draft/)).toBeUndefined()
    expect(button(/Add Damage/)).toBeUndefined()
    expect((host.querySelector('input[type="text"]') as HTMLInputElement).disabled).toBe(true)
    await click(button(/Approve & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    expect(server.patches).toHaveLength(0)
    expect(dialog()!.textContent).toContain('$700.00')
  })

  it('a 409 at finalize is said once and the page reads the return again in place', async () => {
    server.finalizeFail = { status: 409, error: 'A payment on this lease is still holding credit. Finalize once it clears.' }
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    const before = server.gets
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Finalize'))
    await until(() => text().includes('still holding credit'), 'the error')
    await until(() => server.gets > before, 'the refetch')
    expect(count('A payment on this lease is still holding credit. Finalize once it clears.')).toBe(1)
    expect(dialog()).toBeNull()
  })

  it('figures that moved since the confirm opened: the 409 is said once and the new refund shows in place', async () => {
    const changed = 'The figures changed since you opened this, so nothing was paid out. The page now shows the new ones — review them and finalize again.'
    server.answers = [draft(), draft(), draft({ refund_amount: 410, total_deductions: 90 })]
    server.finalizeFail = { status: 409, error: changed }
    await open()
    await click(button(/Review & Finalize/))
    await until(() => !!dialog(), 'the confirm')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Finalize'))
    await until(() => text().includes('The figures changed'), 'the error')
    await until(() => text().includes('$410.00'), 'the new refund')
    expect(count(changed)).toBe(1)
    expect(dialog()).toBeNull()
  })

  it('changed damage lines say the figures are from the last save', async () => {
    await open()
    expect(host.querySelector('[data-testid="unsaved-note"]')).toBeNull()
    await click(button(/Add Damage/))
    expect(host.querySelector('[data-testid="unsaved-note"]')?.textContent)
      .toContain('These figures are from the last save — Save draft to see the new refund.')
  })

  it('a finalized return shows what it paid, from the server, and how each part comes back', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', refund_amount: 465.5, prepaid_credit_left: 300,
      refund_from_gam: 265.5, refund_from_landlord: 200 })]
    await open()
    expect(text()).toContain('Finalized — Refund recorded')
    expect(text()).toContain('A refund of $465.50 to the tenant was recorded. $265.50 goes back to the tenant the way they paid it online; $200.00 is handed back to them at the office — you hand that part back.')
    expect(text()).not.toMatch(/GAM holds|GAM held|holds this deposit|hold this deposit|deposit money paid to/)
    expect(host.querySelector('[data-testid="paid-ahead-left"]')?.textContent)
      .toContain('$300.00 the tenant paid ahead is still on this lease. It was not refunded with the deposit — it waits for your choice: refund it, keep it, or leave it as their credit.')
    expect(button(/Finalize/)).toBeUndefined()
  })

  it('a finalized return still lists the never-paid lines it closed at $0', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', refund_amount: 460,
      closed_at_move_out_lines: [{ payment_id: 'p9', kind: 'deposit', label: 'Pet deposit', amount: 200 },
                             { payment_id: 'p8', kind: 'prepaid', label: 'Last month rent', amount: 1000 }],
      closed_at_move_out_total: 1200 })]
    await open()
    const closed = host.querySelector('[data-testid="finalized-closed-lines"]')?.textContent ?? ''
    expect(closed).toContain('Closed at $0 as no longer owed — the tenant never paid them:')
    expect(closed).toContain('Pet deposit · Deposit — never paid$200.00')
    expect(closed).toContain('Last month rent · Last month\'s rent due up front — never paid$1,000.00')
  })

  it('a finalized return that refunded nothing and owes nothing says exactly that — never "no money moved" when paid-ahead money was used', async () => {
    server.answers = [draft({ status: 'sent_zero', finalized_at: '2026-10-01T12:00:00Z', refund_amount: 0, gap_amount: 0,
      total_deductions: 650, prepaid_credit_used: 150, prepaid_credit_left: 150, refund_from_gam: 0, refund_from_landlord: 0 })]
    await open()
    expect(text()).toContain('The deductions used the whole deposit and the money paid ahead they needed. Nothing is refunded and the tenant owes nothing more.')
    expect(text()).not.toContain('No money moved')
  })

  it('a return waiting for approval tells the owner it is theirs to approve or send back, in their own words', async () => {
    server.answers = [draft({ status: 'awaiting_approval', refund_amount: 700, viewer_is_owner: true })]
    await open()
    expect(host.querySelector('[data-testid="awaiting-approval"]')?.textContent)
      .toBe('A team member prepared this refund. It is above your approval limit — review it and press Approve & Finalize, or Send back to draft to change it.')
    expect(text()).toContain('Waiting for your approval')
  })

  it('a return waiting for approval tells a team member the landlord releases it', async () => {
    server.answers = [draft({ status: 'awaiting_approval', refund_amount: 700, viewer_is_owner: false })]
    await open()
    expect(host.querySelector('[data-testid="awaiting-approval"]')?.textContent)
      .toContain('The landlord has been notified — their Finalize releases it.')
    expect(text()).toContain('Awaiting landlord approval')
  })

  it('a return finalized before the split was recorded says only that the refund was recorded — never who held the deposit', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-09-01T12:00:00Z', refund_amount: 465.5,
      refund_from_gam: null, refund_from_landlord: null })]
    await open()
    expect(text()).toContain('A refund of $465.50 to the tenant was recorded.')
    expect(text()).not.toMatch(/GAM holds|GAM held|holds this deposit|hold this deposit|deposit money paid to/)
  })
})

// Deposit-page review: the page reads what the server REALLY sends — the route's
// snake_case answer through the client's own camelCase conversion (the mocked
// apiGet runs camelizeKeys, as lib/api does) — so a key mismatch between the
// two suites cannot pass both.

describe('Deposit return: the server\'s own answer, through the wire conversion', () => {
  it('a draft answered as GET /deposit-return sends it (snake_case) renders its split, its closed lines, its household and its choice rule', async () => {
    const wire = {
      success: true,
      data: {
        id: 'dr1', lease_id: 'lease1', status: 'draft', finalized_at: null, notes: null,
        damage_lines: [], other_deductions: [],
        // depositReturnFigures(calc)
        total_deposit: 700, interest_accrued: 0, deposit_interest_credited: 0,
        prepaid_credit_used: 0, prepaid_credit_left: 0, cleaning_fee_amount: 40,
        final_utility_lines: [], final_utility_total: 0, damage_lines_total: 0, other_deductions_total: 0,
        unpaid_balance_lines: [], unpaid_balance_amount: 0, total_deductions: 40,
        refund_amount: 660, gap_amount: 0, refund_from_gam: 200, refund_from_landlord: 460,
        closed_at_move_out_lines: [{ payment_id: 'p9', kind: 'deposit', label: 'Key deposit', amount: 50 }],
        closed_at_move_out_total: 50,
        // approvalMeta
        approval_threshold: 500, viewer_is_owner: true, move_out_inspection_required: false, move_out_inspection: null,
        household: { tenant_names: ['Jane Doe'], unit_number: 'RV 22', property_name: 'Oak Park' },
        viewer_can_decide_paid_ahead: true,
      },
    }
    // lib/api's apiGet hands the page the camelCased `data`.
    server.answers = [wire.data]
    await open()
    expect(host.querySelector('[data-testid="refund-who"]')?.textContent)
      .toBe('$200.00 goes back to the tenant the way they paid it online; $460.00 is handed back to them at the office — you hand that part back.')
    expect(host.querySelector('[data-testid="closed-lines"]')?.textContent).toContain('Key deposit · Deposit — never paid$50.00')
    expect(host.querySelector('[data-testid="who"]')?.textContent).toBe('Move-out for Jane Doe — RV 22, Oak Park')
    expect(host.querySelector('[data-testid="money-breakdown"]')!.textContent).toContain('Refund to tenant$660.00')
  })
})

describe('Deposit return: a page that cannot load says why, with the next step', () => {
  async function openFailing() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/leases/lease1/deposit-return']}>
            <Routes>
              <Route path="/leases/:id/deposit-return" element={<DepositReturnPage />} />
              <Route path="/leases" element={<div>The leases list</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>)
    })
    await until(() => !!host.querySelector('[role="alert"]'), 'the load failure')
  }

  // Fix pass 1 (final fix): the read needs no permission, so a bare 403 means
  // this lease is not on the viewer's account — asking for access would not help.
  it('a bare 403 (this lease is not on their account): says so in plain words, the way back to Leases, and no Try again', async () => {
    server.answers = [httpError(403, 'Forbidden')]
    await openFailing()
    expect(host.querySelector('[role="alert"]')?.textContent)
      .toBe('This move-out isn\'t on your account. Go back to Leases and open it from there.')
    expect(text()).not.toContain('Forbidden')
    expect(button(/Try again/)).toBeUndefined()
    await click(button(/Back to Leases/))
    await until(() => text().includes('The leases list'), 'the leases list')
  })

  it('a property this team member is not assigned to: the server\'s own plain words', async () => {
    const words = 'You are not assigned to this property, so you can\'t work on its move-outs. Ask the landlord to add this property to your access.'
    server.answers = [httpError(403, words)]
    await openFailing()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(words)
    expect(button(/Back to Leases/)).toBeTruthy()
  })

  it('a lease no longer on the account (404): said plainly, the way back, no Try again', async () => {
    server.answers = [httpError(404, 'Lease not found')]
    await openFailing()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This lease is no longer on the account.')
    expect(button(/Try again/)).toBeUndefined()
    expect(button(/Back to Leases/)).toBeTruthy()
  })

  it('any other failure offers Try again, which reads the return again', async () => {
    server.answers = [httpError(500, 'The server could not be reached.'), draft()]
    await openFailing()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The server could not be reached.')
    await click(button(/Try again/))
    await until(() => text().includes('Deposits held'), 'the page')
  })
})

// Step 9 (final fix, fix pass 1): what was already decided is said, not asked
// again; the owner can send a return back to draft; someone who may only read
// the move-out is offered no button that would refuse; evidence is shown by
// name with a way to remove it; an error is brought into view.
describe('Deposit return: decided money, the way back out, and who may act', () => {
  it('after "Leave it as their credit": says who left it and when — and offers no choice again', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', prepaid_credit_left: 0,
      paid_ahead_choice: { refund_choice: 'no_refund', refund_total: 0, rest_choice: 'credit', rest_amount: 300, decided_at: '2026-10-04', decided_by_name: 'Jane Owner' } })]
    await open()
    expect(host.querySelector('[data-testid="paid-ahead-decided"]')?.textContent)
      .toBe('Left as their credit on Oct 4, 2026 by Jane Owner: $300.00 the tenant paid ahead stays theirs and goes toward their next lease with this landlord.')
    expect(host.querySelector('[data-testid="paid-ahead-left"]')).toBeNull()
    expect(button(/Choose what happens to it/)).toBeUndefined()
  })

  it('a choice that refunded part and kept the rest says both, by name and day', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', prepaid_credit_left: 0,
      paid_ahead_choice: { refund_choice: 'refund_other', refund_total: 100, rest_choice: 'keep', rest_amount: 200, decided_at: '2026-10-04', decided_by_name: 'Jane Owner' } })]
    await open()
    expect(host.querySelector('[data-testid="paid-ahead-decided"]')?.textContent)
      .toBe('Refund a different amount: $100.00 of the money paid ahead was refunded on Oct 4, 2026 by Jane Owner. Keep it — kept by the landlord on Oct 4, 2026 by Jane Owner: $200.00 the tenant paid ahead.')
  })

  // Fix pass 2: a choice that refunded nothing and left nothing to decide still
  // says WHAT was chosen, by its label — never "the money paid ahead was decided".
  it('“No refund” with nothing left to decide says it plainly, by its label, day and name', async () => {
    server.answers = [draft({ status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', prepaid_credit_left: 0,
      paid_ahead_choice: { refund_choice: 'no_refund', refund_total: 0, rest_choice: null, rest_amount: 0, decided_at: '2026-10-04', decided_by_name: 'Jane Owner' } })]
    await open()
    expect(host.querySelector('[data-testid="paid-ahead-decided"]')?.textContent)
      .toBe('No refund — chosen on Oct 4, 2026 by Jane Owner.')
  })

  it('waiting for the owner\'s approval: a gray Send back to draft posts once and the page reads the return again in place', async () => {
    server.answers = [draft({ status: 'awaiting_approval', refund_amount: 700 }), draft()]
    await open()
    const back = button(/Send back to draft/)
    expect(back?.className).toContain('btn-ghost')
    expect(text()).toContain('or Send back to draft to change it')
    const before = server.gets
    await click(back)
    await until(() => server.gets > before, 'the refetch')
    expect(server.posts.filter(p => p.endsWith('/deposit-return/send-back'))).toHaveLength(1)
    await until(() => !!button(/Save draft/), 'the draft, editable again')
  })

  it('a team member waiting on the landlord\'s approval gets no Send back to draft', async () => {
    server.answers = [draft({ status: 'awaiting_approval', refund_amount: 700, viewer_is_owner: false })]
    await open()
    expect(button(/Send back to draft/)).toBeUndefined()
    expect(text()).toContain('Landlord reviewing')
  })

  it('someone who may only read the move-out: told who can run it, and offered no Begin, Save, Add Damage or Finalize', async () => {
    server.answers = [draft({ viewer_can_run_move_out: false, viewer_is_owner: false })]
    await open()
    expect(host.querySelector('[data-testid="cannot-run"]')?.textContent).toContain('only someone with Deposit return access to this property')
    for (const re of [/Begin Move-Out/, /Save draft/, /Add Damage/, /Review & Finalize/, /Send to Landlord/]) expect(button(re)).toBeUndefined()
    act(() => root.unmount())
    root = createRoot(host)
    server.answers = [draft({ id: undefined, status: undefined, preview: true, viewer_can_run_move_out: false })]; server.gets = 0
    await open()
    expect(button(/Begin Move-Out/)).toBeUndefined()
  })

  it('Add Damage is the gold action; each photo or receipt shows its saved name with an × that takes it off the line', async () => {
    server.answers = [draft({
      damage_lines: [{ description: 'Carpet', amount: 50, evidenceDocumentIds: ['doc1', 'doc2'] }],
      damage_evidence: [{ id: 'doc1', name: 'Carpet photo' }, { id: 'doc2', name: 'Receipt' }],
    })]
    await open()
    expect(button(/Add Damage/)?.className).toContain('btn-primary')
    expect(text()).toContain('Carpet photo')
    expect(text()).not.toContain('Evidence 1')
    await click(host.querySelector('button[aria-label="Remove Carpet photo"]') ?? undefined)
    expect(text()).not.toContain('Carpet photo')
    expect(text()).toContain('Receipt')
    expect(host.querySelector('[data-testid="unsaved-note"]')).toBeTruthy()
  })

  it('an error is brought into view where the person is', async () => {
    const seen: string[] = []
    const proto = HTMLElement.prototype as any
    const was = proto.scrollIntoView
    proto.scrollIntoView = function (this: HTMLElement) { seen.push(this.textContent ?? '') }
    try {
      server.finalizeFail = { status: 409, error: 'A payment on this lease is still holding credit. Finalize once it clears.' }
      await open()
      await click(button(/Review & Finalize/))
      await until(() => !!dialog(), 'the confirm')
      await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Finalize'))
      await until(() => seen.some(t => t.includes('still holding credit')), 'the error scrolled into view')
    } finally { proto.scrollIntoView = was }
  })
})

// ── 10/4 (decisions #47a): a finalized refund going back ──────────────────────

const finalized = (progress: Record<string, unknown>, o: Record<string, unknown> = {}) => draft({
  status: 'sent_refund', finalized_at: '2026-10-01T12:00:00Z', refund_amount: 500, prepaid_credit_left: 0,
  refund_from_gam: 250, refund_from_landlord: 250, refund_progress: progress, ...o,
})
const part = (o: Record<string, unknown> = {}) => ({
  id: 'part1', kind: 'card', label: 'Card · security deposit Sep 3, 2026', amount: 250, status: 'refunded',
  words: '$250.00 sent back to the card they paid with (Card · security deposit Sep 3, 2026) on Oct 4, 2026.',
  can_try_again: false, can_give_in_cash: false, done: true, ...o,
})

describe('#47a: a finalized refund shows how it goes back, and each part offers its own way out', () => {
  it('both halves of a split: the card part sent, the landlord\'s part with Mark handed back — said to the owner in the staff voice (never "your card"), only how it reaches the tenant, and never as already handed back before it is marked', async () => {
    server.answers = [finalized({
      parts: [part()], open_amount: 0,
      landlord_part: { amount: 250, handed_back_on: null, handed_back_by_name: null },
      reach_words: '$250.00 back to the card they paid with; $250.00 back to them in cash at the office.',
    })]
    await open()
    expect(text()).toContain('A refund of $500.00 to the tenant: $250.00 back to the card they paid with; $250.00 back to them in cash at the office.')
    expect(text()).not.toMatch(/handed back to them at the office/)
    // Fix pass 3: the owner never reads the tenant's own voice as theirs.
    expect(text()).not.toMatch(/your card|your bank|returned to you/)
    expect(text()).not.toMatch(/GAM holds|GAM held|holds this deposit|hold this deposit/)
    const box = host.querySelector('[data-testid="refund-progress"]')!
    expect(box.textContent).toContain('$250.00 sent back to the card they paid with')
    expect(box.textContent).toContain('$250.00 is handed back to the tenant at the office — you hand it back. Mark it once it is.')
    expect(button(/Try again/)).toBeUndefined()
    expect(button(/Mark handed back/)!.className).toContain('btn-primary')
  })

  it('Mark handed back takes a day, sends the amount the page showed, and Cancel backs out with nothing sent', async () => {
    const before = finalized({ parts: [part()], open_amount: 0,
      landlord_part: { amount: 250, handed_back_on: null, handed_back_by_name: null }, reach_words: '' })
    const after = finalized({ parts: [part()], open_amount: 0,
      landlord_part: { amount: 250, handed_back_on: '2026-10-04', handed_back_by_name: 'Pat Owner' }, reach_words: '' })
    server.answers = [before]
    await open()
    await click(button(/^Mark handed back$/))
    expect(host.querySelector('[data-testid="mark-handed-back"]')).not.toBeNull()
    await click(button(/^Cancel$/))
    expect(host.querySelector('[data-testid="mark-handed-back"]')).toBeNull()
    expect(server.posts.filter((u) => u.includes('landlord-part'))).toEqual([])
    server.postAnswers['/landlord-part/handed-back'] = { words: ['Marked handed back: $250.00 on Oct 4, 2026.'] }
    server.answers = [before, after]
    await click(button(/^Mark handed back$/))
    await click(button(/Mark \$250\.00 handed back/))
    await until(() => text().includes('handed back at the office on Oct 4, 2026 — marked by Pat Owner'), 'the marked part')
    expect(server.postBodies.at(-1)).toMatchObject({ expectedAmount: 250 })
    expect(server.postBodies.at(-1).handedBackOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(count('Marked handed back: $250.00 on Oct 4, 2026.')).toBe(1)
    expect(button(/^Undo$/)).toBeDefined()
  })

  it('a part the card could not take: Try again and Give it back in cash instead; cash asks first, then says "Hand back $X in cash now." once, in gold', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true,
      words: '$250.00 to the card they paid with (Card · security deposit Sep 3, 2026): The card company turned this refund down — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.' })
    const cashDone = part({ id: 'part2', kind: 'cash', status: 'handed_back', done: true,
      words: '$250.00 given back in cash at the office on Oct 4, 2026.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    expect(text()).toContain('The card company turned this refund down')
    expect(button(/Try again/)!.className).toContain('btn-primary')
    await click(button(/Give it back in cash instead/))
    const ask = host.querySelector('[data-testid="cash-confirm"]')!
    expect(ask.textContent).toContain('Give $250.00 back to the tenant in cash at the office?')
    // #47c: never who held the money — only where it goes.
    expect(ask.textContent).toContain('$250.00 is added to your next payout. Hand the cash over once this says to.')
    expect(ask.textContent).not.toMatch(/GAM held|GAM holds|held for it/)
    await click(button(/^Cancel$/))
    expect(server.posts.filter((u) => u.includes('/refund-parts/'))).toEqual([])
    server.postAnswers['/refund-parts/part1/cash'] = { words: ['Hand back $250.00 in cash now.', 'It is recorded as given back — nothing goes to the card, and $250.00 is added to your next payout.'], hand_back: true }
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' }),
                      finalized({ parts: [cashDone], open_amount: 0, landlord_part: null, reach_words: '' })]
    await click(button(/Give it back in cash instead/))
    await click(button(/^Give it back in cash$/))
    await until(() => !!host.querySelector('[data-testid="hand-back-now"]'), 'the hand-back order')
    expect(host.querySelector('[data-testid="hand-back-now"]')!.textContent).toBe('Hand back $250.00 in cash now.')
    expect(count('Hand back $250.00 in cash now.')).toBe(1)
    expect(text()).toContain('It is recorded as given back — nothing goes to the card, and $250.00 is added to your next payout.')
    expect(text()).not.toMatch(/GAM held|GAM holds|held for it/)
    // The amount the page showed goes with the press (fresh at the moment of action).
    expect(server.postBodies.at(-1)).toEqual({ expectedAmount: 250 })
    await until(() => text().includes('given back in cash at the office'), 'the fresh part')
  })

  it('a refused press is said once, in plain words, and the page reads the move-out again in place', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true, words: '$250.00: it did not go out.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    const gets = server.gets
    server.postAnswers['/refund-parts/part1/try-again'] = httpError(409, 'This refund already went back — nothing more was sent. The page now shows it.')
    await click(button(/Try again/))
    await until(() => text().includes('This refund already went back'), 'the refusal')
    expect(count('This refund already went back')).toBe(1)
    expect(server.gets).toBeGreaterThan(gets)
  })

  it('the answer to a press is read from the envelope lib/api returns: a team member is told the server\'s words once, and a Try again that did not go out is said once (the part\'s own line says why)', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true,
      words: '$250.00 to the card they paid with (Card · security deposit Sep 3, 2026): Stripe could not send this refund just now — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' }, { viewer_is_owner: false })]
    await open()
    server.postAnswers['/refund-parts/part1/try-again'] = { words: ['Tried again — it did not go out. The refund below says why and what to do next.'] }
    await click(button(/Try again/))
    await until(() => text().includes('Tried again — it did not go out.'), 'the answer from the envelope')
    expect(count('Tried again — it did not go out.')).toBe(1)
    expect(count('Stripe could not send this refund just now')).toBe(1)
    await click(button(/Give it back in cash instead/))
    expect(host.querySelector('[data-testid="cash-confirm"]')!.textContent).toContain('is added to the landlord\'s next payout')
  })

  it('someone who may only read the move-out sees how it goes back, with no buttons, and is told once who can press them (the server\'s words name the buttons)', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true,
      words: '$250.00 to the card they paid with (Card · security deposit Sep 3, 2026): Stripe could not send this refund just now — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250,
      landlord_part: { amount: 250, handed_back_on: null, handed_back_by_name: null }, reach_words: '' }, { viewer_can_run_move_out: false })]
    await open()
    expect(text()).toContain('press Try again, or press "Give it back in cash instead"')
    expect(button(/Try again/)).toBeUndefined()
    expect(button(/Give it back in cash/)).toBeUndefined()
    expect(button(/Mark handed back/)).toBeUndefined()
    expect(count('Only someone with Deposit return access to this property can send, give back or mark these.')).toBe(1)
    // The landlord's part never tells a reader to mark it.
    expect(text()).not.toContain('Mark it once it is.')
    expect(text()).toContain('Not marked as handed back yet.')
  })

  it('a reader of a move-out with nothing left to do is not told who can press anything', async () => {
    server.answers = [finalized({ parts: [part()], open_amount: 0,
      landlord_part: { amount: 250, handed_back_on: '2026-10-04', handed_back_by_name: 'Pat Owner' }, reach_words: '' }, { viewer_can_run_move_out: false })]
    await open()
    expect(host.querySelector('[data-testid="refund-read-only"]')).toBeNull()
    expect(button(/Undo/)).toBeUndefined()
  })

  it('someone who can run the move-out is never shown the read-only note', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true, words: '$250.00: it did not go out.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    expect(host.querySelector('[data-testid="refund-read-only"]')).toBeNull()
    expect(button(/Try again/)).toBeDefined()
  })

  // ── Fix pass 3 ──────────────────────────────────────────────────────────────

  it('a deposit part that did not go out never tells the desk to hand the cash over before pressing', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true,
      words: '$250.00 to the card they paid with (Card · security deposit Sep 3, 2026): The card company turned this refund down — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    expect(text()).not.toMatch(/hand it back in cash and press/)
    expect(text()).toContain('it tells you when to hand over the cash')
  })

  it('GAM staff (owner-level, not the landlord) read "the landlord\'s next payout" and "the landlord hands it back" — never "your"', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true, words: '$250.00: it did not go out.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250,
      landlord_part: { amount: 250, handed_back_on: null, handed_back_by_name: null }, reach_words: '' },
      { viewer_is_owner: true, viewer_is_landlord: false })]
    await open()
    expect(text()).toContain('the landlord hands it back. Mark it once it is.')
    await click(button(/Give it back in cash instead/))
    expect(host.querySelector('[data-testid="cash-confirm"]')!.textContent).toContain('is added to the landlord\'s next payout')
    expect(host.querySelector('[data-testid="cash-confirm"]')!.textContent).not.toContain('your next payout')
  })

  it('no "how it reaches them" words (every part taken back by a dispute, nothing the landlord holds): the banner says the refund was recorded — never a dangling colon — and the empty card is not shown', async () => {
    server.answers = [finalized({ parts: [], open_amount: 0, landlord_part: null, reach_words: '' }, { refund_from_gam: 250, refund_from_landlord: 0, refund_amount: 250 })]
    await open()
    expect(text()).toContain('A refund of $250.00 to the tenant was recorded.')
    expect(text()).not.toMatch(/to the tenant: (?!\S)/)
    expect(host.querySelector('[data-testid="refund-progress"]')).toBeNull()
  })

  it('a refund finalized before the split was recorded: the banner falls back to "was recorded", with no dangling colon', async () => {
    server.answers = [finalized({ parts: [], open_amount: 0, landlord_part: null, reach_words: '' }, { refund_from_gam: null, refund_from_landlord: null })]
    await open()
    expect(text()).toContain('A refund of $500.00 to the tenant was recorded.')
    expect(text()).not.toContain('to the tenant: ')
    expect(host.querySelector('[data-testid="refund-progress"]')).toBeNull()
  })

  it('a part with no card or bank payment behind it: the cash confirm says nothing about a card or bank', async () => {
    const cashPart = part({ kind: 'cash', label: 'Not paid by card or bank', status: 'failed', done: false, can_try_again: false, can_give_in_cash: true,
      words: '$250.00: This part of the deposit was not paid by a card or bank payment GAM can send it back to, so nothing was sent.' })
    server.answers = [finalized({ parts: [cashPart], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    await click(button(/Give it back in cash instead/))
    const ask = host.querySelector('[data-testid="cash-confirm"]')!.textContent ?? ''
    expect(ask).toContain('Give $250.00 back to the tenant in cash at the office? It is recorded as given back, and $250.00 is added to your next payout.')
    expect(ask).not.toMatch(/nothing goes to their/)
  })

  it('a day the server refuses for Mark handed back keeps the form open with the day picked, so it can be changed in place', async () => {
    const before = finalized({ parts: [part()], open_amount: 0,
      landlord_part: { amount: 250, handed_back_on: null, handed_back_by_name: null }, reach_words: '' })
    server.answers = [before]
    await open()
    await click(button(/^Mark handed back$/))
    const input = host.querySelector('[data-testid="mark-handed-back"] input[type="date"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '2026-09-20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    server.postAnswers['/landlord-part/handed-back'] = httpError(400, 'That day is before the move-out was finalized (Oct 1, 2026) — pick the day it was handed back.')
    await click(button(/Mark \$250\.00 handed back/))
    await until(() => text().includes('That day is before the move-out was finalized'), 'the refusal')
    expect(count('That day is before the move-out was finalized')).toBe(1)
    expect(host.querySelector('[data-testid="mark-handed-back"]')).not.toBeNull()
    expect((host.querySelector('[data-testid="mark-handed-back"] input[type="date"]') as HTMLInputElement).value).toBe('2026-09-20')
    expect(server.postBodies.at(-1)).toMatchObject({ handedBackOn: '2026-09-20', expectedAmount: 250 })
  })

  it('a press whose answer was lost (network failure) never says "Nothing changed" — it says to check the refund before pressing again', async () => {
    const failed = part({ status: 'failed', done: false, can_try_again: true, can_give_in_cash: true, words: '$250.00: it did not go out.' })
    server.answers = [finalized({ parts: [failed], open_amount: 250, landlord_part: null, reach_words: '' })]
    await open()
    server.postAnswers['/refund-parts/part1/try-again'] = new Error('Network Error')
    await click(button(/Try again/))
    await until(() => text().includes('That did not go through'), 'the error')
    expect(text()).toContain('That did not go through — the page now shows the latest. Check the refund below before pressing again.')
    expect(text()).not.toContain('Nothing changed')
  })
})
