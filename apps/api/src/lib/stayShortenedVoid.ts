/**
 * 10/13 (Nic) — WHO MAY TAKE OFF THE RENT OF A SHORTENED STAY.
 *
 *   10/13 evening: "anyone who can schedule reservations and take payments can
 *   cancel. refund is separate permission."
 *
 * (It replaces the afternoon's "OWNER + PROPERTY MANAGERS only (not on-site
 * staff)" — the role no longer decides; the boxes do.)
 *
 * The 10/12 question (G6, services/bookingLeaseBilling pastEndAttemptedCharges):
 * a stay shortened — by Edit or a drag of its dates (PATCH /units/:id/bookings/
 * :bookingId), or by an early check-out (routes/stayCheckOut) — past unpaid rent
 * a payment was tried on. 'void' takes those charges off (anything paid on them
 * goes back to the guest as credit); 'keep' leaves them owed.
 *
 * 'void' is the owner's always, and anybody's who holds BOTH a reservation
 * permission — "Create reservations" (schedule.create_reservation) or "Edit /
 * move / cancel reservations" (schedule.edit_reservation) — AND a way to take
 * payments, whatever their role (an on-site manager with both may). 10/14
 * (Nic, answer 14): "Take payments" is either kind — "Record a cash / check
 * payment" (take_payment) OR "Ring sales" (pos.ring_sale: the register, the
 * card reader, pay links). Giving money back stays its own permission: taking the charges off
 * only moves what was paid on them to the guest's credit; handing any of it
 * back is a refund, which still needs "Issue refunds" (pos.refund) wherever a
 * refund is made (the Check out window's refund choices among them). Anybody
 * else who reaches the question is offered "Keep them owed" only, and a 'void'
 * they send is refused with nothing saved.
 *
 * (10/13 review) Reaching the question takes a way to shorten the stay: an edit
 * of its dates ("Edit / move / cancel reservations") or an early check-out
 * ("Check guests out", or "Issue refunds"). "Create reservations" alone never
 * shortens one, so the Team page's hints name the check-out it also takes.
 */
import {
  PERMISSION_CATALOG, STAY_SHORTENED_CHARGE_CHOICE_LABEL, type StayShortenedChargeChoice,
} from '@gam/shared'
import type { AuthPayload } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

/** The reservation permissions — either one (Team page: "Create reservations", "Edit / move / cancel reservations"). */
export const SHORTENED_VOID_SCHEDULE_PERMISSIONS = ['schedule.create_reservation', 'schedule.edit_reservation'] as const
/**
 * The payment permissions — either one. 10/14 (Nic): "either kind counts" —
 * "Record a cash / check payment" (take_payment) or "Ring sales"
 * (pos.ring_sale: the register, the card reader, pay links).
 */
export const SHORTENED_VOID_PAYMENT_PERMISSIONS = ['take_payment', 'pos.ring_sale'] as const

/** The owner roles: the landlord, and GAM's admins acting for them (middleware/auth OWNER_ROLES). */
const OWNER_ROLES: readonly string[] = ['admin', 'super_admin', 'landlord']

/** A permission's name as the Team page shows it, read from the catalog. */
const permissionLabel = (key: string, fallback: string): string => PERMISSION_CATALOG
  .flatMap(g => g.sections.flatMap(s => s.items))
  .find(i => i.key === key)?.label ?? fallback

const CREATE_LABEL = permissionLabel('schedule.create_reservation', 'Create reservations')
const EDIT_LABEL = permissionLabel('schedule.edit_reservation', 'Edit / move / cancel reservations')
const RECORD_LABEL = permissionLabel('take_payment', 'Record a cash / check payment')
const RING_LABEL = permissionLabel('pos.ring_sale', 'Ring sales')

type Who = Pick<AuthPayload, 'role' | 'permissions'> | null | undefined

/** May this person take off the charges of a shortened stay? */
export function mayVoidShortenedCharges(user: Who): boolean {
  if (!user) return false
  if (OWNER_ROLES.includes(user.role)) return true
  const holds = (key: string) => user.permissions?.[key] === true
  return SHORTENED_VOID_SCHEDULE_PERMISSIONS.some(holds) && SHORTENED_VOID_PAYMENT_PERMISSIONS.some(holds)
}

/** The words for somebody who may not take them off. */
export const SHORTENED_VOID_REFUSAL =
  `Taking those charges off needs "${CREATE_LABEL}" or "${EDIT_LABEL}", together with "${RECORD_LABEL}" or "${RING_LABEL}". `
  + 'You can keep them owed, or ask someone who has both to change the stay.'

/**
 * The choices this person is offered with the question: both for anybody who
 * may take the charges off (mayVoidShortenedCharges); "Keep them owed" alone
 * for anybody else. `voidRefused` carries the words saying why, when 'void' is
 * left out.
 */
export function shortenedChoicesFor(user: Who): {
  choices: Partial<Record<StayShortenedChargeChoice, string>>
  voidRefused: string | null
} {
  if (mayVoidShortenedCharges(user)) return { choices: { ...STAY_SHORTENED_CHARGE_CHOICE_LABEL }, voidRefused: null }
  return { choices: { keep: STAY_SHORTENED_CHARGE_CHOICE_LABEL.keep }, voidRefused: SHORTENED_VOID_REFUSAL }
}

/** Refuses (403) a 'void' answer from somebody who may not give it. Nothing is written before this. */
export function assertMayAnswerShortened(user: Who, choice: StayShortenedChargeChoice): void {
  if (choice === 'void' && !mayVoidShortenedCharges(user)) throw new AppError(403, `${SHORTENED_VOID_REFUSAL} Nothing was changed.`)
}
