/**
 * 10/24 (Nic) — THE NEW RESERVATION WINDOW DOES NOT CLOSE BY ACCIDENT.
 *
 *   "I want to make it where I can't click off of that window unless I click
 *    confirm or abandon the reservation. Clicking anywhere else on the screen
 *    on GAM's website should not close out of that pop-up window. That way I
 *    can't accidentally undo a middle of a reservation with an accidental
 *    button push."
 *
 * A structural guard rather than a mounted one: the window is written inline in
 * SchedulePage and rendering it would need the whole page and its data, while
 * the thing being protected is one attribute. The rule it holds is simple — the
 * reservation overlay carries no click handler, so the backdrop cannot dismiss
 * it — and the failure it prevents is a landlord losing a half-typed guest to a
 * stray click, which no type checker would ever catch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const page = readFileSync(join(__dirname, 'SchedulePage.tsx'), 'utf8')

/** The New Reservation window, from its overlay to its header title. */
const reservationOverlay = (): string => {
  const title = page.indexOf('New Reservation — ')
  expect(title, 'the New Reservation window is still in this page').toBeGreaterThan(-1)
  const overlay = page.lastIndexOf('className="modal-overlay"', title)
  expect(overlay, 'the New Reservation window still has an overlay').toBeGreaterThan(-1)
  return page.slice(overlay, title)
}

describe('the New Reservation window is locked open', () => {
  it('its overlay has no click handler, so clicking outside cannot dismiss it', () => {
    const open = reservationOverlay()
    // The overlay tag itself: up to the first '>' after className.
    const tag = open.slice(0, open.indexOf('>') + 1)
    expect(tag).not.toMatch(/onClick/)
  })

  it('the only ways out are Create and an abandon that asks first', () => {
    // The ✕ goes through the asking path, never straight to the wipe.
    expect(page).toMatch(/onClick=\{askCloseBookModal\}/)
    expect(page).toMatch(/const askCloseBookModal = \(\) =>/)
    // And it only asks when there is something to lose — a blank form closes
    // on one click, so the prompt never becomes something to click through.
    expect(page).toMatch(/const bookingFormDirty = \(\)/)
    expect(page).toMatch(/if \(bookingFormDirty\(\)\) setAbandonAsk\(true\); else closeBookModal\(\)/)
  })

  it('the abandon prompt says nothing was saved and the site is not held', () => {
    expect(page).toMatch(/Abandon this reservation\?/)
    expect(page).toMatch(/nothing is held/)
    expect(page).toMatch(/Keep editing/)
  })
})
