/**
 * 10/13 (Nic) — WHO MAY TAKE OFF THE RENT OF A SHORTENED STAY.
 *
 *   "Shortened stay 'void the cancelled nights': owner + managers with booking
 *    permission."
 *
 * The 10/12 question (G6, services/bookingLeaseBilling pastEndAttemptedCharges):
 * a stay shortened — by Edit or a drag of its dates (PATCH /units/:id/bookings/
 * :bookingId), or by an early check-out (routes/stayCheckOut) — past unpaid rent
 * a payment was tried on. 'void' takes those charges off (anything paid on them
 * goes back to the guest as credit); 'keep' leaves them owed.
 *
 * 'void' is the owner's, and a manager's (the property manager and on-site
 * manager roles — every staff invite from Team is one) who holds the booking
 * permission, "Edit / move / cancel reservations" (schedule.edit_reservation).
 * Anybody else who reaches the question — a desk person checking a guest out
 * early with "Check guests out" alone — is offered "Keep them owed" only, and a
 * 'void' they send is refused with nothing saved.
 */
import {
  PERMISSION_CATALOG, STAY_SHORTENED_CHARGE_CHOICE_LABEL, type StayShortenedChargeChoice,
} from '@gam/shared'
import type { AuthPayload } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

/** The booking permission (Team page: "Edit / move / cancel reservations"). */
export const SHORTENED_VOID_PERMISSION = 'schedule.edit_reservation'

/** The owner roles: the landlord, and GAM's admins acting for them (middleware/auth OWNER_ROLES). */
const OWNER_ROLES: readonly string[] = ['admin', 'super_admin', 'landlord']
/** The manager roles. */
const MANAGER_ROLES: readonly string[] = ['property_manager', 'onsite_manager']

/** The permission's name as the Team page shows it, read from the catalog. */
const BOOKING_PERMISSION_LABEL = PERMISSION_CATALOG
  .flatMap(g => g.sections.flatMap(s => s.items))
  .find(i => i.key === SHORTENED_VOID_PERMISSION)?.label ?? 'Edit / move / cancel reservations'

/** May this person take off the charges of a shortened stay? */
export function mayVoidShortenedCharges(user: Pick<AuthPayload, 'role' | 'permissions'> | null | undefined): boolean {
  if (!user) return false
  if (OWNER_ROLES.includes(user.role)) return true
  return MANAGER_ROLES.includes(user.role) && user.permissions?.[SHORTENED_VOID_PERMISSION] === true
}

/** The words for somebody who may not take them off. */
export const SHORTENED_VOID_REFUSAL =
  `Taking those charges off is the owner's choice, or a manager's with "${BOOKING_PERMISSION_LABEL}". `
  + 'You can keep them owed, or ask one of them to change the stay.'

/**
 * The choices this person is offered with the question: both for the owner and
 * a manager with the booking permission; "Keep them owed" alone for anybody
 * else. `voidRefused` carries the words saying why, when 'void' is left out.
 */
export function shortenedChoicesFor(user: Pick<AuthPayload, 'role' | 'permissions'> | null | undefined): {
  choices: Partial<Record<StayShortenedChargeChoice, string>>
  voidRefused: string | null
} {
  if (mayVoidShortenedCharges(user)) return { choices: { ...STAY_SHORTENED_CHARGE_CHOICE_LABEL }, voidRefused: null }
  return { choices: { keep: STAY_SHORTENED_CHARGE_CHOICE_LABEL.keep }, voidRefused: SHORTENED_VOID_REFUSAL }
}

/** Refuses (403) a 'void' answer from somebody who may not give it. Nothing is written before this. */
export function assertMayAnswerShortened(
  user: Pick<AuthPayload, 'role' | 'permissions'> | null | undefined, choice: StayShortenedChargeChoice,
): void {
  if (choice === 'void' && !mayVoidShortenedCharges(user)) throw new AppError(403, `${SHORTENED_VOID_REFUSAL} Nothing was changed.`)
}
