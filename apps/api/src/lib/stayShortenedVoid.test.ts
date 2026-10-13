/**
 * 10/13 (Nic): "Shortened stay 'void the cancelled nights': owner + managers
 * with booking permission" — and in the afternoon, "OWNER + PROPERTY MANAGERS
 * only (not on-site staff)." The rule on its own (the routes are covered in
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

  it('a property manager only with "Edit / move / cancel reservations"', () => {
    expect(mayVoidShortenedCharges({ role: 'property_manager', permissions: { 'schedule.edit_reservation': true } })).toBe(true)
    expect(mayVoidShortenedCharges({ role: 'property_manager', permissions: { 'guests.check_out': true, 'pos.refund': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'property_manager', permissions: {} })).toBe(false)
  })

  it('10/13 afternoon: never on-site staff, even with "Edit / move / cancel reservations" and every other box', () => {
    expect(mayVoidShortenedCharges({ role: 'onsite_manager', permissions: { 'schedule.edit_reservation': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'onsite_manager', permissions: {
      'schedule.edit_reservation': true, 'guests.check_out': true, 'pos.refund': true, 'schedule.create_reservation': true,
    } })).toBe(false)
    const onsite = { role: 'onsite_manager' as const, permissions: { 'schedule.edit_reservation': true } }
    expect(shortenedChoicesFor(onsite).choices).toEqual({ keep: 'Keep them owed' })
    expect(() => assertMayAnswerShortened(onsite, 'void')).toThrow(/Nothing was changed/)
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
      voidRefused: 'Taking those charges off is the owner\'s choice, or a property manager\'s with "Edit / move / cancel reservations". '
        + 'You can keep them owed, or ask one of them to change the stay.',
    })
    expect(shortenedChoicesFor({ role: 'landlord', permissions: {} }))
      .toEqual({ choices: { void: 'Take those charges off', keep: 'Keep them owed' }, voidRefused: null })
    expect(() => assertMayAnswerShortened(desk, 'keep')).not.toThrow()
    expect(() => assertMayAnswerShortened(desk, 'void')).toThrow(/Nothing was changed/)
  })
})
