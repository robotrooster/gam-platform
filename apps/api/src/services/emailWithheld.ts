/**
 * 10/20 (review) — AN EMAIL ANOTHER EMAIL IN THE SAME ACTION IS ALREADY
 * CARRYING.
 *
 * Pressing send on a guest's confirmation has to make the deposit card page
 * first, and the one maker GAM has for those emails the guest the moment it
 * makes one (routes/posPayLinks createBookingDepositLink — the schedule's "Ask
 * for the deposit" button is its other caller, and for that one the email IS
 * the point). So a confirmation put TWO emails in front of the guest, and the
 * bare one arrived first:
 *
 *     Mountain View RV Park — Reservation deposit: $28.39
 *
 * A payment demand with no dates on it, from a company most of the board has
 * never heard of, because Nic took their reservation by text in March:
 * "they may have already gotten a confirmation on a space number." And if the
 * confirmation behind it then failed — Resend down, the address on the
 * provider's suppression list — that payment demand was the ONLY thing the
 * guest ever got.
 *
 * Nic's rule is one email per thing. So the pay link's own email is WITHHELD
 * while the confirmation is being built, and the confirmation carries the card
 * page itself: the dates, the price, the deposit, the card fee and the choice,
 * in one message. One email, or none.
 *
 * ── THIS IS NOT A MUTE SWITCH, AND MUST NEVER BECOME ONE ──────────────────
 *
 * A withheld message is one that a DIFFERENT message, going out in the same
 * action, says the same thing in. Withholding a category is a promise to say
 * that thing yourself; `because` is that promise in words, and it rides into
 * the log line so the next person reading "[EMAIL WITHHELD]" can see which
 * email carried it. Nothing here is for quieting mail somebody did not want
 * sent — that is the recipient's own notification settings
 * (declinedByPreference), and it writes a row.
 *
 * The scope is one async context, not a flag on the module: two confirmations
 * in flight at the same moment cannot swallow each other's mail, and nothing
 * outside the callback is touched. A nested withhold adds to the outer one
 * rather than replacing it.
 *
 * No email_send_log row is written for a withheld send, deliberately. That log
 * is the answer to "did they get it?", and the answer is already in it — the
 * row for the email that carried it.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { EMAIL_CATEGORY_RULES } from '@gam/shared'

interface Withheld {
  categories: ReadonlySet<string>
  /** Which email is carrying these, in words, for the log line. */
  because: string
}

const held = new AsyncLocalStorage<Withheld>()

/**
 * Run `fn` with these email categories withheld, because the email you are
 * about to send yourself says the same thing.
 *
 * A category that is not a declared one is a typo, and a typo here withholds
 * nothing while reading as though it does — so it throws rather than letting a
 * guest get two emails again (packages/shared/src/emailCategories.ts is the
 * one list; notificationCatalog.test.ts holds every sender to it).
 */
export function withholdEmails<T>(
  opts: { categories: readonly string[]; because: string },
  fn: () => Promise<T>,
): Promise<T> {
  for (const c of opts.categories) {
    if (!(c in EMAIL_CATEGORY_RULES)) {
      throw new Error(`Cannot withhold '${c}' — there is no such email category (packages/shared emailCategories).`)
    }
  }
  const outer = held.getStore()
  return held.run({
    categories: new Set([...(outer?.categories ?? []), ...opts.categories]),
    because: opts.because,
  }, fn)
}

/** Why this category is being withheld right here, or null — nothing is. */
export function withheldBecause(category: string | null | undefined): string | null {
  if (!category) return null
  const store = held.getStore()
  return store?.categories.has(category) ? store.because : null
}
