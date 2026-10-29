// S624 — where a work-trade tenant actually stands, in hours.
//
// Nic (S623): the next invoice must state "both the new month's hours owed and
// the hours still owed from the carried balance." A tenant who is told only
// "80 hours" when they actually need 100 to get straight has been told the least
// useful true thing available.
//
// And the landlord's side (Nic, S624): "at some point, a landlord's gonna know
// that somebody's never gonna be able to physically catch up. There's just not
// that many hours in a month." That judgment should not require arithmetic in
// someone's head, so `catchUpHours` is stated plainly and `catchUpPlausible`
// says whether a human could actually work it.

import { round2h } from './workTradeSettlement'
import { round2 } from './workTradeCredit'

export interface CarriedPeriod {
  periodMonth: string
  hoursOutstanding: number
  hourRate: number
  /** Further closes this period may still survive before it is billed. */
  closesRemaining: number
}

export interface WorkTradeStanding {
  /** Hours the CURRENT month asks for on its own. */
  currentMonthHours: number
  /** Hours still owed from earlier months. */
  carriedHours: number
  /** Everything owed: current + carried, less anything banked. */
  catchUpHours: number
  /** Hours already worked ahead. */
  bankedHours: number
  /**
   * What the carried hours would cost in cash if the agreement ended today —
   * each period at its own frozen rate.
   *
   * S643 (Nic, DIRECTIVE): NULL for the tenant. "Don't show the tenant any sort
   * of hourly rate — that's when they decide it's not worth it. They're bad at
   * calculation, some people think they're getting three dollars an hour in rent
   * but they forget all the conveniences they get along the way."
   *
   * A dollar figure printed beside an hour count IS an hourly rate; it is one
   * division away. The landlord still gets it — they are pricing an arrangement
   * and need to know what a shortfall is worth.
   */
  carriedValue: number | null
  /**
   * Is `catchUpHours` something a person could actually work this month?
   *
   * A deliberately generous ceiling: 12 hours a day, every day. Anything above
   * it is not a tenant who is behind, it is an arrangement that has failed, and
   * the landlord should be told so rather than left to discover it when the
   * leniency window finally closes.
   */
  catchUpPlausible: boolean
  /** The soonest month a carried deficit gets billed, if nothing changes. */
  nextBillingMonth: string | null
  /**
   * 10/19 (Nic) — NO HOURS ARE BEING COUNTED, BECAUSE THE SPACE IS EMPTY.
   *
   * True only for a PAUSED agreement whose landlord answered that the space is
   * not being used. Everything above it then reads zero, which is correct and
   * also completely silent about why, so the sentence has to say it: a tenant
   * away for the season should read that hours have stopped, not a clean
   * "you're fully covered" they cannot tell apart from having worked.
   *
   * The landlord and the tenant read this same field, so neither can be told a
   * different story about the same space (routes/workTrade serves one standing
   * to both).
   */
  hoursNotCounted: boolean
  /**
   * 10/19 (Nic, "Show it while paused") — IS THIS TRADE PAUSED RIGHT NOW?
   *
   * Said out loud rather than left for a reader to infer from a pile of zeros,
   * because the tenant portal's work-trade tab now stays up while a trade is
   * paused and every surface on it reads this one standing. Nic's answer to
   * whether a paused trade should be visible at all: show it while paused, and
   * say plainly which situation they are in.
   */
  paused: boolean
  /**
   * Are any hours being counted right now? FALSE when the landlord does not
   * clock this trade at all (tracks_hours), and when it is paused with the
   * space empty. The same question the month close asks (hoursCountedSql), so
   * nobody can be shown a target the close is about to waive.
   */
  hoursCounted: boolean
  /** One sentence for the invoice. Never a raw enum, never bare numbers. */
  summary: string
  /**
   * 10/12 (Nic): hours worked beyond what a month and any carried shortfall
   * needed — banked or paid, per the agreement. Filled by loadWorkTradeStanding.
   */
  extraHours?: ExtraHoursStanding
}

/** One month's extra hours, as a close recorded them. */
export interface ExtraHoursEntry {
  periodMonth: string
  hours: number
  /** banked — toward future months; paid — paid separately by the landlord. */
  how: 'banked' | 'paid'
  /**
   * PAID extra hours only. Nic, 10/12: the tenant sees the rate and amount for
   * paid EXTRA hours ("6 extra hours × $15 = $90"). Banked hours never carry a
   * dollar figure, and neither do the trade hours (S643).
   */
  rate: number | null
  amount: number | null
  /** PAID extra hours only: unpaid, sent_to_books or paid. */
  status: string | null
}

export interface ExtraHoursStanding {
  /** What this agreement does with extra hours now. */
  mode: 'bank' | 'pay'
  /** Newest first — the last six closes that recorded any. */
  recent: ExtraHoursEntry[]
  /** The newest entry as one sentence, or null when there is none. */
  summary: string | null
}

function monthName(periodMonth: string): string {
  return DateTime.fromISO(periodMonth).toFormat('LLLL')
}

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * "6 extra hours in September — banked" / "6 extra hours in September × $15.00
 * = $90.00 — paid separately by your landlord". The PAID wording names a rate
 * because those hours are wages; it is the only place a work-trade hour is
 * ever priced for the tenant, and it prices only hours beyond the trade.
 */
export function extraHoursSentence(e: ExtraHoursEntry): string {
  const n = Number.isInteger(e.hours) ? String(e.hours) : e.hours.toFixed(2).replace(/0$/, '')
  const h = `${n} extra ${e.hours === 1 ? 'hour' : 'hours'} in ${monthName(e.periodMonth)}`
  if (e.how === 'banked' || e.rate == null || e.amount == null) return `${h} — banked toward future months`
  return `${h} × ${money(e.rate)} = ${money(e.amount)} — paid separately by your landlord`
}

/** Days in the month a period-month string names. */
function daysInMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const MAX_WORKABLE_HOURS_PER_DAY = 12

export function workTradeStanding(input: {
  currentMonth: string
  currentMonthTarget: number
  currentMonthApplied: number
  carried: CarriedPeriod[]
  bankedHours: number
  /** Who is reading. Defaults to the landlord's full view. */
  audience?: 'tenant' | 'landlord'
  /**
   * 10/19: the agreement is paused and the landlord said the space is empty, so
   * no hours are being counted. Everything else is already zero by then — this
   * is what lets the sentence say why.
   */
  hoursNotCounted?: boolean
  /** 10/19: the agreement is paused. Hours may or may not still be counting. */
  paused?: boolean
  /**
   * 10/19: the landlord's answer to "while this is paused, is the space still
   * being used?" — TRUE still used, FALSE empty, NULL nobody has been asked.
   * Only shapes the sentence; what it does to the money is already decided by
   * `hoursCounted` / `hoursNotCounted` (hoursCountedSql, read at the close too).
   */
  spaceOccupied?: boolean | null
  /** 10/19: are hours being counted at all? Defaults to yes. */
  hoursCounted?: boolean
  /**
   * 10/19 (review): does this month have a settlement period open at all? The
   * billing run only opens one for a RUNNING agreement, so a month billed while
   * the trade is paused has none — and every figure then reads zero for want of
   * a period rather than because anybody worked. Omitted means "do not claim
   * either way", which is what every caller before this did.
   */
  currentMonthOpen?: boolean
}): WorkTradeStanding {
  const currentMonthHours = Math.max(0,
    round2h(input.currentMonthTarget - input.currentMonthApplied))
  const carriedHours = round2h(
    input.carried.reduce((s, c) => s + Math.max(0, c.hoursOutstanding), 0))
  const banked = round2h(Math.max(0, input.bankedHours))
  const catchUpHours = Math.max(0, round2h(currentMonthHours + carriedHours - banked))
  const carriedValue = round2(
    input.carried.reduce((s, c) => s + Math.max(0, c.hoursOutstanding) * c.hourRate, 0))

  const ceiling = daysInMonth(input.currentMonth) * MAX_WORKABLE_HOURS_PER_DAY
  const catchUpPlausible = catchUpHours <= ceiling

  // The carried period closest to the end of its window is the one that bills
  // first. `closesRemaining` is 0 when this coming close is its last.
  const soonest = [...input.carried]
    .filter(c => c.hoursOutstanding > 0)
    .sort((a, b) => a.closesRemaining - b.closesRemaining)[0] ?? null

  const forTenant = input.audience === 'tenant'
  const hoursNotCounted = input.hoursNotCounted === true
  const paused = input.paused === true
  // A trade whose hours have stopped is not counting them, whichever switch
  // stopped them. A caller that says nothing is a counting trade, which is what
  // every work trade was before either switch existed.
  const hoursCounted = input.hoursCounted !== false && !hoursNotCounted
  return {
    currentMonthHours, carriedHours, catchUpHours, bankedHours: banked,
    carriedValue: forTenant ? null : carriedValue,
    catchUpPlausible,
    nextBillingMonth: soonest && soonest.closesRemaining < Number.MAX_SAFE_INTEGER ? soonest.periodMonth : null,
    hoursNotCounted,
    paused,
    hoursCounted,
    summary: summarize({
      currentMonthHours, carriedHours, catchUpHours, banked, carriedValue, forTenant,
      hoursNotCounted, paused, hoursCounted, spaceOccupied: input.spaceOccupied ?? null,
      currentMonthOpen: input.currentMonthOpen,
    }),
  }
}

function hrs(n: number): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
  return `${s} ${n === 1 ? 'hour' : 'hours'}`
}

/**
 * 10/19 (Nic, "Show it while paused") — THE SENTENCE A SNOWBIRD MOST NEEDS.
 *
 * Paused, and hours ARE still counting: the month still asks for its hours, and
 * the part nobody worked is still owed on that month's own bill. That is exactly
 * what the close does (jobs/workTradeSettlement, CLOSE_STATUSES — "hours keep
 * counting, and a lapse is owed on its own month's bill"), so the sentence has
 * to say it. Without this the figures that follow are word-for-word a running
 * agreement's, and somebody who has been told their trade is "paused" reads them
 * as a target nobody is holding them to — and then gets a bill.
 *
 * What pausing DOES change is only the aging: a paused shortfall never runs out
 * of leniency, so while it stays paused it is never written off into a separate
 * cash charge and the trade is never ended over it (carryMonthsFor). The hours
 * stay owed, which is what the figures below are for.
 */
function pausedPrefix(x: { paused?: boolean; spaceOccupied?: boolean | null }): string {
  if (!x.paused) return ''
  return x.spaceOccupied === true
    ? 'This work trade is paused, but the space is still being used, so your hours keep counting. '
    : 'This work trade is paused, and your hours keep counting until your landlord '
      + 'says whether the space is still being used. '
}

/**
 * 10/19 (review) — WHAT A PAUSE DOES TO A BILL, SAID ONLY AS FAR AS IT IS TRUE.
 *
 * The first draft of these sentences promised "the charges it covers are not
 * billed while it is paused". That is true of the months ALREADY BILLED under
 * the trade: their settlement periods are open, the month close reads the live
 * answer rather than the number the period froze (jobs/workTradeSettlement
 * loadOpenPeriods), and a month that asks for no hours is covered outright and
 * settles.
 *
 * It is NOT true of a month billed DURING the pause. The billing run asks for an
 * ACTIVE agreement (services/workTradeCredit loadWorkTradeCreditContext), so
 * while a trade is paused it opens no settlement period for the new month,
 * suspends nothing, and the bill goes out at its full amount and late-fee
 * eligible. That state used to be unreachable — a pause only ever came from
 * lease hibernation (which bills nothing) or a lease expiring (which bills
 * nothing more) — and the landlord's new "Pause this agreement" button reaches
 * it on the first click, with the lease left running.
 *
 * Whether a month billed during a pause SHOULD be covered is a money decision
 * and Nic's to make, so it is a question for him rather than something assumed
 * here. Until he answers, neither side of the trade is told a promise the
 * billing run does not keep.
 */
const PAUSED_ALREADY_BILLED = 'The months already billed under it are covered at the next month close.'
const PAUSED_NEW_BILLS = 'A bill that goes out while it stays paused is not covered by the trade.'

function summarize(x: {
  currentMonthHours: number; carriedHours: number; catchUpHours: number
  banked: number; carriedValue: number; forTenant?: boolean
  hoursNotCounted?: boolean
  paused?: boolean; hoursCounted?: boolean; spaceOccupied?: boolean | null
  currentMonthOpen?: boolean
}): string {
  // Is there anything open for "already billed" to be about? A month billed
  // while the trade was running has a period; one billed during the pause has
  // none. Said only when there is something to say it about.
  const already = x.currentMonthOpen === false && x.carriedHours === 0
    ? '' : PAUSED_ALREADY_BILLED + ' '
  // 10/19 (Nic): the trade is paused and the space is empty, so "there would be
  // no reason for it to continue to track hours." Say that, rather than the
  // "you're fully covered" below — true, and indistinguishable from a month
  // somebody actually worked. What follows is the standing rule that work-trade
  // coverage is never turned into a debt — the months already billed under it
  // settle rather than being owed — and then the one thing a pause does NOT do,
  // because the billing run leaves a paused agreement out (PAUSED_NEW_BILLS).
  if (x.hoursNotCounted) {
    return 'This work trade is paused and the space is empty, so no hours are '
      + 'being counted. ' + already + PAUSED_NEW_BILLS
  }
  // 10/19 (Nic, "Show it while paused"): a paused trade the landlord does not
  // clock at all. No hours are being counted here either, and for a longer-
  // standing reason than an empty space — so it gets its own sentence rather
  // than the one above, which would claim something about the space nobody has
  // said. The close treats the two identically (hoursCountedSql), and this is
  // the same thing the window says in its own words.
  if (x.paused && x.hoursCounted === false) {
    return 'This work trade is paused, and no hours are counted on it either way. '
      + already + PAUSED_NEW_BILLS
  }
  const paused = pausedPrefix(x)
  // 10/19 (review): a month billed while the trade is paused has no settlement
  // period at all, so every figure here reads zero for want of one — and
  // "You're fully covered for this month" about a bill that went out at its
  // full amount is the one sentence a paused tenant must never read. The
  // figures below are about the months that DO have periods; this says plainly
  // that the new one is not among them.
  const nothingNewCovered = x.paused === true && x.currentMonthOpen === false
  if (x.currentMonthHours === 0 && x.carriedHours === 0) {
    if (nothingNewCovered) return paused + PAUSED_NEW_BILLS
    return paused + (x.banked > 0
      ? `You're fully covered, with ${hrs(x.banked)} worked ahead.`
      : `You're fully covered for this month.`)
  }
  if (x.carriedHours === 0) {
    const ahead = x.banked > 0 ? ` (${hrs(x.banked)} banked already counts toward it.)` : ''
    return `${paused}${hrs(x.currentMonthHours)} covers this month.${ahead}`
  }
  // The case the whole thing exists for: say BOTH numbers, and the total.
  const ahead = x.banked > 0 ? ` ${hrs(x.banked)} banked comes off that.` : ''
  // S643: the tenant's version carries no dollar figure. Hours beside dollars is
  // an hourly rate whether or not it is labeled one, and the tenant page's own
  // language is fractions of the bill for exactly that reason. They are still
  // told plainly that an unworked hour becomes a balance — just not priced.
  const cost = x.forTenant ? '' : ` — $${x.carriedValue.toFixed(2)} if it isn't worked`
  // Nothing new to cover, so there is no "this month" figure to state — only
  // what is still owed from the months that were billed while it was running.
  if (nothingNewCovered) {
    return `${paused}${PAUSED_NEW_BILLS} ${hrs(x.carriedHours)} is still owed from earlier${cost}.${ahead}`
  }
  return `${paused}${hrs(x.currentMonthHours)} covers this month, and ${hrs(x.carriedHours)} ` +
    `is still owed from earlier${cost}. ` +
    `${hrs(x.catchUpHours)} in total gets you straight.${ahead}`
}

// ── loading it from the ledger ──────────────────────────────────────────────

import { query, queryOne } from '../db'
import { DateTime } from 'luxon'

/**
 * 10/19 (Nic) — IS THIS TRADE COUNTING HOURS RIGHT NOW? One expression, read by
 * the month close, by this file, and by the agreement's end.
 *
 * Two things can switch counting off, and they are both the landlord's call:
 *
 *   tracks_hours = false  the trade is not clocked at all (S637). Its months are
 *                         covered outright.
 *   not running, and the space is empty  Nic, 10/19: "if somebody wants to work
 *                         more hours in the winter but leave their camper
 *                         occupying the space in the summer, that's one
 *                         situation. If people take their camper home for the
 *                         summer with them and it's not occupying the spot, then
 *                         there would be no reason for it to continue to track
 *                         hours."
 *
 * An unanswered pause (NULL) counts hours, which is what every paused agreement
 * does today: a column arriving must not move anybody's bill on its own.
 *
 * "Not running" is paused OR ended, and the second half is load-bearing: the
 * landlord's end-by-hand path settles the agreement AFTER writing status =
 * 'ended' (routes/workTrade), so reading 'paused' alone would bill a dormant
 * trade's open month in cash on the way out — for a season the tenant had been
 * told plainly nobody was counting. A stale answer cannot leak into a running
 * agreement: the trigger in migration 20261021150000 forgets it the moment the
 * trade goes back to active.
 *
 * Why this is read at QUERY time and not stored on the period: the landlord can
 * change their mind any day — "a camper can leave later" — and `target_hours` is
 * a snapshot taken when the month's bill was written. The same reasoning as the
 * 10/18 tracks_hours fix, and it is what makes the answer reversible: flip it
 * back and the stored target is there untouched.
 *
 * Read through `to_jsonb` for the same reason EXTRA_HOURS_COLS does: migrations
 * reach the live database before the code that needs them, and a month close
 * must never stop because a column is not there yet. COALESCE to 'true' is
 * load-bearing — without it an absent column makes the whole expression NULL,
 * which reads as false, which would silently stop counting hours everywhere.
 */
export function hoursCountedSql(wta = 'wta'): string {
  return `(${wta}.tracks_hours AND NOT (${wta}.status IN ('paused','ended')
            AND COALESCE(to_jsonb(${wta})->>'paused_space_occupied', 'true') = 'false'))`
}

/** The same rule as a column, for a query that hands the answer to TypeScript. */
export const HOURS_COUNTED_COL = `${hoursCountedSql('wta')} AS hours_counted`

/**
 * 10/19 (review) — A PAUSED TRADE IS ONLY "LIVE" WHILE THE TENANCY IS.
 *
 * Showing a paused agreement to the tenant and to both assistants was the right
 * call (Nic: "show it while paused"), but `status IN ('active','paused')` on its
 * own brings MOVED-OUT tenancies back. A lease reaching its end_date with no
 * signed successor pauses every active work-trade agreement on the unit
 * (jobs/scheduler — its own comment: "work trade is rent-for-labor — it can't
 * outlive the tenancy"), and nothing ever moves that row on to 'ended'. So a
 * month after moving out the former resident's Work Trade tab came back, their
 * assistant answered "your hours keep counting", and the landlord's roster
 * listed a space nobody lives on as a live agreement.
 *
 * 'ended' was the status the widening deliberately left out; a move-out produces
 * 'paused', which is the gap. The honest test is not the status word but whether
 * the tenancy is still there — so that is what this asks, and ONLY of a paused
 * row. An ACTIVE agreement is left exactly as every one of these call sites read
 * it before, because narrowing the widening is the fix; re-deciding what
 * "active" means is not.
 *
 * A tenancy is live when either rail under it is:
 *   - a LEASE: the tenant is still on an active lease for that unit.
 *     Hibernation keeps both (routes/leases sets is_hibernating on an ACTIVE
 *     lease and leaves lease_tenants alone), so a snowbird's paused trade still
 *     shows — which is the whole point of showing paused ones. 'pending_remove'
 *     counts as still on it: somebody part-way through being taken off a lease
 *     still lives there, and the lease-end processor treats the two together.
 *   - a STAY: the agreement hangs off a booking (10/6, services/stayWorkTrade)
 *     and may have no lease at all, so a live booking counts on its own.
 *
 * `wta` is the alias the caller gave the agreements table.
 */
export function liveTenancySql(wta = 'wta'): string {
  return `(${wta}.status <> 'paused' OR EXISTS (
            SELECT 1 FROM lease_tenants lt
              JOIN leases l ON l.id = lt.lease_id
             WHERE lt.tenant_id = ${wta}.tenant_id
               AND lt.status IN ('active','pending_remove')
               AND l.unit_id = ${wta}.unit_id AND l.status = 'active')
          OR EXISTS (
            SELECT 1 FROM unit_bookings b
             WHERE b.id = ${wta}.booking_id
               AND b.status IN ('tentative','confirmed','checked_in')
               AND b.check_out >= CURRENT_DATE))`
}

/**
 * The same rule again, for a caller that already holds the agreement row
 * (`SELECT wta.*`) and would otherwise re-derive it and get it subtly different.
 * A row loaded before migration 20261021150000 has no answer on it at all, which
 * reads as the space still being used — the same default the SQL applies.
 */
export function hoursCountedFor(a: {
  tracks_hours?: boolean | null; status?: string | null
  paused_space_occupied?: boolean | null
}): boolean {
  if (a.tracks_hours === false) return false
  const dormant = a.status === 'paused' || a.status === 'ended'
  return !(dormant && a.paused_space_occupied === false)
}

/**
 * 10/19: is the answer's column there yet? The migration lands before this
 * code, but a landlord must never get a 500 in the window where it has not —
 * and the close and the standing cope on their own (hoursCountedSql).
 */
let pausedOccupancySeen = false
export async function pausedOccupancySchemaReady(q: { query: Function } = { query }): Promise<boolean> {
  if (pausedOccupancySeen) return true
  const out = await q.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'work_trade_agreements'
                       AND column_name = 'paused_space_occupied') AS ready`, [])
  const rows = Array.isArray(out) ? out : out?.rows ?? []
  pausedOccupancySeen = rows[0]?.ready === true
  return pausedOccupancySeen
}

/**
 * Assemble the standing for one agreement as of `asOfMonth` (ISO first-of-month;
 * defaults to the current month in Phoenix, which is where the settlement cron
 * runs).
 *
 * The CURRENT month is the period whose invoice is open right now. Anything
 * older that is still open is carried. A period already `settled` or `billed`
 * is finished with and contributes nothing.
 */
export async function loadWorkTradeStanding(
  agreementId: string, asOfMonth?: string,
  audience: 'tenant' | 'landlord' = 'landlord',
): Promise<WorkTradeStanding | null> {
  const month = asOfMonth
    ?? DateTime.now().setZone('America/Phoenix').startOf('month').toISODate()!

  const ag = await queryOne<{ banked_hours: string; carry_forward_months: number
                              carry_forward_indefinite: boolean; hours_counted: boolean
                              status: string; tracks_hours: boolean
                              space_answer: string | null }>(
    `SELECT wta.banked_hours, wta.carry_forward_months, wta.carry_forward_indefinite,
            wta.status, wta.tracks_hours, ${HOURS_COUNTED_COL},
            -- 10/19: the landlord's answer to the pause question, for the
            -- SENTENCE (what it does to the money is already in hours_counted).
            -- Read through to_jsonb for the reason hoursCountedSql is: the
            -- migration that adds the column reaches the live database before
            -- this code does, and nobody may get a 500 in that window. No
            -- answer reads as "nobody has been asked", which is what a freshly
            -- paused agreement is.
            to_jsonb(wta)->>'paused_space_occupied' AS space_answer
       FROM work_trade_agreements wta WHERE wta.id = $1`, [agreementId])
  if (!ag) return null
  // 10/19: hours have STOPPED, as against a trade that never counted them. A
  // tracks_hours = false agreement already reads zero everywhere and says so in
  // its own words ("No hours are tracked on this agreement"); this sentence is
  // for the snowbird whose hours were counting last month and are not now.
  //
  // PAUSED, and only paused. hoursCountedSql deliberately reads 'ended' too —
  // the end-by-hand path writes the status before it settles — and migration
  // 20261021150000 deliberately KEEPS the space answer through paused → ended,
  // so an ENDED trade whose last pause said "they took the camper home" also
  // answers "no hours counted". Both of those are right for the money and wrong
  // for the sentence: "This work trade is paused and the space is empty... The
  // charges it covers are not billed while it is paused" is a promise about a
  // state the agreement is no longer in, told to a tenant and a landlord who
  // read the same standing (routes/workTrade serves one to both). An ended
  // trade says what every ended trade has always said.
  const hoursNotCounted = ag.status === 'paused'
    && ag.hours_counted === false && ag.tracks_hours !== false

  const rows = await query<any>(
    `SELECT to_char(ws.period_month,'YYYY-MM-DD') AS period_month,
            -- 10/19: THE AGREEMENT SAYS WHETHER HOURS COUNT, not the number the
            -- period froze when its bill was written. The landlord can turn
            -- tracking off any day — Nic did, on 10/01 — and the month close
            -- reads it off the agreement from then on (jobs/workTradeSettlement
            -- loadOpenPeriods). Read the snapshot instead and the tenant is told
            -- "80 hours covers this month, and 80 hours is still owed from
            -- earlier" about a month the close is about to cover outright, and
            -- the landlord is quoted a price for the same phantom hours. A
            -- tenant seeing one number and a landlord seeing another is how a
            -- work-trade argument starts (routes/workTrade); a tenant and the
            -- close disagreeing is worse, and it stands for a month.
            --
            -- 10/19 (Nic): and a PAUSED trade whose space is empty asks for
            -- none either — "if people take their camper home for the summer
            -- with them and it's not occupying the spot, then there would be no
            -- reason for it to continue to track hours." One expression
            -- (hoursCountedSql) answers both, here and at the close, so the
            -- tenant can never be shown a target the close is about to waive.
            (CASE WHEN ${hoursCountedSql()} THEN ws.target_hours ELSE 0 END)::float AS target_hours,
            (CASE WHEN ${hoursCountedSql()} THEN ws.hour_rate    ELSE 0 END)::float AS hour_rate,
            ws.hours_applied::float AS hours_applied,
            -- Closes this period has already survived. Mirrors the settlement
            -- job's derivation exactly so the two can never disagree about when
            -- something bills.
            GREATEST(0, (DATE_PART('year',  $2::date) - DATE_PART('year',  ws.period_month)) * 12
                      + (DATE_PART('month', $2::date) - DATE_PART('month', ws.period_month)) - 1
            )::int AS aged_closes
       FROM work_trade_settlements ws
       JOIN work_trade_agreements wta ON wta.id = ws.agreement_id
      WHERE ws.agreement_id = $1 AND ws.status = 'open' AND ws.period_month <= $2::date
      ORDER BY ws.period_month`,
    [agreementId, month])

  const current = rows.find((r: any) => r.period_month === month)
  const carried: CarriedPeriod[] = rows
    .filter((r: any) => r.period_month !== month)
    .map((r: any) => ({
      periodMonth: r.period_month,
      hoursOutstanding: Math.max(0, round2h(Number(r.target_hours) - Number(r.hours_applied))),
      hourRate: Number(r.hour_rate),
      // S652: floated indefinitely — no close ever bills it.
      closesRemaining: ag.carry_forward_indefinite ? Number.MAX_SAFE_INTEGER : Math.max(0,
        Number(ag.carry_forward_months) - Number(r.aged_closes)),
    }))
    .filter(c => c.hoursOutstanding > 0)

  const standing = workTradeStanding({
    currentMonth: month,
    currentMonthTarget: current ? Number(current.target_hours) : 0,
    currentMonthApplied: current ? Number(current.hours_applied) : 0,
    carried,
    bankedHours: Number(ag.banked_hours),
    audience,
    hoursNotCounted,
    // 10/19 (Nic, "Show it while paused"): the tenant portal shows a paused
    // agreement now, so the standing every surface on it reads has to say the
    // trade is paused and which of the two situations it is.
    paused: ag.status === 'paused',
    hoursCounted: ag.hours_counted !== false,
    spaceOccupied: ag.space_answer == null ? null : ag.space_answer === 'true',
    // 10/19 (review): whether this month was billed under the trade at all. The
    // billing run skips a paused agreement, so a month billed during a pause has
    // no period and nothing above it is a statement about coverage.
    currentMonthOpen: !!current,
  })
  return { ...standing, extraHours: await loadExtraHours(agreementId) }
}

/**
 * 10/12: the extra hours the month closes recorded for this agreement — banked
 * (hours only) and paid (hours, rate, amount). The same for both audiences: the
 * rate shown is the one the landlord pays for EXTRA hours, never what a trade
 * hour is worth, and banked entries carry no money at all.
 */
export async function loadExtraHours(agreementId: string): Promise<ExtraHoursStanding> {
  // A database without the extra-hours migrations has never banked or paid an
  // extra hour: say so, rather than fail the standing (the /standing route and
  // both agents' tools read this).
  if (!(await extraHoursSchemaReady())) return { mode: 'bank', recent: [], summary: null }
  // 10/19: "hours beyond what the agreement needs" means nothing while no hours
  // are being counted at all — a paused trade on an empty space asks for none,
  // so none can be beyond it. Same rule as the close (extraHoursMode).
  const ag = await queryOne<{ mode: string | null; hours_counted: boolean }>(
    `SELECT wta.extra_hours_mode AS mode, ${HOURS_COUNTED_COL}
       FROM work_trade_agreements wta WHERE wta.id = $1`, [agreementId])
  const banked = await query<{ period_month: string; hours: number }>(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period_month, extra_hours_banked::float AS hours
       FROM work_trade_settlements
      WHERE agreement_id = $1 AND extra_hours_banked > 0
      ORDER BY period_start DESC LIMIT 6`, [agreementId])
  const paid = await query<{ period_month: string; hours: number; rate: number; amount: number; status: string }>(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period_month, hours::float AS hours,
            rate::float AS rate, amount::float AS amount, status
       FROM work_trade_extra_hours
      WHERE agreement_id = $1
      ORDER BY period_start DESC, created_at DESC LIMIT 6`, [agreementId])
  const recent: ExtraHoursEntry[] = [
    ...banked.map(b => ({ periodMonth: b.period_month, hours: round2h(Number(b.hours)), how: 'banked' as const,
                          rate: null, amount: null, status: null })),
    ...paid.map(p => ({ periodMonth: p.period_month, hours: round2h(Number(p.hours)), how: 'paid' as const,
                        rate: round2(Number(p.rate)), amount: round2(Number(p.amount)), status: p.status })),
  ].sort((a, b) => b.periodMonth.localeCompare(a.periodMonth)).slice(0, 6)
  return {
    mode: ag?.mode === 'pay' && ag.hours_counted !== false ? 'pay' : 'bank',
    recent,
    summary: recent.length ? extraHoursSentence(recent[0]) : null,
  }
}

let extraHoursSchemaSeen = false

/**
 * 10/12: are the three extra-hours migrations (20261012180000–180200) applied?
 * Migrations reach the live database before the code that needs them
 * (expand, then contract), but a month close and the standing must never stop
 * over a setting if they have not: the close then banks as it always did and
 * writes no extra-hours record, and the standing reports none. Read from the
 * catalog; a yes is remembered (a schema does not lose them), a no is asked
 * again next time.
 */
export async function extraHoursSchemaReady(q: { query: Function } = { query }): Promise<boolean> {
  if (extraHoursSchemaSeen) return true
  const out = await q.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public'
                AND ((table_name = 'work_trade_agreements'
                      AND column_name IN ('extra_hours_mode', 'extra_hours_rate', 'extra_hours_pay_method'))
                  OR (table_name = 'work_trade_settlements' AND column_name = 'extra_hours_banked'))) = 4
            AND to_regclass('public.work_trade_extra_hours') IS NOT NULL AS ready`, [])
  const rows = Array.isArray(out) ? out : out?.rows ?? []
  extraHoursSchemaSeen = rows[0]?.ready === true
  return extraHoursSchemaSeen
}
