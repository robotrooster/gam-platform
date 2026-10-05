// @vitest-environment jsdom
/**
 * decisions.md #48.2: a staffer who takes payments makes the bank deposit on the
 * Front Desk page — so take_payment alone must put Front Desk in their sidebar
 * and land them there (RoleRedirect in main.tsx sends staff to the first item of
 * visibleNavItemsFor). The API camelizes the dotless key to takePayment, so the
 * wire spelling must count as well as the catalog one.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../NotificationBell', () => ({ NotificationBell: () => null }))
vi.mock('../ChatWidget', () => ({ ChatWidget: () => null }))
vi.mock('../dialogs', () => ({ DialogHost: () => null }))
vi.mock('../../lib/api', () => ({ apiGet: async () => [] }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: null }) }))

import { visibleNavItemsFor, sidebarNavItemsFor } from './Layout'

const staff = (permissions: Record<string, boolean>) => ({ role: 'onsite_manager', permissions })
const paths = (u: Parameters<typeof visibleNavItemsFor>[0]) => visibleNavItemsFor(u).map(i => i.to)

describe('Front Desk in the sidebar', () => {
  it('a staffer who only takes payments sees Front Desk in the sidebar and lands on it (wire spelling)', () => {
    const u = staff({ takePayment: true })
    expect(sidebarNavItemsFor(u).map(i => i.to)).toContain('/front-desk')
    expect(visibleNavItemsFor(u)[0]?.to).toBe('/front-desk')
  })

  it('a staffer who only takes payments sees Front Desk and lands on it (catalog spelling)', () => {
    const u = staff({ take_payment: true })
    expect(paths(u)).toContain('/front-desk')
    expect(visibleNavItemsFor(u)[0]?.to).toBe('/front-desk')
  })

  it('a staffer with the front-desk to-do list still sees Front Desk', () => {
    expect(paths(staff({ 'front_desk.view': true }))).toContain('/front-desk')
    expect(paths(staff({ 'front_desk.mark_leaving': true }))).toContain('/front-desk')
  })

  it('a staffer who neither takes payments nor holds a front-desk key never sees Front Desk', () => {
    expect(paths(staff({ 'payments.view': true }))).not.toContain('/front-desk')
    expect(paths(staff({}))).toEqual([])
  })

  it('a take_payment set to false does not show Front Desk', () => {
    expect(paths(staff({ take_payment: false, takePayment: false }))).not.toContain('/front-desk')
  })
})
