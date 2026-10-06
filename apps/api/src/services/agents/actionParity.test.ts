/**
 * S626 — CAN THE AGENT DO WHAT THE PERSON CAN DO?
 *
 * Nic: "we want the agent to be able to take any action that can be taken...
 * The agent can do anything as if it was a personal assistant in our software.
 * It cannot do anything that is not relevant to our software."
 *
 * That is a measurable claim, so this measures it. Every mutating endpoint on
 * the API is an action somebody can take; the question is which of them the
 * agent can take too.
 *
 * Three things are deliberately NOT counted as gaps:
 *   - credentials and card entry, which Claude must never handle at all;
 *   - other portals (business, POS, admin, public booking sites) and shelved
 *     features, which are siloed by directive — a landlord agent reaching into
 *     the business portal would be the bug;
 *   - read endpoints, which are a separate axis (see routeCoverage.test.ts).
 *
 * The number is a RATCHET. It may fall. It may not rise.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const ROUTES = join(__dirname, '../../routes')
const MUTATING = /^\s*\w+Router\.(post|patch|put|delete)\(\s*'([^']+)'/gm

/** Another portal, or a feature deliberately switched off. Not a gap. */
const SILOED = new Set([
  'admin', 'adminOps', 'businesses', 'businessCustomers', 'businessInventory',
  'businessPos', 'businessQuotes', 'businessUsers', 'businessWorkOrders',
  'businessAttachments', 'pos', 'pm', 'platform', 'routes', 'depots',
  'dumpLocations', 'vehicles', 'terminal', 'propane', 'publicPropertyBooking',
  'publicBooking', 'publicCustomerPortal', 'publicCardUpdate',
  'propertyBookingAdmin', 'subleases', 'subleaseInvitations', 'telemetry',
  'stripeWebhook', 'webhooks',
])

/** Claude must never do these, whatever the user asks. */
const FORBIDDEN = new Set(['auth', 'totp', 'emailOtp', 'stripe'])

function endpointsByArea() {
  const by: Record<string, number> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const area = fn.slice(0, -3)
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    const n = [...src.matchAll(MUTATING)].length
    if (n) by[area] = n
  }
  return by
}

describe('action parity — what a person can do, the agent should be able to do', () => {
  const by = endpointsByArea()
  const reachable = Object.entries(by)
    .filter(([a]) => !SILOED.has(a) && !FORBIDDEN.has(a))
    .reduce((s, [, n]) => s + n, 0)

  it('the surface is roughly the size we think it is', () => {
    // A large move either way means routes were added or the silo list rotted.
    expect(reachable).toBeGreaterThan(250)
    // 10/6: 451 after the per-property bank-deposit setting and the bank
    // feed's deposit matching each added a mutating route.
    expect(reachable).toBeLessThan(475)
  })

  it('nothing from another portal has crept into a landlord or tenant agent', async () => {
    // The directive that matters most: a landlord agent must never reach the
    // business portal, the admin surface, or the POS.
    const { AGENT_PROFILES } = await import('./profiles')
    const { getTool } = await import('./tools')
    for (const p of AGENT_PROFILES as any[]) {
      if (p.audience !== 'landlord' && p.audience !== 'tenant') continue
      for (const name of p.toolNames ?? []) {
        const t = getTool(name)
        expect(t, `${p.id} carries unknown tool ${name}`).toBeTruthy()
        // Every tool a profile holds must declare that audience.
        expect(t!.audiences, `${name} on ${p.id}`).toContain(p.audience)
      }
    }
  })

  it('credentials and card entry are not agent actions and never become one', async () => {
    const { getTool } = await import('./tools')
    const { AGENT_PROFILES } = await import('./profiles')
    const banned = /password|otp|two_factor|totp|card_number|payment_method_token|reset_credential/i
    for (const p of AGENT_PROFILES as any[]) {
      for (const name of p.toolNames ?? []) {
        expect(banned.test(name), `${name} looks like a credential action`).toBe(false)
        const t = getTool(name)
        if (t) expect(banned.test(JSON.stringify(t.parameters ?? {})), `${name} params`).toBe(false)
      }
    }
  })

  it('the write gap does not grow — a ratchet, lower it as tools land', async () => {
    const { AGENT_PROFILES } = await import('./profiles')
    // Keep this in step with new action verbs — a write tool the regex does not
    // recognize silently lowers the count and weakens the ratchet, which is how
    // this test would quietly stop protecting anything.
    const WRITE = /^(file|log|submit|request|respond|draft|book|capture|create|update|set|record|report|send|cancel|pay|add|remove|approve|assign|decide|flag|mark|message|post|reject|schedule|decline|resolve|bill|invite|close|apply|renew|terminate|upload|charge|void|categorize|ignore|acknowledge|offer|serve|hibernate|resume|retire|accept|revoke|reconcile|seed|issue|clock|complete|deny|withdraw|give|rename|archive|waive|nudge|answer|dismiss|register|change|explain|clear|start|finalize|renumber|activate|delete|generate|hold|sync|disconnect|reschedule|copy|confirm|unassign|correct|auto|onboard|edit|migrate|park|reach|reapply)_/
    const writes = new Set<string>()
    for (const p of AGENT_PROFILES as any[]) {
      if (p.audience !== 'landlord' && p.audience !== 'tenant') continue
      for (const n of p.toolNames ?? []) if (WRITE.test(n)) writes.add(n)
    }
    // S626: 26 when the audit was written, 41 after the dispatch landed and the
    // manifest was expanded. S628 ended at 237, with every remaining mutating
    // endpoint either reachable or named in scripts/action-gap.js with the
    // reason it is not — a signature, a file, a credential, a permission, or
    // another product's surface.
    // Raise as capability lands; never lower.
    // S630 DIRECTIVE (Nic): 237 → 233. FOUR actions were deliberately taken AWAY
    // from the agent, not lost — add_one_off_charge, cancel_one_off_charge,
    // issue_tenant_credit, void_tenant_credit. "The assistant cannot waive the
    // late fee. The landlord has to waive the late fee and apply credits to the
    // account... even when a landlord wants to issue the credit, they need to be
    // manually going in and doing it."
    //
    // S637 DIRECTIVE (Nic): 233 → 232. ONE action was deliberately taken away —
    // nudge_landlord_banking, which let a tenant email their landlord about the
    // landlord's unfinished bank setup. "I don't want any forward facing
    // messages that tell them anything about our bank account." Its endpoint
    // (POST /tenants/me/nudge-landlord-banking) is deleted too, so this is a
    // capability removed on purpose, not a tool that quietly stopped resolving.
    //
    // S655 (security): 232 → 231. ONE action was deliberately taken away —
    // approve_property_transfer. Accepting a property (the buyer) or confirming
    // a sale (a selling owner) is that owner's own consent, given with the code
    // emailed to them; the agent never accepts on anyone's behalf. It never
    // worked anyway: the action sent no code (400), and the API refused the
    // buyer (403). Its endpoint is named in actionGap DELIBERATE;
    // decline_property_transfer stays, because stopping a transfer is safe.
    //
    // 10/4 (decisions #38 Q6, gate review): 231 → 229. TWO actions were
    // deliberately taken away — finalize_deposit_return (finalizing a move-out
    // sends the GAM-held refund by itself, #47a) and confirm_deposit_match
    // (matching a bank deposit settles charges). "The AI assistant must NOT ...
    // make any money decision." Both endpoints are named in actionGap
    // DELIBERATE; the drafts before finalize and mark_deposit_not_rent stay.
    //
    // The ratchet is doing its job by making this visible: it must only ever move
    // down for a stated reason, never because something quietly stopped working.
    expect(writes.size).toBeGreaterThanOrEqual(229)
  })
})

// ── S655 (money plan Step 8): the new parameters ─────────────────────────────
describe('the agent asks the credit question the screens ask', () => {
  const action = async (id: string) => {
    const { PORTAL_ACTIONS } = await import('./portalActions')
    const a = PORTAL_ACTIONS.find(x => x.id === id)
    expect(a, id).toBeTruthy()
    return a!
  }

  it('pay_my_balance carries the use-or-save answer and the credit figure it was quoted', async () => {
    const pay = await action('pay_my_balance')
    expect(Object.keys(pay.params)).toEqual(expect.arrayContaining(['useCredit', 'expectedCredit']))
    expect(pay.params.useCredit.type).toBe('boolean')
    expect(pay.params.expectedCredit.type).toBe('number')
    expect(pay.description).toMatch(/useCredit/)
    expect(pay.description).toMatch(/expectedCredit/)
  })

  // Fix pass 2: credit that pays the whole bill charges nothing, so the
  // assistant can take it for a tenant with no bank or card on file.
  it('pay_my_balance needs no saved method when the credit pays the whole bill', async () => {
    const pay = await action('pay_my_balance')
    expect(pay.required).toEqual(['amount'])
    expect(pay.params.paymentMethodId.description).toMatch(/Leave it out only when their credit pays the whole bill \(amount 0\)/)
  })

  it('get_payment_quote quotes the bill without an amount and takes the credit answer', async () => {
    const quote = await action('get_payment_quote')
    expect(quote.params.useCredit.type).toBe('boolean')
    expect(quote.required).toEqual(['method'])
    expect(quote.description).toMatch(/usableCredit/)
  })

  it('set_up_autopay can switch "use my account credit first", off unless asked', async () => {
    const autopay = await action('set_up_autopay')
    expect(autopay.params.useCredit.type).toBe('boolean')
    expect(autopay.required).not.toContain('useCredit')
  })

  it('record_cash_payment takes credit: use or save, and never requires it up front', async () => {
    const { getTool } = await import('./tools')
    const t = getTool('record_cash_payment')!
    const props = (t.parameters as any).properties
    expect(props.credit.description).toMatch(/"use"/)
    expect(props.credit.description).toMatch(/"save"/)
    expect((t.parameters as any).required).not.toContain('credit')
    expect(t.description).toMatch(/never decide for them/)
  })

})

// ── decisions #38 Q6 (Nic, 10/3): the assistant never checks a guest out ─────
describe('the agent cannot check a guest out', () => {
  const booking = async () => {
    const { PORTAL_ACTIONS } = await import('./portalActions')
    const a = PORTAL_ACTIONS.find(x => x.id === 'update_unit_booking')
    expect(a).toBeTruthy()
    return a!
  }

  it('update_unit_booking says it cannot check a guest out and sends them to the schedule', async () => {
    const b = await booking()
    expect(b.description).toMatch(/You cannot check a guest out/)
    expect(b.description).toMatch(/no money decision/)
    expect(b.description).toMatch(/check the guest out on the schedule/)
    expect(b.description).toMatch(/Once a stay has started you may only make it longer or change the details/)
  })

  it('checked_out is never offered as a status, and a departure date is never a way to record leaving early', async () => {
    const b = await booking()
    expect(b.params.status.description).toMatch(/Never checked_out/)
    expect(b.params.status.description).toMatch(/Never cancelled or no_show once the stay has started/)
    expect(b.params.status.description).not.toMatch(/left early is checked_out/)
    expect(b.params.checkOut.description).toMatch(/Never to record that a guest left early/)
    expect(b.params.checkOut.description).not.toMatch(/with status checked_out/)
  })

  it('no agent action anywhere tells the model how to check a guest out', async () => {
    const { PORTAL_ACTIONS } = await import('./portalActions')
    const offers = PORTAL_ACTIONS.filter(a => [a.description, ...Object.values(a.params).map(p => p.description)]
      .some(t => /left early is checked_out|status checked_out it is|checkOut = the day they left/i.test(t)))
    expect(offers.map(a => a.id)).toEqual([])
  })
})

// ── decisions #38 Q6, in code: the call is refused before it is sent ─────────
// The booking PATCH accepts a check-out from anyone holding "Check guests out",
// and the assistant calls it with the person's own token, so the words above
// alone do not stop one. update_unit_booking carries a refusal decided before
// anything is sent.
describe('update_unit_booking refuses a check-out before anything is sent', () => {
  const tools = async () => {
    const { db } = await import('../../db')
    const { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } = await import('../../test/dbHelpers')
    const { todayIn, addDaysTo } = await import('../../lib/timezone')
    const mod = await import('./portalActions')
    return { db, cleanupAllSchema, seedLandlord, seedProperty, seedUnit, todayIn, addDaysTo, ...mod }
  }
  beforeEach(async () => { await (await tools()).cleanupAllSchema() })

  async function stay(status: string, inDays: number, outDays: number) {
    const t = await tools()
    const c = await t.db.connect()
    try {
      const { userId, landlordId } = await t.seedLandlord(c)
      const propertyId = await t.seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
      const unitId = await t.seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
      await c.query(`UPDATE units SET unit_number = 'RV 07' WHERE id = $1`, [unitId])
      const otherUnitId = await t.seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
      await c.query(`UPDATE units SET unit_number = 'RV 09' WHERE id = $1`, [otherUnitId])
      // Another site with the same digits but a different prefix.
      const mhUnitId = await t.seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
      await c.query(`UPDATE units SET unit_number = 'MH 07' WHERE id = $1`, [mhUnitId])
      const today = t.todayIn('America/Phoenix')
      const r = await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
                                    nightly_rate, total_amount, status)
         VALUES ($1, $2, 'Pat Ruiz', 'nightly', $3::date, $4::date, $4::date - $3::date, 50,
                 50 * ($4::date - $3::date), $5)
         RETURNING id`,
        [landlordId, unitId, t.addDaysTo(today, inDays), t.addDaysTo(today, outDays), status])
      return { id: r.rows[0].id, unitId, otherUnitId, day: (n: number) => t.addDaysTo(today, n) }
    } finally { c.release() }
  }

  it('update_unit_booking carries the refusal', async () => {
    const { PORTAL_ACTIONS, refuseAgentCheckOut } = await tools()
    expect(PORTAL_ACTIONS.find(a => a.id === 'update_unit_booking')!.refuse).toBe(refuseAgentCheckOut)
  })

  it('the status Checked out is refused, however it is spelled', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    for (const status of ['checked_out', 'Checked out', 'CHECKED-OUT', 'checkedout']) {
      expect(await refuseAgentCheckOut({ bookingId: randomUUID(), status }), status).toBe(AGENT_CANNOT_CHECK_OUT)
    }
    expect(AGENT_CANNOT_CHECK_OUT).toMatch(/on the schedule/)
  })

  it('an early departure for a checked-in guest is refused: a day before the one booked, today, or earlier', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_in', -2, 5)
    for (const n of [2, 0, -1]) {
      expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(n) }), String(n)).toBe(AGENT_CANNOT_CHECK_OUT)
    }
  })

  it('a checked-in guest past their booked day cannot be given today as the day they left', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_in', -4, -1)
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(0) })).toBe(AGENT_CANNOT_CHECK_OUT)
  })

  it('a longer stay, a stay not started, a cancellation and a plain edit go through', async () => {
    const { refuseAgentCheckOut } = await tools()
    const inHouse = await stay('checked_in', -2, 5)
    expect(await refuseAgentCheckOut({ bookingId: inHouse.id, checkOut: inHouse.day(7) })).toBeNull()
    expect(await refuseAgentCheckOut({ bookingId: inHouse.id, notes: 'Gate code 4411' })).toBeNull()
    const future = await stay('confirmed', 10, 15)
    expect(await refuseAgentCheckOut({ bookingId: future.id, checkOut: future.day(12) })).toBeNull()
    expect(await refuseAgentCheckOut({ bookingId: future.id, status: 'cancelled' })).toBeNull()
    // A booking that cannot be found is the endpoint's to answer.
    expect(await refuseAgentCheckOut({ bookingId: randomUUID(), checkOut: inHouse.day(0) })).toBeNull()
  })

  // Fix pass (review): the refusal covered only a guest marked Checked in.
  // Each case below was let through and, sent to the booking PATCH, checks a
  // guest out, undoes or moves a check-out, or reprices a stay.
  it('a stay that is over: a new day they left is refused (the PATCH would reprice it to the nights stayed)', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_out', -5, -1)
    for (const n of [-3, -2, 0, 3]) {
      expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(n) }), String(n)).toBe(AGENT_CANNOT_CHECK_OUT)
    }
  })

  it('a stay that is over: any status is refused, so the agent never undoes or redoes a check-out', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_out', -5, -1)
    for (const status of ['checked_in', 'confirmed', 'tentative', 'cancelled', 'no_show']) {
      expect(await refuseAgentCheckOut({ bookingId: s.id, status }), status).toBe(AGENT_CANNOT_CHECK_OUT)
    }
  })

  it('a stay that is over: a new arrival day is refused (it reprices a finished stay)', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_out', -5, -1)
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(-4) })).toBe(AGENT_CANNOT_CHECK_OUT)
  })

  it('a stay that is over: the notes, the guest\u2019s details and the stored days sent back go through', async () => {
    const { refuseAgentCheckOut } = await tools()
    const s = await stay('checked_out', -5, -1)
    expect(await refuseAgentCheckOut({ bookingId: s.id, notes: 'Left the gate key in the box' })).toBeNull()
    expect(await refuseAgentCheckOut({ bookingId: s.id, guestPhone: '520-555-0100', guestEmail: 'pat@example.com' })).toBeNull()
    expect(await refuseAgentCheckOut({
      bookingId: s.id, checkIn: s.day(-5), checkOut: s.day(-1), guestName: 'Pat Ruiz',
    })).toBeNull()
  })

  it('a guest who arrived but was never marked checked in cannot be given an earlier or same-day check-out', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    for (const status of ['confirmed', 'tentative']) {
      const s = await stay(status, -2, 5)
      for (const n of [3, 0, -1]) {
        expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(n) }), `${status} ${n}`).toBe(AGENT_CANNOT_CHECK_OUT)
      }
      // A longer stay is still the agent's to make.
      expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(8) }), `${status} longer`).toBeNull()
    }
  })

  it('a stay whose arrival day is today counts as started', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('confirmed', 0, 4)
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(2) })).toBe(AGENT_CANNOT_CHECK_OUT)
    expect(await refuseAgentCheckOut({ bookingId: s.id, status: 'cancelled' })).toBe(AGENT_CANNOT_CHECK_OUT)
  })

  it('a stay in progress cannot be canceled or marked a no-show, however it is spelled', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    for (const booked of ['checked_in', 'confirmed']) {
      const s = await stay(booked, -2, 5)
      for (const status of ['cancelled', 'canceled', 'Cancelled', 'no_show', 'No-show', 'NO SHOW']) {
        expect(await refuseAgentCheckOut({ bookingId: s.id, status }), `${booked} ${status}`).toBe(AGENT_CANNOT_CHECK_OUT)
      }
    }
  })

  // Fix pass 2 (review): the arrival side was let through, and the booking
  // PATCH reprices a stay on its new, shorter nights.
  it('a checked-in guest\u2019s arrival day cannot be moved later (it shortens and reprices the stay)', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_in', -4, 5)
    for (const n of [-3, -1, 0, 2]) {
      expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(n) }), String(n)).toBe(AGENT_CANNOT_CHECK_OUT)
    }
    // Moving the whole stay later takes nights off its start too.
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(-2), checkOut: s.day(7) })).toBe(AGENT_CANNOT_CHECK_OUT)
  })

  it('a guest who arrived but was never marked checked in cannot have the arrival day moved later', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_CHECK_OUT } = await tools()
    for (const status of ['confirmed', 'tentative']) {
      const s = await stay(status, -2, 5)
      expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(1) }), status).toBe(AGENT_CANNOT_CHECK_OUT)
    }
  })

  it('an earlier arrival day for a stay that has started still goes through (it only adds nights)', async () => {
    const { refuseAgentCheckOut } = await tools()
    const s = await stay('checked_in', -2, 5)
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(-3) })).toBeNull()
    // The stored arrival day sent back with a save is no change.
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkIn: s.day(-2), notes: 'Late arrival' })).toBeNull()
    // A stay not started yet may be rescheduled either way.
    const future = await stay('confirmed', 10, 15)
    expect(await refuseAgentCheckOut({ bookingId: future.id, checkIn: future.day(12), checkOut: future.day(17) })).toBeNull()
  })

  // decisions.md #48.3: a re-price is a money decision (#38 Q6), and the PATCH
  // reprices a moved stay at the new site's rates.
  it('a stay that has started cannot be moved to another site; one not started can, and its own site sent back is no change', async () => {
    const { refuseAgentCheckOut, AGENT_CANNOT_MOVE_STARTED_STAY, AGENT_CANNOT_CHECK_OUT } = await tools()
    for (const booked of ['checked_in', 'confirmed']) {
      const s = await stay(booked, -2, 5)
      for (const unitId of [s.otherUnitId, 'RV 09', '9', 'spot 9', 'MH 07']) {
        expect(await refuseAgentCheckOut({ unitId, bookingId: s.id, notes: 'Water is off on 7' }), `${booked} ${unitId}`)
          .toBe(AGENT_CANNOT_MOVE_STARTED_STAY)
      }
      // Its own site, however the agent names it, is no move.
      for (const unitId of [s.unitId, 'RV 07', 'rv7', '7', 'spot 7', '#07']) {
        expect(await refuseAgentCheckOut({ unitId, bookingId: s.id, guestPhone: '520-555-0100' }), `${booked} ${unitId}`).toBeNull()
      }
      // A longer stay on its own site is still the agent's to make.
      expect(await refuseAgentCheckOut({ unitId: s.unitId, bookingId: s.id, checkOut: s.day(8) })).toBeNull()
    }
    // A stay that is over cannot be moved either.
    const over = await stay('checked_out', -5, -1)
    expect(await refuseAgentCheckOut({ unitId: over.otherUnitId, bookingId: over.id })).toBe(AGENT_CANNOT_CHECK_OUT)
    expect(await refuseAgentCheckOut({ unitId: over.unitId, bookingId: over.id, notes: 'ok' })).toBeNull()
    // A stay not started yet may be moved.
    const future = await stay('confirmed', 10, 15)
    expect(await refuseAgentCheckOut({ unitId: future.otherUnitId, bookingId: future.id })).toBeNull()
    expect(await refuseAgentCheckOut({ unitId: 'RV 09', bookingId: future.id })).toBeNull()
    expect(AGENT_CANNOT_MOVE_STARTED_STAY).toMatch(/on the schedule/)
  })

  // Fix pass 2 (review): the unit is named the way the dispatcher resolves it,
  // so a site named in words is the stay's own site, not a move.
  it('a site named in words ("Site A" for unit A, "Cabin Rose" for Rose) is no move: a notes edit on a started stay goes through', async () => {
    const t = await tools()
    const c = await t.db.connect()
    let ids: Record<string, string> = {}
    let landlordId = ''
    try {
      const seeded = await t.seedLandlord(c)
      landlordId = seeded.landlordId
      const propertyId = await t.seedProperty(c, { landlordId, ownerUserId: seeded.userId, managedByUserId: seeded.userId })
      for (const num of ['A', 'B', 'Rose']) {
        const id = await t.seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
        await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [id, num])
        ids[num] = id
      }
    } finally { c.release() }
    const book = async (unitId: string) => (await t.db.query<{ id: string }>(
      `INSERT INTO unit_bookings (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
                                  nightly_rate, total_amount, status)
       VALUES ($1, $2, 'Pat Ruiz', 'nightly', CURRENT_DATE - 2, CURRENT_DATE + 5, 7, 50, 350, 'checked_in')
       RETURNING id`, [landlordId, unitId])).rows[0].id
    const onA = await book(ids.A)
    const onRose = await book(ids.Rose)
    expect(await t.refuseAgentCheckOut({ unitId: 'Site A', bookingId: onA, notes: 'Gate code 4411' })).toBeNull()
    expect(await t.refuseAgentCheckOut({ unitId: 'a', bookingId: onA, guestPhone: '520-555-0100' })).toBeNull()
    expect(await t.refuseAgentCheckOut({ unitId: 'Cabin Rose', bookingId: onRose, notes: 'Late arrival' })).toBeNull()
    // Another site named in words is still a move.
    expect(await t.refuseAgentCheckOut({ unitId: 'Site B', bookingId: onA, notes: 'x' })).toBe(t.AGENT_CANNOT_MOVE_STARTED_STAY)
  })

  it('the update_unit_booking tool never offers to move a stay', async () => {
    const { PORTAL_ACTIONS } = await tools()
    const a = PORTAL_ACTIONS.find(x => x.id === 'update_unit_booking')!
    expect(a.description).not.toMatch(/move them to|is what unitId does/i)
    expect(a.description).toMatch(/cannot move a stay/i)
    expect(a.params.unitId.description).toMatch(/does not move the stay/)
  })

  it('a check-out day equal to the one stored is no change: an overdue guest\u2019s details save goes through', async () => {
    const { refuseAgentCheckOut } = await tools()
    const s = await stay('checked_in', -4, -1)
    expect(await refuseAgentCheckOut({ bookingId: s.id, checkOut: s.day(-1), guestPhone: '520-555-0100' })).toBeNull()
    // Checking a guest in is not a check-out.
    const arriving = await stay('confirmed', 0, 3)
    expect(await refuseAgentCheckOut({ bookingId: arriving.id, status: 'checked_in' })).toBeNull()
  })

  // 10/4 (decisions #38 Q6): the agent's real path (services/agents/
  // portalDispatch.ts) runs `action.refuse` before anything is sent, so a
  // check-out asked of the agent never reaches the booking PATCH.
  it('the agent\u2019s real dispatch refuses a check-out and sends nothing', async () => {
    const { dispatchPortalAction, __setTransport } = await import('./portalDispatch')
    const { AGENT_CANNOT_CHECK_OUT } = await tools()
    const s = await stay('checked_in', -2, 5)
    process.env.JWT_SECRET ||= 'test-secret'
    const sent: string[] = []
    __setTransport(async (url) => { sent.push(url); return { status: 200, json: { data: {} } } })
    try {
      const landlordId = randomUUID()
      const actor = {
        userId: 'u1', role: 'landlord', profileId: '', landlordIds: [landlordId],
        auth: { userId: 'u1', role: 'landlord', profileId: '', landlordIds: [landlordId], email: 'a@b.dev',
                permissions: { 'guests.check_out': true }, iat: 111, exp: 222 },
      } as any
      const r = await dispatchPortalAction('update_unit_booking',
        { unitId: randomUUID(), bookingId: s.id, status: 'checked_out' }, actor)
      expect(r).toMatchObject({ ok: false, error: AGENT_CANNOT_CHECK_OUT })
      expect(sent).toHaveLength(0)
    } finally { __setTransport(null) }
  })

  it('through the agent\u2019s real dispatch, a cancellation before arrival is still sent', async () => {
    const { dispatchPortalAction, __setTransport } = await import('./portalDispatch')
    const s = await stay('confirmed', 10, 15)
    process.env.JWT_SECRET ||= 'test-secret'
    const sent: { url: string; body: string }[] = []
    __setTransport(async (url, init: any) => { sent.push({ url, body: init.body }); return { status: 200, json: { data: {} } } })
    try {
      const landlordId = randomUUID()
      const actor = {
        userId: 'u1', role: 'landlord', profileId: '', landlordIds: [landlordId],
        auth: { userId: 'u1', role: 'landlord', profileId: '', landlordIds: [landlordId], email: 'a@b.dev',
                permissions: { 'schedule.edit_reservation': true }, iat: 111, exp: 222 },
      } as any
      const r = await dispatchPortalAction('update_unit_booking',
        { unitId: randomUUID(), bookingId: s.id, status: 'cancelled' }, actor)
      expect(r.ok).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].url).toContain(`/bookings/${s.id}`)
      expect(JSON.parse(sent[0].body)).toEqual({ status: 'cancelled' })
    } finally { __setTransport(null) }
  })
})
