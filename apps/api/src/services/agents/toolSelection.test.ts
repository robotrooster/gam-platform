/**
 * S628 — the tools for THIS turn, and the promise that nothing needed is lost.
 *
 * The selector exists because 239 tool definitions per landlord turn — 230 KB,
 * ~59k tokens — took the KV cache from 5.5 GB per conversation to 18 GB and
 * crashed the model server four times in an hour. Cutting the payload is easy;
 * cutting it without losing the tool the person actually needed is the whole
 * problem, and that is what this pins.
 *
 * Every case below is a landlord sentence and the action it must still be able
 * to reach. If a change to the scoring drops one of these, the agent quietly
 * loses a capability and the only symptom is "let me look into that" forever.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_PROFILES } from './profiles'
import { getToolsForProfile, toToolSchema } from './tools'
import { selectToolsForTurn, isActionTool } from './toolSelection'

const landlord = AGENT_PROFILES.find((p) => p.id === 'landlord_entry')!
const tenant = AGENT_PROFILES.find((p) => p.id === 'tenant_entry')!
const ALL = getToolsForProfile(landlord)

/** What the person said, and the action that has to survive selection. */
const CASES: [string, string][] = [
  ['can you waive the late fee on 204?',                'issue_tenant_credit'],
  ['add 12 RV spots to sunset palms',                   'add_units'],
  ['the roofer sent a $4,200 invoice due the 15th',     'record_bill'],
  ['run the water bills for march',                     'generate_utility_bills'],
  ["I'm starting an eviction on spot 7",                'set_eviction_mode'],
  ['send an invite to nadia for 204',                   'invite_tenant'],
  ['charge apt 204 $120 for the screen door',           'add_one_off_charge'],
  ['put spot 12 up to $520 from march',                 'draft_terms_addendum'],
  ['the alvarez family have lived in 12 for years',     'migrate_existing_tenant'],
  ['pets are $300 at sunset palms',                     'set_property_fee'],
  ['I closed on the fourplex on roosevelt',             'add_property'],
  ['danny is going to $25 an hour',                     'update_employee'],
  ['clock me in',                                       'clock_in'],
  ['that $1,300 deposit on the 4th was spot 12',        'confirm_deposit_match'],
  ['get their lease ready',                             'draft_household_lease'],
  ['lot 14 water reads 89,120',                         'record_reading_in_run'],
  ['spot 14 is actually 14A',                           'renumber_unit'],
  ['maria signs the leases at sunset palms',            'set_lease_signer'],
  ['the pool closes at nine now',                       'update_common_area'],
  ['tell 204 the plumber is coming thursday',           'give_entry_notice'],
]

describe('the tools for this turn', () => {
  it.each(CASES)('keeps %j reachable → %s', (message, want) => {
    const sel = selectToolsForTurn(landlord, ALL, message, {})
    expect(sel.tools.map((t) => t.name)).toContain(want)
  })

  it('cuts the payload by well over half', () => {
    const before = JSON.stringify(ALL.map(toToolSchema)).length
    const after = CASES.map(([m]) =>
      JSON.stringify(selectToolsForTurn(landlord, ALL, m, {}).tools.map(toToolSchema)).length)
    const worst = Math.max(...after)
    // Measured at ~76% smaller. Asserted loosely so ordinary wording changes in
    // the descriptions do not fail the suite — what matters is that the payload
    // stays in the region where two conversations fit in GPU memory, not three
    // percentage points either way.
    expect(worst).toBeLessThan(before * 0.5)
  })

  it('NEVER drops a read tool — a missing lookup is a fabricated answer', () => {
    // The asymmetry the whole design rests on. A dropped action costs "let me
    // check on that"; a dropped lookup costs an invented balance, which is the
    // failure this system exists to prevent.
    const reads = ALL.filter((t) => !isActionTool(t.name)).map((t) => t.name)
    for (const [m] of CASES) {
      const got = new Set(selectToolsForTurn(landlord, ALL, m, {}).tools.map((t) => t.name))
      for (const r of reads) expect(got, `${r} dropped on "${m}"`).toContain(r)
    }
  })

  it('never drops what the phrase table already routed to', () => {
    // The deterministic layer must not be overruled by the lexical one. A
    // routed tool is one the table is confident about; scoring has no business
    // second-guessing it.
    const sel = selectToolsForTurn(landlord, ALL, 'anything at all', {
      alwaysInclude: ['set_eviction_mode', 'record_bill'],
    })
    expect(sel.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['set_eviction_mode', 'record_bill']))
  })

  it('leaves a small profile completely alone', () => {
    // The tenant agent holds 67 tools and was never the problem. Selection must
    // be a no-op there rather than a second thing that can go wrong.
    const all = getToolsForProfile(tenant)
    const sel = selectToolsForTurn(tenant, all, 'how much do I owe?', {})
    expect(sel.tools).toHaveLength(all.length)
    expect(sel.droppedActions).toBe(0)
  })

  it('an unrecognisable message still leaves every lookup in place', () => {
    // Nonsense must degrade to "can look things up, cannot act" rather than to
    // an agent with nothing at all.
    const sel = selectToolsForTurn(landlord, ALL, 'asdfgh qwerty zzz', {})
    const reads = ALL.filter((t) => !isActionTool(t.name)).length
    expect(sel.tools.length).toBeGreaterThanOrEqual(reads)
  })
})
