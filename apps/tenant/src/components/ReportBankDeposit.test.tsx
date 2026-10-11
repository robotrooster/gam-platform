// @vitest-environment jsdom
/**
 * S655 review — "I hadn't paid" on a report the server will no longer take
 * back. That is almost always a report matched or closed in the meantime,
 * which drops out of the open list when the list reloads. With only one
 * report open, the whole list used to disappear before the server's answer
 * could show: the tenant could not tell a report taken back from one applied
 * to their bill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const apiDelete = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(),
  apiDelete: (url: string) => apiDelete(url),
}))

import { ReportedDeposits } from './ReportBankDeposit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const pending = {
  id: 'r1', amount: 650, declaredDate: '2026-09-30', method: 'cash',
  status: 'pending', bankFeedLinked: false,
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  apiDelete.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Renders the list; "reloading" it after a withdraw shows `after`. */
async function showList(after: any[]) {
  let reports: any[] = [pending]
  const render = () => root.render(
    <ReportedDeposits reports={reports} onWithdrawn={() => { reports = after; render() }} />)
  await act(async () => { render() })
}
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent === label)
const press = async (label: string) => {
  const b = button(label)
  expect(b, `a "${label}" button`).toBeTruthy()
  await act(async () => { b!.click() })
}

describe('taking back a deposit report the server refuses', () => {
  it('the only report, already applied to the bill: says so and where it stands, instead of vanishing', async () => {
    apiDelete.mockRejectedValue(new Error('That report can no longer be withdrawn'))
    await showList([{ ...pending, status: 'confirmed', confirmedOn: '2026-10-01' }])

    await press('I hadn’t paid')
    const text = host.textContent ?? ''
    expect(text).toContain('That report can no longer be withdrawn')
    expect(text).toContain('already showed up in your landlord’s bank and was applied to your bill on Oct 1')
    expect(text).toContain('If you didn’t make this deposit, contact your landlord.')
    expect(button('I hadn’t paid')).toBeUndefined()

    // OK puts the message away; nothing is left open, so the list goes too.
    await press('OK')
    expect(host.textContent).toBe('')
  })

  it('the only report, already taken back elsewhere: says it was already taken back', async () => {
    apiDelete.mockRejectedValue(new Error('That report can no longer be withdrawn'))
    await showList([{ ...pending, status: 'withdrawn', resolutionNote: 'Withdrawn by the tenant' }])

    await press('I hadn’t paid')
    expect(host.textContent).toContain('This report was already taken back.')
  })

  it('a report still waiting (the request failed): keeps the row and the server’s sentence, once', async () => {
    apiDelete.mockRejectedValue(new Error('We could not reach GAM. Try again.'))
    await showList([pending])

    await press('I hadn’t paid')
    const text = host.textContent ?? ''
    expect(text.split('We could not reach GAM. Try again.').length - 1).toBe(1)
    expect(button('I hadn’t paid')).toBeTruthy()
  })

  it('a report taken back as asked leaves no message behind', async () => {
    apiDelete.mockResolvedValue({ success: true })
    await showList([{ ...pending, status: 'withdrawn' }])

    await press('I hadn’t paid')
    expect(host.textContent).toBe('')
  })
})
