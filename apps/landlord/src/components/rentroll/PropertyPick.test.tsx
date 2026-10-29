/**
 * 10/13 (Nic) — one property at a time, picked first ("Always pick first …
 * EXCEPT a company with only one property"); a name opens that row's
 * household — its lease ("2 spots with 2 leases it is 2 households"). A month
 * with no bill is a quiet dash, never a pill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chosenProperty, householdName, householdNames, reportPath } from './PropertyPick'
import { StatusStamp, monthStampTitle, ONBOARDING_STAMP_WORDS } from './StatusStamp'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const MV = { propertyId: 'mv', name: 'Mountain View RV Ranch', spaces: 52, owned: true }
const OP = { propertyId: 'op', name: 'Oak Park', spaces: 29, owned: true }

describe('which property the page shows', () => {
  it('the one the address names when it is the viewer’s; the only one; otherwise it asks', () => {
    expect(chosenProperty('op', [MV, OP])).toBe('op')
    expect(chosenProperty(null, [MV, OP])).toBeNull()
    expect(chosenProperty('elsewhere', [MV, OP])).toBeNull()
    expect(chosenProperty(null, [MV])).toBe('mv')
    expect(chosenProperty('elsewhere', [MV])).toBe('mv')
    // While the list loads, the address is trusted (the server answers 404 for anyone else's).
    expect(chosenProperty('op', undefined)).toBe('op')
    expect(chosenProperty(null, undefined)).toBeNull()
    expect(chosenProperty(null, [])).toBeNull()
  })
})

describe('a household on a row', () => {
  it('is named by its primary resident; everyone on hover; nobody named says so', () => {
    const rs = [{ tenantId: 'g2', name: 'Gina Logue', primary: false }, { tenantId: 'g1', name: 'Gerald Logue', primary: true }]
    expect(householdName(rs)).toBe('Gerald Logue')
    expect(householdNames(rs)).toBe('Gina Logue, Gerald Logue')
    expect(householdName([])).toBe('No resident named')
  })
  it('opens its report for its lease; a charge on no lease opens the person’s', () => {
    expect(reportPath({ householdId: 'g1', leaseId: 'l48' })).toBe('/tenants/g1/report?leaseId=l48')
    expect(reportPath({ householdId: 'g1', leaseId: null })).toBe('/tenants/g1/report')
    expect(reportPath({ householdId: null, leaseId: 'l48' })).toBeNull()
  })
})

describe('the stamp', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('says the month in words in its color; no bill is a dash that says so on hover', () => {
    act(() => root.render(<>
      <StatusStamp status="paid_late" label="Paid late +5" color="orange" title="October 2026: Paid late +5" />
      <StatusStamp status="none" label="No bill" color="gray" />
      <StatusStamp status="paid" label="Paid" color="green" onboarding />
    </>))
    const [late, none, paid] = [...host.querySelectorAll('.rrs')]
    expect(late.textContent).toBe('Paid late +5')
    expect(late.className).toBe('rrs orange')
    expect(late.getAttribute('title')).toBe('October 2026: Paid late +5')
    expect(none.textContent).toBe('—')
    expect(none.getAttribute('title')).toBe('No bill')
    expect(paid.className).toBe('rrs green onboarding')
  })

  it('on hover: the month, its words and its money', () => {
    expect(monthStampTitle({ month: '2026-10', statusLabel: 'Owes +7', invoiced: 577.47, paid: 200, credit: 50, workTrade: 0, owed: 377.47 }))
      .toBe('October 2026: Owes +7 · invoiced $577.47 · paid $200.00 · incl. $50.00 account credit · owed $377.47')
    expect(monthStampTitle({ month: '2026-09', statusLabel: 'Paid', invoiced: 495, paid: 0, workTrade: 495, owed: 0, onboarding: true }))
      .toBe('September 2026: Paid · invoiced $495.00 · paid $0.00 · work trade $495.00 · first month on GAM')
    expect(monthStampTitle({ month: '2026-08', statusLabel: 'No bill', invoiced: 0, paid: 0, workTrade: 0, owed: 0 })).toBe('August 2026: No bill')
  })

  // 10/13 (Nic): the gold underline on the onboarding month — "KEEP it, and
  // give it a label": hover or tap says "First month on GAM".
  it('the onboarding month keeps its gold underline and says "First month on GAM" on hover and on a tap', async () => {
    const title = monthStampTitle({ month: '2026-09', statusLabel: 'Paid late +4', invoiced: 495, paid: 495, workTrade: 0, owed: 0, onboarding: true })
    act(() => root.render(<StatusStamp status="paid_late" label="Paid late +4" color="orange" title={title} onboarding />))
    expect(ONBOARDING_STAMP_WORDS).toBe('First month on GAM')
    const stamp = host.querySelector('.rrs') as HTMLButtonElement
    expect(stamp.tagName).toBe('BUTTON')
    expect(stamp.className).toBe('rrs orange onboarding')
    expect(stamp.textContent).toBe('Paid late +4')
    // Said to a screen reader too; never the browser's own hover box beside the label.
    expect(stamp.getAttribute('aria-label')).toBe('September 2026: Paid late +4 · invoiced $495.00 · paid $495.00 · first month on GAM')
    expect(stamp.getAttribute('title')).toBeNull()
    const tip = () => host.querySelector('[role="tooltip"]')
    expect(tip()).toBeNull()
    // A mouse on it.
    const pointer = (type: string, pointerType: string) => {
      const ev = new MouseEvent(type, { bubbles: true, relatedTarget: type === 'pointerover' ? document.body : null })
      Object.defineProperty(ev, 'pointerType', { value: pointerType })
      return ev
    }
    act(() => { stamp.dispatchEvent(pointer('pointerover', 'mouse')) })
    expect(tip()!.querySelector('strong')!.textContent).toBe('First month on GAM')
    expect(tip()!.textContent).toBe('First month on GAMSeptember 2026: Paid late +4 · invoiced $495.00 · paid $495.00')
    expect(stamp.getAttribute('aria-describedby')).toBe(tip()!.id)
    act(() => { stamp.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
    expect(tip()).toBeNull()
    // A finger: a tap says it, a tap again (or Escape) closes it.
    act(() => { stamp.dispatchEvent(pointer('pointerover', 'touch')) })
    expect(tip()).toBeNull()
    await act(async () => { stamp.click() })
    expect(tip()!.querySelector('strong')!.textContent).toBe('First month on GAM')
    expect(stamp.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { stamp.click() })
    expect(tip()).toBeNull()
    await act(async () => { stamp.click() })
    act(() => { stamp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(tip()).toBeNull()
  })

  it('a stamp that is not the onboarding month stays a plain pill with its words on hover', () => {
    act(() => root.render(<StatusStamp status="paid" label="Paid" color="green" title="October 2026: Paid" />))
    const stamp = host.querySelector('.rrs')!
    expect(stamp.tagName).toBe('SPAN')
    expect(stamp.getAttribute('title')).toBe('October 2026: Paid')
    expect(host.querySelector('button')).toBeNull()
  })
})
