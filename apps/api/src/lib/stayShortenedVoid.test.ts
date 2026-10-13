/**
 * 10/13 (Nic): "Shortened stay 'void the cancelled nights': owner + managers
 * with booking permission." The rule on its own (the routes are covered in
 * routes/stayShortenedChoice.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { mayVoidShortenedCharges, shortenedChoicesFor, assertMayAnswerShortened } from './stayShortenedVoid'

describe('who may take the charges of a shortened stay off', () => {
  it('the owner (and GAM admins acting for them) always', () => {
    for (const role of ['landlord', 'admin', 'super_admin'] as const) {
      expect(mayVoidShortenedCharges({ role, permissions: {} }), role).toBe(true)
    }
  })

  it('a manager only with "Edit / move / cancel reservations"', () => {
    for (const role of ['onsite_manager', 'property_manager'] as const) {
      expect(mayVoidShortenedCharges({ role, permissions: { 'schedule.edit_reservation': true } }), role).toBe(true)
      expect(mayVoidShortenedCharges({ role, permissions: { 'guests.check_out': true, 'pos.refund': true } }), role).toBe(false)
    }
  })

  it('nobody who is not a manager, whatever boxes they hold', () => {
    expect(mayVoidShortenedCharges({ role: 'maintenance', permissions: { 'schedule.edit_reservation': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'bookkeeper', permissions: { 'schedule.edit_reservation': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'tenant', permissions: {} })).toBe(false)
    expect(mayVoidShortenedCharges(null)).toBe(false)
  })

  it('offers "Keep them owed" alone, with the reason, to anybody else; refuses only their "void"', () => {
    const desk = { role: 'onsite_manager' as const, permissions: { 'guests.check_out': true } }
    expect(shortenedChoicesFor(desk)).toEqual({
      choices: { keep: 'Keep them owed' },
      voidRefused: 'Taking those charges off is the owner\'s choice, or a manager\'s with "Edit / move / cancel reservations". '
        + 'You can keep them owed, or ask one of them to change the stay.',
    })
    expect(shortenedChoicesFor({ role: 'landlord', permissions: {} }))
      .toEqual({ choices: { void: 'Take those charges off', keep: 'Keep them owed' }, voidRefused: null })
    expect(() => assertMayAnswerShortened(desk, 'keep')).not.toThrow()
    expect(() => assertMayAnswerShortened(desk, 'void')).toThrow(/Nothing was changed/)
  })
})
