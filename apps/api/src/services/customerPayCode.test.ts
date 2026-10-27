/**
 * THE SECOND FACTOR (Nic, 10/25): "somebody knowing your phone number can't
 * just use your account."
 *
 * This is a payment credential, so the tests are about the refusals: the
 * throttle, the lock, and not leaking which accounts are worth attacking.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { query, queryOne } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  setPayCode, verifyPayCode, hasPayCode, clearPayCodeLock, payCodeProblem,
  PAY_CODE_MAX_FAILURES, PAY_CODE_LOCK_MINUTES,
} from './customerPayCode'

beforeEach(async () => { await cleanupAllSchema() })

async function profile(name = 'Dominic') {
  const r = await queryOne<{ id: string }>(
    `INSERT INTO customer_profiles (first_name, last_name, phone)
     VALUES ($1, 'gonzalez', '9285550100') RETURNING id`, [name.toLowerCase()])
  return r!.id
}

describe('a code is required before anything is authorized', () => {
  it('a profile with no code authorizes nothing', async () => {
    const id = await profile()
    expect(await hasPayCode(id)).toBe(false)
    const a = await verifyPayCode(id, '135790')
    expect(a.ok).toBe(false)
  })

  it('the right code authorizes, the wrong one does not', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    expect(await hasPayCode(id)).toBe(true)
    expect((await verifyPayCode(id, '417392')).ok).toBe(true)
    expect((await verifyPayCode(id, '417393')).ok).toBe(false)
  })

  it('is never stored in the clear', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    const row = await queryOne<any>(
      `SELECT pay_code_hash FROM customer_profiles WHERE id = $1`, [id])
    expect(row.pay_code_hash).not.toContain('417392')
    expect(row.pay_code_hash.startsWith('$2')).toBe(true)
  })
})

describe('the throttle, which is what makes six digits a factor at all', () => {
  it('locks the account after enough wrong codes, and says to wait', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    for (let i = 1; i < PAY_CODE_MAX_FAILURES; i++) {
      const a = await verifyPayCode(id, '000001')
      expect(a.ok, `attempt ${i}`).toBe(false)
      expect(a.lockedForMinutes, `attempt ${i}`).toBeUndefined()
    }
    const locked = await verifyPayCode(id, '000001')
    expect(locked.ok).toBe(false)
    expect(locked.lockedForMinutes).toBe(PAY_CODE_LOCK_MINUTES)
    expect(locked.say).toContain('Try again in')
  })

  it('refuses even the RIGHT code while locked — the lock is the point', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    for (let i = 0; i < PAY_CODE_MAX_FAILURES; i++) await verifyPayCode(id, '000001')
    const a = await verifyPayCode(id, '417392')
    expect(a.ok).toBe(false)
    expect(a.lockedForMinutes).toBe(PAY_CODE_LOCK_MINUTES)
  })

  it('counts on the ACCOUNT, so trying from somewhere new does not reset it', async () => {
    // There is no session or IP in the count by design: the attacker picks
    // where to try from.
    const id = await profile()
    await setPayCode(id, '417392')
    for (let i = 0; i < 3; i++) await verifyPayCode(id, '000001')
    expect(await queryOne<any>(
      `SELECT pay_code_failures FROM customer_profiles WHERE id = $1`, [id]))
      .toMatchObject({ pay_code_failures: 3 })
  })

  it('a correct code clears the count', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    await verifyPayCode(id, '000001')
    await verifyPayCode(id, '000001')
    expect((await verifyPayCode(id, '417392')).ok).toBe(true)
    expect(await queryOne<any>(
      `SELECT pay_code_failures, pay_code_locked_until FROM customer_profiles WHERE id = $1`, [id]))
      .toMatchObject({ pay_code_failures: 0, pay_code_locked_until: null })
  })

  it('an admin can clear a lock without learning or changing the code', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    for (let i = 0; i < PAY_CODE_MAX_FAILURES; i++) await verifyPayCode(id, '000001')
    await clearPayCodeLock(id)
    // The code they actually know still works, and was never touched.
    expect((await verifyPayCode(id, '417392')).ok).toBe(true)
  })
})

describe('what a refusal must not reveal', () => {
  it('no customer, no code set and wrong code all refuse the same way', async () => {
    const withCode = await profile('Lisa')
    await setPayCode(withCode, '417392')
    const withoutCode = await profile('Myria')
    const nobody = '00000000-0000-0000-0000-000000000000'

    const a = await verifyPayCode(withCode, '999999')
    const b = await verifyPayCode(withoutCode, '999999')
    const c = await verifyPayCode(nobody, '999999')
    // Identical wording: which accounts have a code set, and which exist at
    // all, is a map of what is worth attacking.
    expect(a.say).toBe(b.say)
    expect(b.say).toBe(c.say)
    expect([a.ok, b.ok, c.ok]).toEqual([false, false, false])
  })
})

describe('a code a person would actually have to think about', () => {
  it('takes 6 to 8 digits', () => {
    expect(payCodeProblem('417392')).toBeNull()
    expect(payCodeProblem('41739264')).toBeNull()
    expect(payCodeProblem('41739')).toContain('6 to 8 digits')
    expect(payCodeProblem('417392645')).toContain('6 to 8 digits')
    expect(payCodeProblem('41a392')).toContain('digits only')
  })

  it('refuses the codes everybody tries first', () => {
    for (const bad of ['123456', '000000', '888888', '654321', '12345678', '123123']) {
      expect(payCodeProblem(bad), bad).toContain('run or a repeat')
    }
  })

  it('setting a new code clears any lock', async () => {
    const id = await profile()
    await setPayCode(id, '417392')
    for (let i = 0; i < PAY_CODE_MAX_FAILURES; i++) await verifyPayCode(id, '000001')
    await setPayCode(id, '628451')
    expect((await verifyPayCode(id, '628451')).ok).toBe(true)
  })
})
