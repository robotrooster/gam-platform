/**
 * ── COUNTING THE CASH DRAWER DOWN ───────────────────────────────────────────
 *
 * 10/30 (Nic, directive): "Make a bank deposit" was the wrong wording and the
 * wrong model. Staff count the drawer down to what it started with, so the
 * register zeroes out. The money pulled out then sits: "it's not worth the gas
 * to drive $100 to the bank when another $100 might come tomorrow." So ONE bank
 * deposit is often several days of drops.
 *
 * This file is the first stage only — the count, and the drop it produces.
 * Bundling drops into a bank deposit is a separate, later event and is not
 * modelled here on purpose.
 *
 * 10/31 (Nic), the shape:
 *   - a location can run several registers ("one he knows runs four");
 *   - two to three shifts a day, each with its own starting amount;
 *   - the starting amount is sayable by denomination, because "$200" handed
 *     over as two $100 bills cannot break a hundred for a $4 bag of ice;
 *   - every register's amount is set ON that register. Nothing inherits from a
 *     property or a company, and there is no platform default — GAM suggests
 *     $100 and a person confirms it ([[feedback-three-setting-levels]]).
 *
 * The word "float" appears nowhere a user can see it. Asked what it meant, Nic
 * had never heard it; the screens say "starting cash."
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────────
 *
 * A shift's expected cash counts the sales and refunds STAMPED to that shift.
 * Cash can also leave a drawer with no register sale behind it — an early
 * check-out handed back in cash from the paid-ahead screen, for instance. Those
 * have no shift and are not guessed at: they appear in the property's day
 * settlement (services/posEod), which keeps covering everything. A register's
 * count covers what went through that register. Those two numbers answer
 * different questions and neither absorbs the other.
 */
import type { PoolClient } from 'pg'
import { cashBreakdownTotalCents } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** The local calendar day at the property — the same day the settlement uses. */
async function businessDayAt(propertyId: string): Promise<string> {
  const r = await queryOne<{ day: string }>(
    `SELECT to_char((NOW() AT TIME ZONE COALESCE(timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS day
       FROM properties WHERE id = $1`, [propertyId])
  if (!r) throw new AppError(404, 'Property not found')
  return r.day
}

export interface ShiftMoney {
  openingCents:  number
  cashSalesCents: number
  cashRefundsCents: number
  expectedCents: number
}

/**
 * What this drawer should hold right now: what it started with, plus the cash it
 * took in on this shift, less the cash handed back out of it.
 *
 * A voided sale is excluded — nothing went in the drawer. (The property's day
 * settlement counts voided rows separately for its own reasons; a drawer only
 * cares what is physically in it.)
 */
export async function shiftMoney(shiftId: string, client?: PoolClient): Promise<ShiftMoney> {
  const q = client
    ? <T>(sql: string, p: any[]) => client.query(sql, p).then(r => r.rows[0] as T)
    : <T>(sql: string, p: any[]) => queryOne<T>(sql, p) as Promise<T>

  const shift = await q<{ opening_cash_cents: number }>(
    `SELECT opening_cash_cents FROM pos_register_shifts WHERE id = $1`, [shiftId])
  if (!shift) throw new AppError(404, 'That shift does not exist')

  const sales = await q<{ cents: string }>(
    `SELECT COALESCE(SUM(ROUND(total * 100)), 0)::text AS cents
       FROM pos_transactions
      WHERE register_shift_id = $1
        AND payment_method = 'cash'
        AND status <> 'voided'`, [shiftId])

  const refunds = await q<{ cents: string }>(
    `SELECT COALESCE(SUM(ROUND(r.amount * 100)), 0)::text AS cents
       FROM pos_refunds r
      WHERE r.register_shift_id = $1
        AND r.refund_method = 'cash'
        AND r.reversed_at IS NULL`, [shiftId])

  const openingCents = Number(shift.opening_cash_cents)
  const cashSalesCents = Number(sales.cents)
  const cashRefundsCents = Number(refunds.cents)
  return {
    openingCents, cashSalesCents, cashRefundsCents,
    expectedCents: openingCents + cashSalesCents - cashRefundsCents,
  }
}

/**
 * Open a shift on a register.
 *
 * REFUSES when the register has no confirmed starting cash. A guessed starting
 * amount makes every count after it meaningless, and Nic was explicit that
 * there is no platform default to fall back on — "it can suggest $100, but
 * nothing is set in stone. They would have to confirm it."
 */
export async function openShift(a: {
  registerId: string
  userId: string
}): Promise<{ id: string; openingCents: number; businessDay: string }> {
  const reg = await queryOne<{
    id: string; landlord_id: string; property_id: string; name: string
    status: string; starting_cash_cents: number | null; starting_cash_breakdown: any
  }>(`SELECT id, landlord_id, property_id, name, status, starting_cash_cents, starting_cash_breakdown
        FROM pos_registers WHERE id = $1`, [a.registerId])
  if (!reg) throw new AppError(404, 'That register does not exist')
  if (reg.status !== 'active') {
    throw new AppError(409, `${reg.name} has been retired. Pick another register, or bring that one back first.`)
  }
  if (reg.starting_cash_cents == null) {
    throw new AppError(409,
      `Nobody has set what stays in ${reg.name}'s drawer yet. Set the starting cash on the register first — `
      + `without it there is nothing to count down to.`)
  }

  const businessDay = await businessDayAt(reg.property_id)
  const tx = await getClient()
  try {
    await tx.query('BEGIN')
    // One open shift per register (ux_pos_register_shifts_one_open). Checked in
    // words first so the cashier gets a sentence instead of a constraint.
    const open = (await tx.query<{ id: string; who: string | null }>(
      `SELECT s.id, NULLIF(BTRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS who
         FROM pos_register_shifts s
         LEFT JOIN users u ON u.id = s.opened_by_user_id
        WHERE s.register_id = $1 AND s.status = 'open' FOR UPDATE OF s`, [a.registerId])).rows[0]
    if (open) {
      throw new AppError(409,
        `${open.who || 'Somebody'} still has a shift open on ${reg.name}. That shift has to be counted and `
        + `closed before another one starts — two people ringing into one drawer makes both counts meaningless.`)
    }
    // ── 10/31 (Nic): ONE DRAWER PER PERSON ─────────────────────────────────
    //
    //   "If I'm on the first register, that's it for the shift... Unless you go
    //    through the countdown process and you close it out back to default and
    //    then count in on a new register."
    //
    // The database refuses it too (ux_pos_register_shifts_one_per_person); this
    // is the same refusal said in words, naming the drawer they are already on,
    // because "insufficient permissions" or a constraint error tells somebody at
    // a counter nothing they can act on.
    const already = (await tx.query<{ name: string }>(
      `SELECT r.name FROM pos_register_shifts s JOIN pos_registers r ON r.id = s.register_id
        WHERE s.opened_by_user_id = $1 AND s.status = 'open'
        LIMIT 1`, [a.userId])).rows[0]
    if (already) {
      throw new AppError(409,
        `You are already on ${already.name}. Count that drawer down and close it before starting on `
        + `${reg.name} — the cash in a drawer has to be answerable by whoever was on it.`)
    }
    const made = (await tx.query<{ id: string }>(
      `INSERT INTO pos_register_shifts
         (register_id, landlord_id, property_id, business_day, status,
          opened_by_user_id, opening_cash_cents, opening_cash_breakdown)
       VALUES ($1, $2, $3, $4::date, 'open', $5, $6, $7)
       RETURNING id`,
      [reg.id, reg.landlord_id, reg.property_id, businessDay, a.userId,
       reg.starting_cash_cents, reg.starting_cash_breakdown ?? null])).rows[0]
    await tx.query('COMMIT')
    logger.info({ shiftId: made.id, registerId: reg.id, openingCents: reg.starting_cash_cents },
      '[drawer] shift opened')
    return { id: made.id, openingCents: Number(reg.starting_cash_cents), businessDay }
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {})
    throw e
  } finally { tx.release() }
}

export interface ClosedShift {
  id: string
  expectedCents: number
  countedCents: number
  varianceCents: number
  dropCents: number
}

/**
 * Count the drawer and close the shift.
 *
 * 10/31 (Nic): it ALWAYS closes. "The cashier can always finish their shift" —
 * nothing traps somebody at the end of a shift with money they cannot un-count.
 * Over the register's threshold it asks what happened first, while they still
 * remember; under it, a small difference simply records.
 *
 * The threshold is read from the register at CLOSE time rather than being
 * snapshotted, because it governs this conversation and nothing retroactive: a
 * shift that closed correctly under an older threshold is never revisited.
 */
export async function closeShift(a: {
  shiftId: string
  userId: string
  /** What was actually in the drawer. */
  countedCents: number
  /** Optional {denomination_cents: count}; its total must match countedCents. */
  countedBreakdown?: Record<string, number> | null
  varianceReason?: string | null
  notes?: string | null
}): Promise<ClosedShift> {
  if (!Number.isInteger(a.countedCents) || a.countedCents < 0) {
    throw new AppError(400, 'Enter what was in the drawer.')
  }
  if (a.countedBreakdown) {
    const fromDenoms = cashBreakdownTotalCents(a.countedBreakdown)
    if (fromDenoms !== a.countedCents) {
      throw new AppError(400,
        `The bills and coins add up to ${money(fromDenoms)}, but the total says ${money(a.countedCents)}. `
        + `Count it again — one of the two is wrong.`)
    }
  }

  const tx = await getClient()
  try {
    await tx.query('BEGIN')
    const shift = (await tx.query<{
      id: string; register_id: string; property_id: string; status: string
      business_day: string; register_name: string; threshold: number | null
    }>(`SELECT s.id, s.register_id, s.property_id, s.status,
               to_char(s.business_day, 'YYYY-MM-DD') AS business_day,
               r.name AS register_name, r.variance_reason_over_cents AS threshold
          FROM pos_register_shifts s
          JOIN pos_registers r ON r.id = s.register_id
         WHERE s.id = $1 FOR UPDATE OF s`, [a.shiftId])).rows[0]
    if (!shift) throw new AppError(404, 'That shift does not exist')
    if (shift.status !== 'open') {
      throw new AppError(409, `${shift.register_name}'s shift has already been counted and closed.`)
    }

    const m = await shiftMoney(a.shiftId, tx)
    const varianceCents = a.countedCents - m.expectedCents
    const dropCents = a.countedCents - m.openingCents

    const threshold = shift.threshold
    if (threshold != null && Math.abs(varianceCents) > threshold && !a.varianceReason?.trim()) {
      const short = varianceCents < 0
      throw new AppError(400,
        `The drawer is ${money(Math.abs(varianceCents))} ${short ? 'short' : 'over'} — it should hold `
        + `${money(m.expectedCents)} and you counted ${money(a.countedCents)}. Say what happened and it will `
        + `close. (Anything over ${money(threshold)} needs a note.)`)
    }

    await tx.query(
      `UPDATE pos_register_shifts
          SET status = 'closed', closed_at = NOW(), closed_by_user_id = $2,
              counted_cash_cents = $3, counted_cash_breakdown = $4,
              expected_cash_cents = $5, variance_cents = $6, drop_cents = $7,
              variance_reason = NULLIF(BTRIM(COALESCE($8, '')), ''),
              notes = NULLIF(BTRIM(COALESCE($9, '')), ''),
              updated_at = NOW()
        WHERE id = $1`,
      [a.shiftId, a.userId, a.countedCents, a.countedBreakdown ?? null,
       m.expectedCents, varianceCents, dropCents, a.varianceReason ?? null, a.notes ?? null])

    await rollUpDayDrawer(shift.property_id, shift.business_day, tx)
    await tx.query('COMMIT')
    logger.info({ shiftId: a.shiftId, expected: m.expectedCents, counted: a.countedCents,
                  variance: varianceCents, drop: dropCents }, '[drawer] shift counted and closed')
    return { id: a.shiftId, expectedCents: m.expectedCents, countedCents: a.countedCents,
             varianceCents, dropCents }
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {})
    throw e
  } finally { tx.release() }
}

/**
 * ── ONE ANSWER FOR WHAT WAS IN THE DRAWERS ──────────────────────────────────
 *
 * pos_eod_settlements has carried `opening_float` and `cash_drawer_actual` since
 * S95 and no screen could ever fill them, so every one of the live rows has a
 * float of 0.00 and a NULL actual. Now that shifts exist they are the ONLY
 * source for those two fields: the day's figure is the sum of the day's counted
 * shifts. Leaving the settlement to be filled in separately would be two places
 * computing the same answer, which is how they drift.
 *
 * Only CLOSED shifts count — an open drawer has not been counted. A day with no
 * registers has no closed shifts and the settlement is left exactly as it is,
 * which is what every property that never makes a register will do forever.
 */
async function rollUpDayDrawer(propertyId: string, businessDay: string, client: PoolClient): Promise<void> {
  const sums = (await client.query<{ n: string; opening: string; counted: string }>(
    `SELECT COUNT(*)::text AS n,
            COALESCE(SUM(opening_cash_cents), 0)::text AS opening,
            COALESCE(SUM(counted_cash_cents), 0)::text AS counted
       FROM pos_register_shifts
      WHERE property_id = $1 AND business_day = $2::date AND status = 'closed'`,
    [propertyId, businessDay])).rows[0]
  if (Number(sums.n) === 0) return
  await client.query(
    `UPDATE pos_eod_settlements
        SET opening_float = $3::numeric / 100,
            cash_drawer_actual = $4::numeric / 100,
            updated_at = NOW()
      WHERE property_id = $1 AND business_day = $2::date`,
    [propertyId, businessDay, sums.opening, sums.counted])
}

// ── WHERE DID THE MONEY GO? ──────────────────────────────────────────────────
//
// 10/31 (Nic): "There should be some sort of reconciliation built in to auto
// detect... maybe a ticket stayed open, or, you know, kind of generate a lead on
// where that money could possibly be... it's not likely you're going to — I
// mean, some people do have theft issues, but for the most part, you're going to
// have to trace your steps and find out where that money actually is. The bosses
// are going to want to know where that money went, not just that it's gone."
//
// So a variance is never reported bare. GAM looks at what happened during that
// shift and hands back the places the money could be, cheapest to check first.
//
// IT NEVER ACCUSES ANYBODY. Every lead is a thing that happened, with its
// amount and its time, and the cashier or the manager decides what it means. A
// drawer short by exactly the total of a ticket still sitting open is almost
// certainly that ticket; it is never called theft, and nothing here writes
// anything.
//
// The leads, in the order they are worth checking:
//
//   1. A CASH SALE IN THE WINDOW THAT WENT INTO ANOTHER DRAWER — or into none at
//      all. The commonest real cause and the most precisely detectable: a tablet
//      nobody claimed, or claimed as the wrong register. The money is in a till,
//      just not this one.
//   2. A TICKET LEFT OPEN. Goods walked out, nothing was collected. Nic's own
//      first guess, and it is checkable in seconds.
//   3. A VOIDED CASH SALE. The void may have come after the cash was already in
//      the drawer, or the goods already gone.
//   4. CASH HANDED BACK WITH NO SALE BEHIND IT during the window — an early
//      check-out paid out of the till.
//   5. CHANGE GIVEN THAT EXCEEDS THE SALE. A $20 taken for a $4 sale with $36
//      handed back is a keying slip, and it shows.
//
// An EXACT match to the variance is called out as such, because that is the one
// a person can stop looking after.

export interface VarianceLead {
  kind: 'other_drawer' | 'open_ticket' | 'voided_sale' | 'cash_back_no_sale' | 'change_over_sale'
  /** What this thing is worth, in cents. */
  amountCents: number
  /** True when it accounts for the whole difference on its own. */
  explainsItExactly: boolean
  /** Plain sentence for the screen. Never an accusation. */
  what: string
  when: string | null
  /** The row to go and look at. */
  ref: string | null
}

export async function varianceLeads(shiftId: string): Promise<VarianceLead[]> {
  const shift = await queryOne<{
    property_id: string; opened_at: string; closed_at: string | null; variance_cents: number | null
  }>(`SELECT property_id, opened_at, closed_at, variance_cents
        FROM pos_register_shifts WHERE id = $1`, [shiftId])
  if (!shift) throw new AppError(404, 'That shift does not exist')

  // An open shift is reconciled against now; a closed one against when it closed.
  const until = shift.closed_at ?? new Date().toISOString()
  const gap = shift.variance_cents == null ? 0 : Math.abs(shift.variance_cents)
  const exact = (cents: number) => gap > 0 && cents === gap
  const leads: VarianceLead[] = []

  // 1. Cash that went into another drawer, or none.
  const strays = await query<{ id: string; cents: string; at: string; shift_name: string | null }>(`
    SELECT t.id, ROUND(t.total * 100)::text AS cents, to_char(t.created_at, 'HH12:MI AM') AS at,
           r.name AS shift_name
      FROM pos_transactions t
      LEFT JOIN pos_register_shifts s ON s.id = t.register_shift_id
      LEFT JOIN pos_registers r ON r.id = s.register_id
     WHERE t.property_id = $1
       AND t.payment_method = 'cash' AND t.status <> 'voided'
       AND t.created_at >= $2::timestamptz AND t.created_at <= $3::timestamptz
       AND (t.register_shift_id IS NULL OR t.register_shift_id <> $4)
     ORDER BY t.created_at`, [shift.property_id, shift.opened_at, until, shiftId])
  for (const s of strays) {
    const cents = Number(s.cents)
    leads.push({
      kind: 'other_drawer', amountCents: cents, explainsItExactly: exact(cents),
      what: s.shift_name
        ? `A $${(cents / 100).toFixed(2)} cash sale at ${s.at} was rung into ${s.shift_name}, not this drawer.`
        : `A $${(cents / 100).toFixed(2)} cash sale at ${s.at} was not rung into any drawer — the register it `
          + `was rung on had no shift open.`,
      when: s.at, ref: s.id,
    })
  }

  // 2. A ticket still open.
  const tickets = await query<{ id: string; cents: string; at: string; note: string | null }>(`
    SELECT ot.id, ROUND(COALESCE((
             SELECT SUM((i->>'price')::numeric * COALESCE((i->>'qty')::numeric, 1))
               FROM jsonb_array_elements(ot.items) i), 0) * 100)::text AS cents,
           to_char(ot.created_at, 'HH12:MI AM') AS at, ot.note
      FROM pos_open_tickets ot
     WHERE ot.property_id = $1 AND ot.status = 'open'
       AND ot.created_at >= $2::timestamptz AND ot.created_at <= $3::timestamptz
     ORDER BY ot.created_at`, [shift.property_id, shift.opened_at, until])
  for (const t of tickets) {
    const cents = Number(t.cents)
    if (cents <= 0) continue
    leads.push({
      kind: 'open_ticket', amountCents: cents, explainsItExactly: exact(cents),
      what: `A ticket from ${t.at} is still open for $${(cents / 100).toFixed(2)}`
        + (t.note ? ` — "${t.note}".` : '. Nothing was collected on it.'),
      when: t.at, ref: t.id,
    })
  }

  // 3. A voided cash sale.
  const voided = await query<{ id: string; cents: string; at: string; why: string | null }>(`
    SELECT id, ROUND(total * 100)::text AS cents, to_char(created_at, 'HH12:MI AM') AS at, void_reason AS why
      FROM pos_transactions
     WHERE property_id = $1 AND payment_method = 'cash' AND status = 'voided'
       AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
     ORDER BY created_at`, [shift.property_id, shift.opened_at, until])
  for (const v of voided) {
    const cents = Number(v.cents)
    if (cents <= 0) continue
    leads.push({
      kind: 'voided_sale', amountCents: cents, explainsItExactly: exact(cents),
      what: `A $${(cents / 100).toFixed(2)} cash sale at ${v.at} was voided`
        + (v.why ? ` — "${v.why}".` : '.') + ` If the cash was already in the drawer it is still there.`,
      when: v.at, ref: v.id,
    })
  }

  // 4. Cash handed back with no register sale behind it.
  const handedBack = await query<{ id: string; cents: string; at: string }>(`
    SELECT rp.id, ROUND(rp.amount * 100)::text AS cents, to_char(rp.refunded_at, 'HH12:MI AM') AS at
      FROM stay_refund_parts rp
      LEFT JOIN unit_bookings b ON b.id = rp.booking_id
      LEFT JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
      LEFT JOIN leases pl ON pl.id = pc.lease_id
      JOIN units u ON u.id = COALESCE(b.unit_id, pl.unit_id)
     WHERE u.property_id = $1 AND rp.kind = 'cash' AND rp.status = 'handed_back'
       AND rp.pos_refund_id IS NULL
       AND rp.refunded_at >= $2::timestamptz AND rp.refunded_at <= $3::timestamptz
     ORDER BY rp.refunded_at`, [shift.property_id, shift.opened_at, until])
  for (const h of handedBack) {
    const cents = Number(h.cents)
    leads.push({
      kind: 'cash_back_no_sale', amountCents: cents, explainsItExactly: exact(cents),
      what: `$${(cents / 100).toFixed(2)} was handed back in cash at ${h.at} with no register sale behind it `
        + `— that came out of a till.`,
      when: h.at, ref: h.id,
    })
  }

  // 5. More change given than the sale was worth.
  const change = await query<{ id: string; cents: string; total: string; at: string }>(`
    SELECT id, ROUND(change_given * 100)::text AS cents, ROUND(total * 100)::text AS total,
           to_char(created_at, 'HH12:MI AM') AS at
      FROM pos_transactions
     WHERE register_shift_id = $1 AND change_given > total AND status <> 'voided'
     ORDER BY created_at`, [shiftId])
  for (const c of change) {
    const over = Number(c.cents) - Number(c.total)
    leads.push({
      kind: 'change_over_sale', amountCents: over, explainsItExactly: exact(over),
      what: `At ${c.at} a $${(Number(c.total) / 100).toFixed(2)} sale gave back `
        + `$${(Number(c.cents) / 100).toFixed(2)} in change — $${(over / 100).toFixed(2)} more than the sale.`,
      when: c.at, ref: c.id,
    })
  }

  // Exact matches first: those are the ones somebody can stop looking after.
  // Then biggest, because a big miss is where the money actually is.
  return leads.sort((a, b) =>
    Number(b.explainsItExactly) - Number(a.explainsItExactly) || b.amountCents - a.amountCents)
}
