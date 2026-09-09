/**
 * S639 (Nic): "I accidentally put Gerald Logue as a lower case, and I have no
 * way to change that invite."
 *
 * The rule is deliberately narrow: fix a name typed in ONE case, leave anything
 * else exactly as written. A general title-caser ruins more names than it fixes,
 * and a tenant's name ends up on their lease and every email we send them.
 *
 * The same rule exists in SQL (normalize_person_name, applied by a trigger on
 * users) because five separate INSERT sites create a tenant. These cases are the
 * contract both implementations answer to.
 */
import { describe, it, expect } from 'vitest'
import { normalizePersonName } from './index'

describe('normalizePersonName', () => {
  it('fixes the mistake actually reported', () => {
    expect(normalizePersonName('gerald')).toBe('Gerald')
  })

  it('fixes shouting too', () => {
    expect(normalizePersonName('ANASTACIO ERREGUIN')).toBe('Anastacio Erreguin')
  })

  it('capitalises after an apostrophe or hyphen', () => {
    expect(normalizePersonName("o'brien")).toBe("O'Brien")
    expect(normalizePersonName('mary-jane')).toBe('Mary-Jane')
  })

  it('leaves a deliberate spelling alone — this is the whole reason it is narrow', () => {
    expect(normalizePersonName('McDonald')).toBe('McDonald')
    expect(normalizePersonName('van der Berg')).toBe('van der Berg')
    expect(normalizePersonName('DeLuca')).toBe('DeLuca')
  })

  it('treats a short all-caps word as initials, not shouting', () => {
    expect(normalizePersonName('JJ')).toBe('JJ')
    expect(normalizePersonName('TJ BLACK')).toBe('TJ Black')
  })

  it('tidies the whitespace a hurried entry leaves behind', () => {
    expect(normalizePersonName('  lena   seales ')).toBe('Lena Seales')
  })

  it('is safe on nothing', () => {
    expect(normalizePersonName('')).toBe('')
    expect(normalizePersonName(null)).toBe('')
    expect(normalizePersonName(undefined)).toBe('')
  })
})
