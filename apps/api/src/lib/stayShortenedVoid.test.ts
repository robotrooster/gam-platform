/**
 * 10/13 (Nic), evening: "anyone who can schedule reservations and take payments
 * can cancel. refund is separate permission." (replacing the afternoon's "OWNER
 * + PROPERTY MANAGERS only (not on-site staff)"). The rule on its own (the
 * routes are covered in routes/stayShortenedChoice.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { mayVoidShortenedCharges, shortenedChoicesFor, assertMayAnswerShortened } from './stayShortenedVoid'

const REFUSED = 'Taking those charges off needs "Create reservations" or "Edit / move / cancel reservations", '
  + 'together with "Record a cash / check payment". You can keep them owed, or ask someone who has both to change the stay.'

describe('who may take the charges of a shortened stay off', () => {
  it('the owner (and GAM admins acting for them) always', () => {
    for (const role of ['landlord', 'admin', 'super_admin'] as const) {
      expect(mayVoidShortenedCharges({ role, permissions: {} }), role).toBe(true)
    }
  })

  it('anybody who can schedule reservations AND take payments — on-site staff included', () => {
    for (const role of ['property_manager', 'onsite_manager'] as const) {
      expect(mayVoidShortenedCharges({ role, permissions: { 'schedule.edit_reservation': true, take_payment: true } }), role).toBe(true)
      expect(mayVoidShortenedCharges({ role, permissions: { 'schedule.create_reservation': true, take_payment: true } }), role).toBe(true)
    }
    const onsite = { role: 'onsite_manager' as const, permissions: { 'schedule.create_reservation': true, take_payment: true } }
    expect(shortenedChoicesFor(onsite)).toEqual({ choices: { void: 'Take those charges off', keep: 'Keep them owed' }, voidRefused: null })
    expect(() => assertMayAnswerShortened(onsite, 'void')).not.toThrow()
  })

  it('one without the other is not enough', () => {
    for (const role of ['property_manager', 'onsite_manager'] as const) {
      expect(mayVoidShortenedCharges({ role, permissions: { 'schedule.edit_reservation': true } }), role).toBe(false)
      expect(mayVoidShortenedCharges({ role, permissions: { 'schedule.create_reservation': true, 'schedule.edit_reservation': true } }), role).toBe(false)
      expect(mayVoidShortenedCharges({ role, permissions: { take_payment: true, 'guests.check_out': true } }), role).toBe(false)
      expect(mayVoidShortenedCharges({ role, permissions: {} }), role).toBe(false)
    }
  })

  it('refunds are a separate permission: "Issue refunds" neither gives it nor is needed for it', () => {
    expect(mayVoidShortenedCharges({ role: 'onsite_manager', permissions: { 'pos.refund': true, 'guests.check_out': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'onsite_manager', permissions: { 'pos.refund': true, 'schedule.edit_reservation': true } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'onsite_manager', permissions: { 'schedule.edit_reservation': true, take_payment: true, 'pos.refund': false } })).toBe(true)
  })

  it('nobody without the boxes, whatever their role', () => {
    expect(mayVoidShortenedCharges({ role: 'bookkeeper', permissions: { access_level: 'read_write' } })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'tenant', permissions: {} })).toBe(false)
    expect(mayVoidShortenedCharges({ role: 'maintenance', permissions: null })).toBe(false)
    expect(mayVoidShortenedCharges(null)).toBe(false)
  })

  it('offers "Keep them owed" alone, with the reason, to anybody else; refuses only their "void"', () => {
    const desk = { role: 'onsite_manager' as const, permissions: { 'guests.check_out': true } }
    expect(shortenedChoicesFor(desk)).toEqual({ choices: { keep: 'Keep them owed' }, voidRefused: REFUSED })
    expect(shortenedChoicesFor({ role: 'landlord', permissions: {} }))
      .toEqual({ choices: { void: 'Take those charges off', keep: 'Keep them owed' }, voidRefused: null })
    expect(() => assertMayAnswerShortened(desk, 'keep')).not.toThrow()
    expect(() => assertMayAnswerShortened(desk, 'void')).toThrow(/Nothing was changed/)
  })
})
