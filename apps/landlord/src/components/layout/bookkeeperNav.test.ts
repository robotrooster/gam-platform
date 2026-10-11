// 10/11 (Nic): a bookkeeper signed into the landlord portal sees the shared
// financial pages and nothing else — "money coming in, money going out...
// the maintenance costs" — and the owner keeps every tab they had.
import { describe, it, expect } from 'vitest'
import { visibleNavItemsFor, sidebarNavItemsFor } from './Layout'

const BOOKKEEPER_PAGES = ['/income', '/reports', '/expenses', '/maintenance-costs', '/bank-activity', '/payouts']

describe('landlord portal navigation for a bookkeeper', () => {
  it('shows only the shared financial pages', () => {
    const items = visibleNavItemsFor({ role: 'bookkeeper', permissions: { access_level: 'read_only' } })
    expect(items.map(i => i.to).sort()).toEqual([...BOOKKEEPER_PAGES].sort())
  })

  it('hides tenants, leases, documents, messages, schedule, screening, team and settings', () => {
    const shown = new Set(visibleNavItemsFor({ role: 'bookkeeper' }).map(i => i.to))
    for (const path of ['/tenants', '/leases', '/documents', '/esign', '/schedule', '/background', '/pool',
      '/screening', '/team', '/settings', '/payments', '/balances', '/rent-roll', '/maintenance', '/pos',
      '/dashboard', '/properties', '/units', '/disbursements', '/bank', '/banking', '/front-desk']) {
      expect(shown.has(path), `${path} should be hidden from a bookkeeper`).toBe(false)
    }
  })

  it('folds into one Financials entry in the sidebar', () => {
    const side = sidebarNavItemsFor({ role: 'bookkeeper' })
    expect(side).toHaveLength(1)
    expect(side[0].label).toBe('Financials')
  })

  it('a bookkeeper kept to some properties is not offered the company-wide Bank Activity and Payouts', () => {
    const items = visibleNavItemsFor({ role: 'bookkeeper', allProperties: false })
    expect(items.map(i => i.to).sort()).toEqual(['/income', '/reports', '/expenses', '/maintenance-costs'].sort())
    const whole = visibleNavItemsFor({ role: 'bookkeeper', allProperties: true })
    expect(whole.map(i => i.to).sort()).toEqual([...BOOKKEEPER_PAGES].sort())
  })

  it('a staff permission map never widens it', () => {
    const items = visibleNavItemsFor({ role: 'bookkeeper', permissions: { 'tenants.view': true, 'leases.view': true } as any })
    expect(items.map(i => i.to).sort()).toEqual([...BOOKKEEPER_PAGES].sort())
  })
})

describe('landlord portal navigation for the owner', () => {
  it('keeps the owner-only financial tabs and gains Money In and Maintenance Costs', () => {
    const shown = new Set(visibleNavItemsFor({ role: 'landlord' }).map(i => i.to))
    for (const path of ['/payments', '/balances', '/rent-roll', '/disbursements', '/reports', '/expenses',
      '/income', '/maintenance-costs', '/bank', '/banking']) {
      expect(shown.has(path), `${path} should show for the owner`).toBe(true)
    }
  })

  it("does not repeat Bank and Disbursements as the bookkeeper's read-only copies", () => {
    const shown = new Set(visibleNavItemsFor({ role: 'landlord' }).map(i => i.to))
    expect(shown.has('/bank-activity')).toBe(false)
    expect(shown.has('/payouts')).toBe(false)
  })

  it('staff never see the new financial pages', () => {
    const shown = new Set(visibleNavItemsFor({ role: 'onsite_manager', permissions: { 'payments.view_all': true } as any }).map(i => i.to))
    for (const path of ['/income', '/maintenance-costs', '/bank-activity', '/payouts', '/expenses']) {
      expect(shown.has(path)).toBe(false)
    }
  })
})
