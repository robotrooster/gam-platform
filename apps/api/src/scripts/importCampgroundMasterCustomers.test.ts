/**
 * 10/21 (Nic) — BRINGING MOUNTAIN VIEW'S OLD ADDRESS BOOK OVER.
 *
 *   "I don't need the reservation history. I just need the customer data."
 *   "there's a lot of throwaway customers that are not obviously real."
 *
 * The real file is seven hundred and sixty-nine rows of actual people and lives
 * outside this repository, because ~/gam is public and their names and phone
 * numbers are not. So what is tested here is the JUDGEMENT the importer makes,
 * on rows shaped like the ones in that file — above all the judgements it
 * refuses to make.
 */
import { describe, it, expect } from 'vitest'
import { parseCsv, planFromCsv, notAName, tidyPhone, tidyEmail, lookAlikes } from './importCampgroundMasterCustomers'

const HEADER = '"Last Name","First Names","Phone 1","Phone 2","Phone 3","Email","Notes","Reservations"'
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n')

describe('reading the old system\'s file', () => {
  it('reads quoted fields, commas inside them, and doubled quotes', () => {
    const rows = parseCsv(csv('"Reed","Anne","520-555-0100","","","a@b.dev","Site 4, back in","3"'))
    expect(rows).toHaveLength(1)
    expect(rows[0]['Last Name']).toBe('Reed')
    expect(rows[0]['Notes']).toBe('Site 4, back in')
  })

  it('a note running over several lines does not become several people', () => {
    const rows = parseCsv(csv('"Reed","Anne","","","","","first line\nsecond line","1"'))
    expect(rows).toHaveLength(1)
    expect(rows[0]['Notes']).toContain('second line')
  })
})

describe('tidying what the desk typed', () => {
  it('takes a phone number however it was written, and keeps ten digits', () => {
    for (const w of ['520-555-0100', '(520) 555-0100', '1-520-555-0100', '520.555.0100', ' 15205550100 ']) {
      expect(tidyPhone(w)).toBe('5205550100')
    }
  })

  it('refuses something that is not a phone number rather than storing a fragment', () => {
    for (const w of ['', 'none', '555-0100', 'call the office']) expect(tidyPhone(w)).toBeNull()
  })

  it('lowercases an email and refuses one that is not an address', () => {
    expect(tidyEmail('  Anne@Example.DEV ')).toBe('anne@example.dev')
    for (const w of ['', 'none', 'anne at example', 'anne@example']) expect(tidyEmail(w)).toBeNull()
  })
})

describe('who is a person and who is a placeholder', () => {
  it('keeps an ordinary name', () => {
    expect(notAName('Anne', 'Reed')).toBeNull()
    expect(notAName('Jo', 'Ng')).toBeNull()          // short, but a whole name
  })

  it('drops what the desk typed to get a reservation saved', () => {
    expect(notAName('', '')).toMatch(/no name/)
    expect(notAName('', 'unknown')).toMatch(/placeholder/)
    expect(notAName('', 'xxxxx')).toMatch(/over and over/)
    expect(notAName('N', 'A')).toMatch(/nothing to reach them by/)
  })

  it('a site number typed as a name is never a person, phone or no phone', () => {
    // Nobody will ever find them by it.
    expect(notAName('', '719')).toMatch(/no letters/)
    expect(notAName('', '719', true)).toMatch(/no letters/)
  })

  it('but initials WITH a number to ring are somebody the desk met', () => {
    expect(notAName('', 'RJ')).toMatch(/nothing to reach them by/)
    expect(notAName('', 'RJ', true)).toBeNull()
  })
})

describe('the plan', () => {
  it('brings everyone over, including the ones it only knows a name for', () => {
    const plan = planFromCsv(csv(
      '"Reed","Anne","520-555-0100","","","anne@example.dev","",""',
      '"Pike","Tom","","","","","",""',
    ))
    expect(plan.people.map(p => `${p.firstName} ${p.lastName}`)).toEqual(['Anne Reed', 'Tom Pike'])
    expect(plan.people[1]).toMatchObject({ email: null, phone: null })
  })

  it('says what it left behind and why — nothing disappears quietly', () => {
    const plan = planFromCsv(csv(
      '"Reed","Anne","520-555-0100","","","","",""',
      '"unknown","","","","","","",""',
    ))
    expect(plan.people).toHaveLength(1)
    expect(plan.dropped).toHaveLength(1)
    expect(plan.dropped[0]).toMatchObject({ row: 3, name: 'unknown' })
    expect(plan.dropped[0].why).toMatch(/placeholder/)
  })

  it('gives every row its own key, so two people of the same name both come over', () => {
    const plan = planFromCsv(csv(
      '"Reed","Anne","520-555-0100","","","","",""',
      '"Reed","Anne","520-555-0199","","","","",""',
    ))
    expect(plan.people).toHaveLength(2)
    expect(new Set(plan.people.map(p => p.elsewhereRef)).size).toBe(2)
    // Stable, so a second run of the file updates these two instead of
    // making two more.
    expect(planFromCsv(csv(
      '"Reed","Anne","520-555-0100","","","","",""',
      '"Reed","Anne","520-555-0199","","","","",""',
    )).people.map(p => p.elsewhereRef)).toEqual(plan.people.map(p => p.elsewhereRef))
  })
})

describe('people who MIGHT be one person — printed, never merged', () => {
  it('flags the same name twice without joining them', () => {
    const plan = planFromCsv(csv(
      '"Reed","Anne","","","","","",""',
      '"Reed","Anne","","","","","",""',
    ))
    expect(plan.people).toHaveLength(2)
    expect(plan.lookAlike.some(s => s.why === 'the same name')).toBe(true)
  })

  it('flags a shared phone — at a campground that is as likely a couple as a duplicate', () => {
    const plan = planFromCsv(csv(
      '"Reed","Anne","520-555-0100","","","","",""',
      '"Reed","Mark","520-555-0100","","","","",""',
    ))
    expect(plan.people).toHaveLength(2)
    expect(plan.lookAlike.some(s => s.why === 'the same phone number')).toBe(true)
  })

  it('flags Val and Valerie Sutherland — Nic\'s own test case — and leaves them both', () => {
    const plan = planFromCsv(csv(
      '"Sutherland","Val","","","","","",""',
      '"Sutherland","Valerie","","","","","",""',
    ))
    expect(plan.people).toHaveLength(2)
    const pair = plan.lookAlike.find(s => s.why === 'one first name is the start of the other')
    expect(pair).toBeTruthy()
    expect(pair!.names.sort()).toEqual(['Val Sutherland', 'Valerie Sutherland'])
  })

  it('does not flag two different people who merely share a surname', () => {
    expect(lookAlikes([
      { firstName: 'Anne', lastName: 'Reed', email: null, phone: null, notes: null, elsewhereRef: 'a' },
      { firstName: 'Mark', lastName: 'Reed', email: null, phone: null, notes: null, elsewhereRef: 'b' },
    ])).toEqual([])
  })
})
