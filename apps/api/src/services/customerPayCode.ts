/**
 * THE SECOND FACTOR ON A GAM CUSTOMER PROFILE (Nic, 10/25).
 *
 *   "Me just giving out somebody's phone number and using their card to pay
 *    doesn't work... I'm going to give you my phone number to pay this bill
 *    from my account, and you have to give them like a 6 or 8 digit code that
 *    you have memorized. That way, some second factor authentication where
 *    somebody knowing your phone number can't just use your account."
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 * A PHONE NUMBER IDENTIFIES A PERSON. IT NEVER AUTHORIZES ANYTHING.
 *
 * Everything else here follows from that. A profile with no code set can
 * authorize nothing (not "anything", not "a little") — the safe default, so a
 * customer who never sets one simply keeps paying the way they do now.
 *
 * ── WHY THE THROTTLE IS THE FEATURE ────────────────────────────────────────
 * Six digits is a million guesses. That is nothing to a script, and about three
 * days to somebody patient at one a second — so a code without a throttle is
 * not a factor, it is a speed bump. Hence:
 *
 *   * failures count on the PROFILE, not a session or an IP, because the
 *     attacker picks where to try from;
 *   * five wrong codes locks the account for fifteen minutes;
 *   * a correct code clears the count;
 *   * every answer takes the same shape, so a caller cannot learn from the
 *     difference between "no such customer", "no code set" and "wrong code" —
 *     each of those is a map of who has what.
 *
 * ── WHAT NEVER HAPPENS TO THE CODE ─────────────────────────────────────────
 * It is bcrypt-hashed like a password. It is never returned by any read, never
 * written to a log, never emailed, and never put in an agent prompt
 * (gam-no-real-data-in-prompts). verify() takes it and gives back a yes or no.
 *
 * Biometrics — "facial scan, fingerprint, retinal scan" — are later
 * ALTERNATIVES to the code, not a replacement for having a factor. The naming
 * here is about the factor, not about a PIN, so they can join it.
 */
import bcrypt from 'bcryptjs'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'

/** Nic: "like a 6 or 8 digit code that you have memorized." */
export const PAY_CODE_MIN_DIGITS = 6
export const PAY_CODE_MAX_DIGITS = 8
/** Wrong codes before the account is locked. */
export const PAY_CODE_MAX_FAILURES = 5
/** How long a locked account stays locked. */
export const PAY_CODE_LOCK_MINUTES = 15

const BCRYPT_ROUNDS = 10

/**
 * Codes a person should not be allowed to choose, because they are the first
 * things anybody guesses. A factor everybody sets to 123456 is not a factor.
 */
function tooGuessable(code: string): boolean {
  if (/^(\d)\1*$/.test(code)) return true                       // 000000, 888888
  const asc = '0123456789012345678'
  const desc = '9876543210987654321'
  if (asc.includes(code) || desc.includes(code)) return true    // 123456, 654321
  return ['123123', '112233', '696969', '12345678', '87654321'].includes(code)
}

export function payCodeProblem(code: string): string | null {
  if (!/^\d+$/.test(code)) return 'A pay code is digits only.'
  if (code.length < PAY_CODE_MIN_DIGITS || code.length > PAY_CODE_MAX_DIGITS) {
    return `A pay code is ${PAY_CODE_MIN_DIGITS} to ${PAY_CODE_MAX_DIGITS} digits.`
  }
  if (tooGuessable(code)) {
    return 'Choose a code that is not a run or a repeat — those are the first ones anybody tries.'
  }
  return null
}

/**
 * Set or replace the code. The CUSTOMER does this; a business never sets
 * somebody's factor for them, which would make it theirs rather than the
 * person's. Callers must have established who they are first.
 */
export async function setPayCode(profileId: string, code: string): Promise<void> {
  const problem = payCodeProblem(code)
  if (problem) throw new AppError(400, problem)
  const hash = await bcrypt.hash(code, BCRYPT_ROUNDS)
  const row = await queryOne<{ id: string }>(
    `UPDATE customer_profiles
        SET pay_code_hash = $2, pay_code_set_at = NOW(),
            pay_code_failures = 0, pay_code_locked_until = NULL, updated_at = NOW()
      WHERE id = $1
     RETURNING id`,
    [profileId, hash])
  if (!row) throw new AppError(404, 'That GAM customer was not found.')
}

export interface PayCodeAnswer {
  /** The only thing a caller gets to learn. */
  ok: boolean
  /** Said only when it is already locked, so an honest person knows to wait. */
  lockedForMinutes?: number
  /** What to show a person who got it wrong, with no count of anybody's tries. */
  say: string
}

const REFUSED = 'That phone number and code do not go together.'

/**
 * Does this code authorize this profile right now?
 *
 * Every refusal looks the same from outside — no customer, no code set, wrong
 * code and locked all answer the same way (except that a locked account says
 * to wait, which an attacker already knows because they caused it). The
 * difference between "no code set" and "wrong code" is a map of whose account
 * is worth attacking, so it is not given out.
 */
export async function verifyPayCode(profileId: string, code: string): Promise<PayCodeAnswer> {
  const p = await queryOne<{
    pay_code_hash: string | null
    pay_code_failures: number
    locked: boolean
    locked_minutes: number | null
  }>(
    `SELECT pay_code_hash, pay_code_failures,
            (pay_code_locked_until IS NOT NULL AND pay_code_locked_until > NOW()) AS locked,
            CEIL(GREATEST(0, EXTRACT(EPOCH FROM (pay_code_locked_until - NOW())) / 60))::int AS locked_minutes
       FROM customer_profiles WHERE id = $1`,
    [profileId])

  // A locked account is told to wait: the person who locked it already knows.
  if (p?.locked) {
    return { ok: false, lockedForMinutes: p.locked_minutes ?? PAY_CODE_LOCK_MINUTES,
             say: `Too many wrong codes. Try again in ${p.locked_minutes ?? PAY_CODE_LOCK_MINUTES} minutes.` }
  }

  // No such customer, or no factor set. Both refuse, and both refuse the SAME
  // way — a caller must not be able to find out which.
  if (!p || !p.pay_code_hash) {
    // Spend the same time a real comparison would, so the answer cannot be
    // told apart by how fast it came back.
    await bcrypt.compare(code, '$2a$10$' + 'x'.repeat(53)).catch(() => false)
    return { ok: false, say: REFUSED }
  }

  const matched = await bcrypt.compare(code, p.pay_code_hash).catch(() => false)
  if (matched) {
    await query(
      `UPDATE customer_profiles
          SET pay_code_failures = 0, pay_code_locked_until = NULL,
              pay_code_last_used_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [profileId])
    return { ok: true, say: 'Authorized.' }
  }

  // Count it on the ACCOUNT, and lock at the ceiling. One statement, so two
  // simultaneous guesses cannot both read 4 and write 5.
  const after = await queryOne<{ failures: number; locked: boolean }>(
    `UPDATE customer_profiles
        SET pay_code_failures = pay_code_failures + 1,
            pay_code_locked_until = CASE
              WHEN pay_code_failures + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
              ELSE pay_code_locked_until END,
            updated_at = NOW()
      WHERE id = $1
     RETURNING pay_code_failures AS failures,
               (pay_code_locked_until IS NOT NULL AND pay_code_locked_until > NOW()) AS locked`,
    [profileId, PAY_CODE_MAX_FAILURES, PAY_CODE_LOCK_MINUTES])

  if (after?.locked) {
    return { ok: false, lockedForMinutes: PAY_CODE_LOCK_MINUTES,
             say: `Too many wrong codes. Try again in ${PAY_CODE_LOCK_MINUTES} minutes.` }
  }
  return { ok: false, say: REFUSED }
}

/** Has this customer set a factor? For the customer's own screen only. */
export async function hasPayCode(profileId: string): Promise<boolean> {
  const r = await queryOne<{ set: boolean }>(
    `SELECT pay_code_hash IS NOT NULL AS set FROM customer_profiles WHERE id = $1`, [profileId])
  return r?.set === true
}

/**
 * A GAM admin clearing a lock for somebody who locked themselves out. It does
 * NOT reveal or change the code — only the lock, so a locked-out customer can
 * try the code they actually know.
 */
export async function clearPayCodeLock(profileId: string): Promise<void> {
  await query(
    `UPDATE customer_profiles
        SET pay_code_failures = 0, pay_code_locked_until = NULL, updated_at = NOW()
      WHERE id = $1`, [profileId])
}
