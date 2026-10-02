/**
 * S655 review — the "I paid at the bank" screens promise only what GAM can do.
 *
 * With the landlord's bank connected and read, GAM watches for the deposit and
 * applies it; without that, the landlord checks their own bank and marks the
 * bill paid, and a report never expires. Country Acres and TruBlu tenants were
 * told the first story either way.
 */
import { describe, it, expect } from 'vitest'
import {
  alreadyReportedMessage, bankWatch, pendingReportStatus, reportDepositCopy, reportStandsNow,
} from './reportBankDepositCopy'

const AUTOMATIC = /automatic|apply it for you|we’ll watch their bank|ends after|expire/i

describe('reporting a deposit when the landlord’s bank is not connected', () => {
  const copy = reportDepositCopy('not_watching')

  it('says the landlord checks their own bank and marks the bill paid', () => {
    expect(copy.intro).toMatch(/isn’t connected to GAM right now/)
    expect(copy.intro).toMatch(/Your landlord checks their own bank and marks your bill paid/)
  })

  it('tells the tenant the next step: let the landlord know, keep the slip', () => {
    expect(copy.intro).toMatch(/let them know you paid and keep your deposit slip/)
  })

  it('promises nothing automatic and no expiry, anywhere on the form', () => {
    for (const line of [copy.intro, copy.warning, copy.confirm]) expect(line).not.toMatch(AUTOMATIC)
  })

  it('has the tenant agree the balance holds until the landlord marks it paid', () => {
    expect(copy.confirm).toMatch(/until my landlord marks it paid/)
    expect(copy.canReport).toBe(true)
  })

  it('lists a waiting report as the landlord’s to mark paid, not as waiting on the bank', () => {
    const line = pendingReportStatus(false)
    expect(line).toMatch(/Your landlord checks their own bank and marks your bill paid/)
    expect(line).toMatch(/Let them know you paid/)
    expect(line).not.toMatch(/show up|appear/i)
  })
})

describe('reporting a deposit when GAM is reading the landlord’s bank', () => {
  it('says GAM watches for it, applies it, and dates it the day the tenant paid', () => {
    const copy = reportDepositCopy('watching', 7)
    expect(copy.intro).toMatch(/watch their bank/)
    expect(copy.intro).toMatch(/dated the day you paid/)
    expect(copy.warning).toMatch(/ends after 7 days/)
    expect(copy.confirm).toMatch(/until it shows up in the bank/)
  })

  it('lists a waiting report as waiting on the landlord’s bank', () => {
    expect(pendingReportStatus(true)).toMatch(/Waiting for it to show up in your landlord’s bank/)
  })
})

describe('before GAM knows which it is', () => {
  it('holds the Report button while it checks, and promises nothing', () => {
    const copy = reportDepositCopy(bankWatch({ loading: true }))
    expect(copy.canReport).toBe(false)
    for (const line of [copy.intro, copy.warning, copy.confirm]) expect(line).not.toMatch(AUTOMATIC)
  })

  it('still lets the tenant report when the check fails, and promises nothing', () => {
    const w = bankWatch({ failed: true })
    expect(w).toBe('unknown')
    const copy = reportDepositCopy(w)
    expect(copy.canReport).toBe(true)
    for (const line of [copy.intro, copy.warning, copy.confirm]) expect(line).not.toMatch(AUTOMATIC)
    expect(pendingReportStatus(undefined)).not.toMatch(AUTOMATIC)
  })

  it('reads the server’s answer as it is', () => {
    expect(bankWatch({ bankFeedLinked: true })).toBe('watching')
    expect(bankWatch({ bankFeedLinked: false })).toBe('not_watching')
  })
})

describe('a deposit reported twice', () => {
  it('says so, with the same next step as the first report', () => {
    expect(alreadyReportedMessage('not_watching')).toMatch(/^You already reported this deposit\. Your landlord checks/)
    expect(alreadyReportedMessage('watching')).toMatch(/^You already reported this deposit\. Waiting for it/)
  })
})

describe('a report the tenant tried to take back after it was settled', () => {
  it('applied to the bill: says when, that it stays, and who to contact', () => {
    const line = reportStandsNow({ id: 'r', status: 'confirmed', confirmedOn: '2026-10-01' })!
    expect(line).toMatch(/applied to your bill on Oct 1/)
    expect(line).toMatch(/can’t be taken back/)
    expect(line).toMatch(/contact your landlord/)
  })

  it('closed because nothing arrived: says the balance did not change', () => {
    expect(reportStandsNow({ id: 'r', status: 'unconfirmed' })).toMatch(/no matching deposit showed up\. Your balance didn’t change/)
  })

  it('already taken back: says there is nothing left to do', () => {
    expect(reportStandsNow({ id: 'r', status: 'withdrawn' })).toMatch(/already taken back\. There’s nothing else to do/)
  })

  it('still waiting, or not reloaded yet: adds nothing to the server’s own sentence', () => {
    expect(reportStandsNow({ id: 'r', status: 'pending' })).toBeNull()
    expect(reportStandsNow(undefined)).toBeNull()
  })
})
