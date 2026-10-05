/**
 * S655 money plan, Step 15 (fix round 1) — the PM Owners screen says why
 * something failed once, in plain words, with "try again" only when trying
 * again can help. This app's API client passes axios' own words through
 * ("Request failed with status code 403"), so the screen must never show them.
 */
import { describe, it, expect } from 'vitest'
import { errorText, statementErrorText, giveAccessErrorText, ownersErrorText, GROSS_NOTE } from './OwnersPage'

/** An axios-shaped failure: status, the server's sentence (if any), axios' own message. */
const axiosError = (status: number | undefined, serverSays?: string, message?: string) => ({
  message: message ?? (status ? `Request failed with status code ${status}` : 'Network Error'),
  response: status ? { status, data: serverSays ? { success: false, error: serverSays } : {} } : undefined,
})

describe('a failed "Give access" says why once, never a raw status code', () => {
  it('a refusal shows the server\'s own sentence alone — "try again" never helps a refusal', () => {
    const text = giveAccessErrorText(axiosError(403, 'Not a staff member of this PM company'))
    expect(text).toBe('Not a staff member of this PM company')
    expect(text).not.toMatch(/try again/i)
    expect(text).not.toMatch(/status code/i)
  })

  it('a refusal with no sentence from the server falls back to plain words, not "Request failed with status code 403"', () => {
    const text = giveAccessErrorText(axiosError(403))
    expect(text).toBe('Could not give portal access.')
  })

  it('a server failure says to try again, never a raw status code', () => {
    expect(giveAccessErrorText(axiosError(500))).toBe('Could not give portal access. Try again in a moment.')
  })

  it('a dropped connection says to try again, never "Network Error"', () => {
    expect(giveAccessErrorText(axiosError(undefined))).toBe('Could not give portal access. Try again in a moment.')
  })

  it('too many requests (the rate limit answers 429 in plain text) says to try again, never "status code 429"', () => {
    const text = giveAccessErrorText(axiosError(429))
    expect(text).toBe('Could not give portal access. Try again in a moment.')
    expect(text).not.toMatch(/status code|429/)
  })

  it('a timeout says to try again, never axios\' own "timeout of …" words', () => {
    expect(giveAccessErrorText(axiosError(undefined, undefined, 'timeout of 30000ms exceeded')))
      .toBe('Could not give portal access. Try again in a moment.')
  })
})

describe('an owners list that did not load says why, instead of "No owners yet"', () => {
  it('a server failure names the list and says to try again', () => {
    expect(ownersErrorText(axiosError(502))).toBe('Could not load your owners. Try again in a moment.')
  })

  it('a refusal shows the server\'s reason alone', () => {
    expect(ownersErrorText(axiosError(403, 'PM company is suspended; contact platform support')))
      .toBe('PM company is suspended; contact platform support')
  })
})

describe('the statement keeps its own words', () => {
  it('a missing owner relationship shows the server\'s sentence', () => {
    expect(statementErrorText(axiosError(404, 'No active owner relationship with this company')))
      .toBe('No active owner relationship with this company')
  })

  it('a server failure says to try again', () => {
    expect(statementErrorText(axiosError(500))).toBe('Could not load this statement. Try again in a moment.')
  })

  it('a server crash never shows its insides (a database message), only plain words and try again', () => {
    expect(statementErrorText(axiosError(500, 'relation "v_payment_money" does not exist')))
      .toBe('Could not load this statement. Try again in a moment.')
    expect(statementErrorText(axiosError(503, 'Statements are restarting.')))
      .toBe('Statements are restarting. Try again in a moment.')
  })

  it('reads an unknown failure with no shape as the fallback, with a retry', () => {
    expect(errorText(undefined, 'Could not do that.')).toBe('Could not do that. Try again in a moment.')
  })
})

describe('the note under the gross names the right day for money paid ahead through GAM', () => {
  it('the owner\'s share is set aside for the next payout the day GAM pays a bill with it, never "paid out" that day', () => {
    expect(GROSS_NOTE).toMatch(/set aside for the owner's next payout/)
    expect(GROSS_NOTE).not.toMatch(/paid out/)
  })

  it('a deposit held for a tenant, a GAM fee and a credit the owner gave are never in the gross', () => {
    expect(GROSS_NOTE).toMatch(/A deposit held for a tenant, a GAM fee and a credit the owner gave are never in it\./)
  })
})
