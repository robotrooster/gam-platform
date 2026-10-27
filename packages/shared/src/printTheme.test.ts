/**
 * 10/26 (Nic): printing in dark mode produced a solid black sheet with white
 * text and "wasted so much ink on a brand new cartridge." These pin the two
 * things that matter: a print is always light, and the viewer's own theme is
 * exactly what it was afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installPrintLightTheme, printLightThemeActive } from './printTheme'

let teardown: (() => void) | null = null

/** A document.documentElement and window with just enough to listen. */
function fakeBrowser(initialTheme: string | null) {
  const attrs = new Map<string, string>()
  if (initialTheme !== null) attrs.set('data-theme', initialTheme)
  const listeners = new Map<string, Array<(e: any) => void>>()
  const g = globalThis as any
  g.document = {
    documentElement: {
      getAttribute: (k: string) => attrs.has(k) ? attrs.get(k)! : null,
      setAttribute: (k: string, v: string) => { attrs.set(k, v) },
      removeAttribute: (k: string) => { attrs.delete(k) },
    },
  }
  g.window = {
    addEventListener: (t: string, fn: (e: any) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn])
    },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      listeners.set(t, (listeners.get(t) ?? []).filter(f => f !== fn))
    },
    matchMedia: undefined,
  }
  return {
    theme: () => attrs.has('data-theme') ? attrs.get('data-theme')! : null,
    fire: (t: string) => { for (const fn of listeners.get(t) ?? []) fn({}) },
    listenerCount: (t: string) => (listeners.get(t) ?? []).length,
  }
}

beforeEach(() => {
  delete (globalThis as any).window
  delete (globalThis as any).document
})
afterEach(() => {
  if (teardown) { teardown(); teardown = null }
  delete (globalThis as any).window
  delete (globalThis as any).document
})

describe('printing is always the light theme', () => {
  it('flips a dark screen to light for the print and puts dark back after', () => {
    const b = fakeBrowser('dark')
    teardown = installPrintLightTheme()
    expect(b.theme()).toBe('dark')
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
    expect(printLightThemeActive()).toBe(true)
    b.fire('afterprint')
    expect(b.theme()).toBe('dark')
    expect(printLightThemeActive()).toBe(false)
  })

  it('restores NO attribute where there was none, rather than pinning light', () => {
    // The default (no data-theme) is the dark palette. Writing "dark" back
    // would look identical and then override a later theme change.
    const b = fakeBrowser(null)
    teardown = installPrintLightTheme()
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
    b.fire('afterprint')
    expect(b.theme()).toBeNull()
  })

  it('leaves a viewer already on light exactly where they were', () => {
    const b = fakeBrowser('light')
    teardown = installPrintLightTheme()
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
    b.fire('afterprint')
    expect(b.theme()).toBe('light')
  })

  it('a second beforeprint does not overwrite what to restore to', () => {
    // Both beforeprint and the matchMedia fallback can fire for one print. If
    // the second call re-read the attribute it would capture "light" and the
    // viewer would be left on light for good.
    const b = fakeBrowser('dark')
    teardown = installPrintLightTheme()
    b.fire('beforeprint')
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
    b.fire('afterprint')
    expect(b.theme()).toBe('dark')
  })

  it('an afterprint with no print in progress changes nothing', () => {
    const b = fakeBrowser('dark')
    teardown = installPrintLightTheme()
    b.fire('afterprint')
    expect(b.theme()).toBe('dark')
  })

  it('installs once however many times it is called', () => {
    const b = fakeBrowser('dark')
    teardown = installPrintLightTheme()
    const second = installPrintLightTheme()
    expect(b.listenerCount('beforeprint')).toBe(1)
    second()
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
  })

  it('does nothing and throws nothing where there is no DOM', () => {
    expect(() => { installPrintLightTheme()() }).not.toThrow()
  })

  it('tearing down mid-print puts the theme back', () => {
    const b = fakeBrowser('dark')
    const stop = installPrintLightTheme()
    b.fire('beforeprint')
    expect(b.theme()).toBe('light')
    stop()
    expect(b.theme()).toBe('dark')
  })
})
