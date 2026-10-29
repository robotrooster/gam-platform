// @vitest-environment jsdom
/**
 * 10/20 (Nic): "There should be no state law warnings anywhere in the system.
 * At least not right now. Just hide all that stuff."
 *
 * Every state-law banner the landlord portal can draw goes through this one
 * component — the property list's edit modal, the property detail page, and
 * the new-entry-request confirmation all hand it whatever the API returned.
 * The API now always returns an empty list (one switch: the system_features
 * row keyed state_law_warnings_enabled, read in
 * apps/api/src/services/stateLaw.ts), so these tests pin the two things that
 * have to be true on the page: an empty list draws NOTHING, and a missing
 * field doesn't throw — the field could also stop being sent one day and the
 * pages must survive that.
 *
 * The banner itself is deliberately left intact. Flipping the switch back on
 * has to restore the banners with no code change, so the last test proves the
 * component still draws a warning when it is given one.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LawWarningBanner, type LawFlag } from './LawWarningBanner'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(node) })
  return container
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const FLAG: LawFlag = {
  topic: 'deposit_max_months',
  message: 'Heads up — the security-deposit maximum of 2 months of rent is above the 1.5 months of rent listed in AZ law.',
  citation: 'A.R.S. § 33-1321',
  sourceUrl: 'https://example.test/statute',
  sourceDate: '2026-06-09',
  disclaimer: 'Not legal advice. May be out of date.',
}

describe('state-law banner — hidden 10/20', () => {
  it('draws nothing for the empty list the API now always sends', () => {
    const el = render(<LawWarningBanner warnings={[]} />)
    expect(el.textContent).toBe('')
    expect(el.querySelector('a')).toBeNull()
  })

  it('draws nothing, and does not throw, when the field is absent entirely', () => {
    expect(() => render(<LawWarningBanner warnings={undefined} />)).not.toThrow()
    expect(container!.textContent).toBe('')
  })

  it('draws nothing, and does not throw, when the field comes back null', () => {
    expect(() => render(<LawWarningBanner warnings={null} />)).not.toThrow()
    expect(container!.textContent).toBe('')
  })

  it('still draws a warning when given one, so the switch can bring it back', () => {
    const el = render(<LawWarningBanner warnings={[FLAG]} />)
    expect(el.textContent).toMatch(/above the 1\.5 months of rent/)
    expect(el.textContent).toMatch(/A\.R\.S\. § 33-1321/)
    expect(el.textContent).toMatch(/as of 2026-06-09/)
  })
})
