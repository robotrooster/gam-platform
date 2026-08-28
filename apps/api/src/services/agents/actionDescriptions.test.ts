/**
 * S628 — the descriptions are the product, so they get invariants too.
 *
 * A tool description does two jobs that nothing else in the system does. It is
 * the ONLY thing telling the model when this action is the right one, and since
 * toolSelection.ts scores on its text it is now also what decides whether the
 * action is offered at all. A description written for a developer is an action
 * the agent cannot find and a landlord cannot reach.
 *
 * These are the properties an audit of all 207 turned up as already true. They
 * are asserted so they stay true, because the failure mode is silent: nothing
 * errors, the agent simply stops being able to do something.
 */
import { describe, it, expect } from 'vitest'
import { PORTAL_ACTIONS } from './portalActions'

/** Anything that ends, removes, empties or finalises something. */
const DESTRUCTIVE =
  /^(delete|remove|cancel|void|terminate|retire|archive|revoke|withdraw|clear|unassign|finalize|close|deny|reject)_|_(cancel|void|delete)$|eviction/

describe('what every action description must be', () => {
  it('CONFIRMS FIRST when it ends or removes something', () => {
    // The single most important property here. These are the actions where
    // being wrong cannot be walked back — an eviction mode that stops a
    // landlord being paid, a deposit return that settles, a lease that ends.
    const missing = PORTAL_ACTIONS
      .filter((a) => DESTRUCTIVE.test(a.id) && !a.confirmFirst)
      .map((a) => a.id)
    expect(missing, `these end or remove something without reading it back first: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('is written for the person, not for a developer', () => {
    // An endpoint path, a request field or a schema name in a description means
    // it was written from the route rather than from what somebody would say.
    // The model chooses by these words; so does the selector.
    const jargon = PORTAL_ACTIONS
      .filter((a) => /\/api\/|req\.body|\bzod\b|SELECT |INSERT /.test(a.description))
      .map((a) => a.id)
    expect(jargon, `written from the route rather than the person: ${jargon.join(', ')}`).toEqual([])
  })

  it('says enough to be chosen by', () => {
    // Selection scores on this text. A one-line description is a tool that only
    // wins when the person happens to use its exact name.
    const thin = PORTAL_ACTIONS.filter((a) => a.description.length < 120).map((a) => a.id)
    expect(thin, `too thin for the model or the selector to choose by: ${thin.join(', ')}`).toEqual([])
  })

  it('mostly carries an example of what somebody would actually type', () => {
    // A RATCHET, not a rule. The "Use for ..." quotes are the strongest signal
    // the selector has — they are the words a landlord types. 169 of 207 have
    // one; the rest were written before selection existed and are still
    // reachable (spot-checked). This holds the line and lets it improve.
    const withExample = PORTAL_ACTIONS.filter((a) => /Use for/i.test(a.description)).length
    expect(withExample).toBeGreaterThanOrEqual(169)
  })

  it('never promises the agent can do what it must not', () => {
    // Descriptions are read by the model as capability. One that says it can
    // waive, refund, or decide a screening outcome would teach it to offer
    // something the platform refuses — worse than not having the tool.
    for (const a of PORTAL_ACTIONS) {
      const d = a.description.toLowerCase()
      expect(/\bi can waive\b|\bi will refund\b|\bi can refund\b/.test(d), a.id).toBe(false)
    }
  })
})
