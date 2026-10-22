/**
 * 10/21 (Nic) — THE TWO RULES THAT MAKE A SAVED ORDER SAFE.
 *
 * A dragged order is stored as a plain list of keys, which is only safe
 * because of what applyOrder does with it:
 *
 *   It never DECIDES anything — it starts from the list the screen was already
 *   going to draw and reorders that. A key for a page this person cannot open
 *   matches nothing, so nobody can drag themselves a page they do not have.
 *
 *   It never goes stale — anything the order does not mention keeps its place
 *   at the end, so a page added next month appears instead of vanishing, and a
 *   page retired last month is simply not found.
 */
import { describe, it, expect } from 'vitest'
import { applyOrder, moved } from './useUiLayout'

const nav = (...tos: string[]) => tos.map(to => ({ to }))
const tos = (items: { to: string }[]) => items.map(i => i.to)

describe('applying somebody\'s saved order', () => {
  it('with nothing saved, the screen is left exactly as it was', () => {
    const items = nav('/dashboard', '/schedule', '/tenants')
    expect(applyOrder(items, [], i => i.to)).toBe(items)
  })

  it('puts the ones they arranged first, in their order', () => {
    const items = nav('/dashboard', '/schedule', '/tenants')
    expect(tos(applyOrder(items, ['/tenants', '/dashboard', '/schedule'], i => i.to)))
      .toEqual(['/tenants', '/dashboard', '/schedule'])
  })

  it('CANNOT add a page they do not have — a saved key for one matches nothing', () => {
    // They arranged this screen back when they were an owner; they are staff
    // now and the screen hands over three pages. The order must not conjure
    // the fourth.
    const items = nav('/dashboard', '/schedule', '/tenants')
    const out = applyOrder(items, ['/bank-activity', '/tenants', '/dashboard'], i => i.to)
    expect(tos(out)).toEqual(['/tenants', '/dashboard', '/schedule'])
    expect(tos(out)).not.toContain('/bank-activity')
    expect(out).toHaveLength(items.length)
  })

  it('a page added since they arranged it shows up, at the end', () => {
    const items = nav('/dashboard', '/schedule', '/tenants', '/brand-new')
    expect(tos(applyOrder(items, ['/tenants', '/dashboard'], i => i.to)))
      .toEqual(['/tenants', '/dashboard', '/schedule', '/brand-new'])
  })

  it('loses nothing and duplicates nothing, whatever the order says', () => {
    const items = nav('/a', '/b', '/c', '/d')
    const out = applyOrder(items, ['/d', '/zzz', '/b'], i => i.to)
    expect(out).toHaveLength(4)
    expect(new Set(tos(out)).size).toBe(4)
    expect(tos(out)).toEqual(['/d', '/b', '/a', '/c'])
  })
})

describe('the drag itself', () => {
  it('moves one item down and one item up', () => {
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moved(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('a drop that goes nowhere changes nothing', () => {
    const items = ['a', 'b', 'c']
    expect(moved(items, 1, 1)).toBe(items)
    expect(moved(items, -1, 1)).toBe(items)
    expect(moved(items, 0, 9)).toBe(items)
  })
})
