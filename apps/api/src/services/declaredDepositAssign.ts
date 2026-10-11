// 10/6 (Nic) — which bank line is which tenant's reported deposit.
//
// Nic, 10/6: "the tenant logs into the portal and they say, hey, I deposited
// ... on this date at ... approximately this time ... GAM can match the
// transaction to something near that window because for people that pay the
// exact same amount, the probability that they're going to be in the bank at
// exactly the same time also kind of shrinks. And even if they're there within
// the same five minutes of each other, like if both payments are paid in full,
// then ... it doesn't matter if one person's cash and the other person's cash
// get swapped when it's at the same time. They're either both going to be late
// or they're both going to be on time."
//
// THE ONE MATCHER. Every place a bank line is tied to a tenant's report asks
// this file — the landlord's match screen (bankDepositCandidates), the bank
// feed's own steps (bankFeed.decideDeposit) and a landlord's confirm that did
// not name a report (bankDepositConfirm). It looks at ALL of a company's
// pending reports and ALL of its open money-in lines at once, because a line
// is only "this tenant's" in the light of the other reports and lines of the
// same amount.
//
// THE RULES:
//   - A candidate is a line of the EXACT reported amount whose posting the
//     report reaches by the existing date rules (bankDepositMatch
//     .declarationReaches: posted up to a week after the reported day, or a few
//     days before it). Same day or the next business day is honest; later is
//     the existing false-date path (the bank's date decides, the report is
//     flagged — services/depositBackdate).
//   - As many reports as possible get a line; then the best fit wins: the
//     line's own day equal to the reported day first, then a line the reported
//     day holds for (posted by the next business day), then the bank memo not
//     contradicting the instrument the tenant named, then the fewest days
//     apart, then — on a line whose own day is the reported day and that
//     carries a time — the nearest time to the hour the tenant picked.
//   - A time counts only when it FITS the hour picked (within an hour of
//     that hour's window — shared reportedTimeFits). A deposit stamped 9 AM
//     fits neither a 3 PM nor a 4 PM report: being an hour "less wrong" never
//     wins a line (10/6 review).
//   - A report a person UN-TIED from a line (the landlord's Undo of that
//     match) is never paired with that line again here: Undo means "not this
//     line". The landlord may still tie them by hand.
//   - When two ways of pairing fit equally well and every tenant ends up
//     with the same result either way (the same day counts, the same flag or
//     none), it does not matter who got which line: the earliest report takes
//     the earliest line, and so on in order.
//   - A REAL conflict is never decided here. It goes to the landlord's match
//     screen with each report's date, hour, reference and photo, and the
//     landlord picks:
//       · two reports claiming one line with nothing to tell them apart;
//       · lines of the amount on different days where who gets which one
//         changes who paid late — the bank's times never settle this one:
//         who is late is the landlord's pick (the 10/6 spec);
//       · one line equal to what two or more residents reported together.
//     A time difference decides only when it holds whatever the lines with no
//     time actually were — a line with no time is never assumed to fit.
//
// The verdict is computed fresh each time (nothing is stored): a conflict
// that the next bank sync resolves — the second deposit posts, and both
// tenants are on time either way — simply stops being one.

import {
  bankLineDateTime, reportedTimeGapMinutes, reportedTimeFits, reportConflictText, declaredDateHolds,
  type ReportConflictKind,
} from '@gam/shared'
import { declarationReaches, methodContradicts, daysApart } from './bankDepositMatch'
import { effectivePaidDateFor, declaredDateIsFalse } from './depositBackdate'

/** A pending report, as the matcher reads it. */
export interface ReportToAssign {
  id: string
  leaseId: string
  tenantId: string
  amount: number
  declaredDate: string
  /** The hour the tenant picked (8–18); null for after hours or a report made before the time was asked. */
  hour: number | null
  afterHours: boolean
  method: 'cash' | 'check' | 'money_order'
  /** When the report was made — the order ties are assigned in. */
  createdAt: string
}

/** An open money-in bank line, as the matcher reads it. */
export interface LineToAssign {
  id: string
  amount: number
  postedDate: string
  description: string | null
  /**
   * Reports a person un-tied from this line (the landlord's Undo of a
   * report-confirmed match, auto_settle_undo.was.declarationId): never paired
   * with it again by the matcher.
   */
  untiedReportIds?: readonly string[]
}

export interface ReportConflict {
  kind: ReportConflictKind
  reportIds: string[]
  lineIds: string[]
  /** The landlord's card, in plain words (shared reportConflictText). */
  text: string
}

export type LineVerdict =
  | { kind: 'assigned'; reportId: string }
  | { kind: 'conflict'; conflict: ReportConflict }

export interface ReportAssignment {
  /** Lines with a verdict. A line with none has no report reaching it. */
  lines: Map<string, LineVerdict>
  /** Reports with a verdict. A report with none waits for its deposit. */
  reports: Map<string, { lineId: string } | { conflict: ReportConflict }>
}

const cents = (n: number) => Math.round(Number(n) * 100)

// Cost weights, integers so every sum is exact. Each tier outweighs everything
// below it summed over the largest component the matcher solves (MAX_SIDE).
const MAX_SIDE = 30
const W_TIME_MAX = 1440
const W_GAP_DAYS = 100_000            // > 30 × 1440
const W_CONTRA = 10_000_000           // > 30 × 11 days × W_GAP_DAYS
const W_DAY_RANK = 1_000_000_000      // > 30 × W_CONTRA
const K_MATCH = 1_000_000_000_000     // > 30 × 2 × W_DAY_RANK: as many matched as possible first
const FORBID = 100_000_000_000_000
/** A line with no time, judged neutrally (half a day either way). */
const NEUTRAL_TIME = 720

interface Edge {
  r: number; l: number
  dayRank: number; contra: number; gapDays: number
  /** Minutes from the hour picked, on a line whose own day is the reported day; null: nothing to compare. */
  time: number | null
  /** The time fits the hour picked (shared reportedTimeFits) — only then is it a reason to win the line. */
  fits: boolean
  /** What the tenant ends up with on this line: the day that counts, and whether it is flagged. */
  outcome: string
}

/** The minimum-cost assignment of rows (reports) to columns (lines + one "no line" per report). */
function hungarian(cost: number[][]): number[] {
  const n = cost.length
  const m = cost[0]?.length ?? 0
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0)
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(m + 1).fill(Infinity)
    const used = new Array(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity, j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const ans = new Array(n).fill(-1)
  for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1
  return ans
}

interface Component { reports: number[]; lines: number[]; edges: Edge[] }

/**
 * Solve one component. `edgeCost(e)` prices an edge (FORBID to rule it out);
 * `noLine(r)` false forces report r onto some line. Returns the pairing
 * (report index → line index, or -1) and its total, or null when no pairing
 * meets the constraints.
 */
function solve(
  c: Component, edgeCost: (e: Edge) => number, noLine: (r: number) => boolean,
): { pick: Map<number, number>; total: number } | null {
  const R = c.reports, L = c.lines
  const col = new Map(L.map((l, j) => [l, j]))
  const row = new Map(R.map((r, i) => [r, i]))
  const cost = R.map(() => new Array(L.length + R.length).fill(FORBID))
  for (const e of c.edges) cost[row.get(e.r)!][col.get(e.l)!] = Math.min(cost[row.get(e.r)!][col.get(e.l)!], edgeCost(e))
  R.forEach((r, i) => { if (noLine(r)) for (let k = 0; k < R.length; k++) cost[i][L.length + k] = 0 })
  const ans = hungarian(cost)
  let total = 0
  const pick = new Map<number, number>()
  for (let i = 0; i < R.length; i++) {
    const j = ans[i]
    const c0 = cost[i][j]
    if (c0 >= FORBID / 2) return null
    total += c0
    pick.set(R[i], j < L.length ? L[j] : -1)
  }
  return { pick, total }
}

const baseCost = (e: Edge) => -K_MATCH + e.dayRank * W_DAY_RANK + e.contra * W_CONTRA + e.gapDays * W_GAP_DAYS

/**
 * Pair reports with bank lines (pure). See the header for the rules.
 */
export function assignReportsToLines(
  reportsIn: readonly ReportToAssign[], linesIn: readonly LineToAssign[],
): ReportAssignment {
  const out: ReportAssignment = { lines: new Map(), reports: new Map() }
  // Reports in the order they were made; lines in the order the money went in.
  const reports = [...reportsIn].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const when = new Map(linesIn.map(l => [l.id, bankLineDateTime(l.description, l.postedDate)]))
  const lineDay = (l: LineToAssign) => when.get(l.id)!.date ?? l.postedDate
  const lines = [...linesIn].sort((a, b) =>
    lineDay(a).localeCompare(lineDay(b))
    || (when.get(a.id)!.minutes ?? 9999) - (when.get(b.id)!.minutes ?? 9999)
    || a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id))

  // Every pairing a report could have: the exact amount, within the date rules.
  const edges: Edge[] = []
  reports.forEach((r, ri) => lines.forEach((l, li) => {
    if (cents(r.amount) !== cents(l.amount) || !(cents(l.amount) > 0)) return
    if (!declarationReaches(r.declaredDate, l.postedDate)) return
    // 10/6 review: Undo means "not this line" for the matcher too.
    if (l.untiedReportIds?.includes(r.id)) return
    const day = lineDay(l)
    const dayRank = day === r.declaredDate ? 0
      : (r.declaredDate <= l.postedDate && declaredDateHolds(r.declaredDate, l.postedDate)) ? 1 : 2
    const minutes = when.get(l.id)!.minutes
    const time = day === r.declaredDate ? reportedTimeGapMinutes(r, minutes) : null
    edges.push({
      r: ri, l: li, dayRank,
      contra: methodContradicts(r.method, l.description) ? 1 : 0,
      gapDays: daysApart(r.declaredDate, day),
      time, fits: reportedTimeFits(time),
      outcome: `${effectivePaidDateFor(r.declaredDate, l.postedDate)}|${declaredDateIsFalse(r.declaredDate, l.postedDate) ? 'flag' : 'ok'}`,
    })
  }))

  // Components: reports and lines joined by a possible pairing.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let y = x
    while (parent.get(y) !== y) y = parent.get(y)!
    parent.set(x, y)
    return y
  }
  const node = (k: string) => { if (!parent.has(k)) parent.set(k, k); return k }
  for (const e of edges) {
    const a = find(node(`r${e.r}`)), b = find(node(`l${e.l}`))
    if (a !== b) parent.set(a, b)
  }
  const comps = new Map<string, Component>()
  for (const e of edges) {
    const k = find(`r${e.r}`)
    let c = comps.get(k)
    if (!c) { c = { reports: [], lines: [], edges: [] }; comps.set(k, c) }
    c.edges.push(e)
    if (!c.reports.includes(e.r)) c.reports.push(e.r)
    if (!c.lines.includes(e.l)) c.lines.push(e.l)
  }

  const conflictOf = (c: Component, kind: ReportConflictKind): ReportConflict => ({
    kind,
    reportIds: c.reports.map(i => reports[i].id),
    lineIds: c.lines.map(i => lines[i].id),
    text: reportConflictText({
      kind,
      reports: c.reports.map(i => ({
        amount: reports[i].amount, declaredDate: reports[i].declaredDate, tenantId: reports[i].tenantId,
      })),
      deposits: c.lines.map(i => ({ amount: lines[i].amount, postedDate: lines[i].postedDate })),
    }),
  })
  const markConflict = (cf: ReportConflict) => {
    for (const id of cf.lineIds) out.lines.set(id, { kind: 'conflict', conflict: cf })
    for (const id of cf.reportIds) out.reports.set(id, { conflict: cf })
  }

  for (const c of comps.values()) {
    c.reports.sort((a, b) => a - b)
    c.lines.sort((a, b) => a - b)
    const kindIfConflict = (): ReportConflictKind =>
      c.lines.length < c.reports.length ? 'fewer_deposits'
        : new Set(c.lines.map(i => lines[i].postedDate)).size > 1 ? 'who_is_late' : 'no_difference'
    if (c.reports.length > MAX_SIDE || c.lines.length > MAX_SIDE) { markConflict(conflictOf(c, kindIfConflict())); continue }

    // A time that does not fit the hour picked is no better than no time.
    const neutral = (e: Edge) => baseCost(e) + (e.fits ? e.time! : NEUTRAL_TIME)
    const best = solve(c, neutral, () => true)
    if (!best) continue
    // Is the best pairing certain? Priced against itself: its own lines with no
    // time — or a time that does not fit — count as the worst fit, every other
    // line with no time as a perfect one (a time known to be off counts as
    // what it is). Any other way of pairing that gives some tenant a different
    // result and still costs no more is a real conflict.
    const inBest = new Set(c.edges.filter(e => best.pick.get(e.r) === e.l).map(e => `${e.r}:${e.l}`))
    const adverse = (e: Edge) => baseCost(e) + (inBest.has(`${e.r}:${e.l}`)
      ? (e.fits ? e.time! : W_TIME_MAX)
      : (e.time ?? 0))
    const bestAdverse = c.edges.filter(e => inBest.has(`${e.r}:${e.l}`)).reduce((s, e) => s + adverse(e), 0)
    // 10/6 spec: which line on which day is whose, when that changes who paid
    // late, is never settled by the bank's times — priced without them.
    const bestNoTime = c.edges.filter(e => inBest.has(`${e.r}:${e.l}`)).reduce((s, e) => s + baseCost(e), 0)
    const outcomeOf = (r: number, l: number) =>
      l < 0 ? 'none' : c.edges.find(e => e.r === r && e.l === l)!.outcome
    let conflict = false
    for (const r of c.reports) {
      const mine = outcomeOf(r, best.pick.get(r)!)
      const classes = new Set([...c.edges.filter(e => e.r === r).map(e => e.outcome), 'none'])
      for (const o of classes) {
        if (o === mine) continue
        // Another LINE's result for this tenant (a different day counts, or a
        // flag): a who-is-late question, times set aside. Waiting for a
        // deposit of their own instead ('none') may still be told by a time.
        const whoIsLate = mine !== 'none' && o !== 'none'
        const price = whoIsLate ? baseCost : adverse
        const alt = solve(c,
          e => (e.r === r && e.outcome !== o) ? FORBID : price(e),
          x => x !== r || o === 'none')
        if (alt && alt.total <= (whoIsLate ? bestNoTime : bestAdverse)) { conflict = true; break }
      }
      if (conflict) break
    }
    if (conflict) { markConflict(conflictOf(c, kindIfConflict())); continue }

    // Certain. When several pairings fit equally well, every tenant's result
    // is the same either way: the earliest report takes the earliest line.
    let pick = best.pick
    if (c.reports.length > 1 || c.lines.length > 1) {
      const fixed = new Map<number, number>()
      const taken = new Set<number>()
      for (const r of c.reports) {
        if (best.pick.get(r)! < 0) continue
        for (const l of c.lines) {
          if (taken.has(l) || !c.edges.some(e => e.r === r && e.l === l)) continue
          const tryFix = new Map([...fixed, [r, l]])
          const fixedLines = new Set(tryFix.values())
          const alt = solve(c,
            e => tryFix.has(e.r) ? (tryFix.get(e.r) === e.l ? neutral(e) : FORBID)
              : fixedLines.has(e.l) ? FORBID : neutral(e),
            x => !tryFix.has(x))
          if (alt && alt.total <= best.total) { fixed.set(r, l); taken.add(l); break }
        }
      }
      // Never fewer pairings than the best (it cannot be, but never trust it blind).
      if ([...fixed.values()].length === [...best.pick.values()].filter(x => x >= 0).length) {
        pick = new Map(c.reports.map(r => [r, fixed.get(r) ?? -1]))
      }
    }
    for (const [r, l] of pick) {
      if (l < 0) continue
      out.lines.set(lines[l].id, { kind: 'assigned', reportId: reports[r].id })
      out.reports.set(reports[r].id, { lineId: lines[l].id })
    }
  }

  // One deposit equal to what two or more residents reported together (each
  // report not already paired with a deposit of its own) is never matched by
  // GAM: the landlord picks whose bills it pays.
  for (const l of lines) {
    const pool = reports
      .filter(r => !out.reports.has(r.id) && cents(r.amount) < cents(l.amount) && cents(r.amount) > 0
        && declarationReaches(r.declaredDate, l.postedDate) && !l.untiedReportIds?.includes(r.id))
      .sort((a, b) => daysApart(a.declaredDate, l.postedDate) - daysApart(b.declaredDate, l.postedDate)
        || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 16)
    if (pool.length < 2) continue
    const target = cents(l.amount)
    let found: ReportToAssign[] | null = null
    for (let mask = 1; mask < (1 << pool.length); mask++) {
      let bits = 0, sum = 0
      for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) { bits++; sum += cents(pool[i].amount) }
      if (bits < 2 || sum !== target) continue
      const pickd = pool.filter((_, i) => mask & (1 << i))
      if (!found || pickd.length < found.length) found = pickd
    }
    if (!found) continue
    const single = out.lines.get(l.id)
    const singleId = single?.kind === 'assigned' ? single.reportId : null
    const cf: ReportConflict = {
      kind: 'combined',
      reportIds: [...(singleId ? [singleId] : []), ...found.map(r => r.id)],
      lineIds: [l.id],
      text: reportConflictText({
        kind: 'combined',
        reports: found.map(r => ({ amount: r.amount, declaredDate: r.declaredDate, tenantId: r.tenantId })),
        deposits: [{ amount: l.amount, postedDate: l.postedDate }],
      }) + (singleId ? ' Another resident also reported this whole amount — if it is theirs, pick them below.' : ''),
    }
    if (single?.kind === 'conflict') continue // already the landlord's to pick
    if (singleId) out.reports.delete(singleId)
    markConflict(cf)
  }
  return out
}

/** Anything that can run a query — the pool, or a client inside a transaction. */
type Runner = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }

/** The landlord's "Not a rent payment" mark (bankDepositCandidates.NOT_RENT_MARK). */
const NOT_RENT = 'notRent'

/**
 * Read a company's pending reports and open money-in lines and pair them. The
 * lines: waiting for review, money in, not voided, not filed, not matched to
 * anything, not set aside by the landlord as "Not a rent payment", posted
 * where some pending report could reach them.
 */
export async function loadReportAssignment(
  runner: Runner, landlordId: string,
  o: {
    /**
     * A line to pair as well, when it is not among the open lines read (a
     * line being ranked on its own, before it is stored in review).
     */
    alsoLine?: LineToAssign
  } = {},
): Promise<ReportAssignment> {
  const reports = (await runner.query(
    `SELECT d.id, d.lease_id, d.tenant_id, d.amount::float AS amount,
            to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
            d.declared_hour, d.declared_after_hours, d.method,
            to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM tenant_declared_deposits d
      WHERE d.landlord_id = $1 AND d.status = 'pending'`, [landlordId])).rows.map((r: any): ReportToAssign => ({
    id: r.id, leaseId: r.lease_id, tenantId: r.tenant_id, amount: Number(r.amount),
    declaredDate: r.declared_date, hour: r.declared_hour == null ? null : Number(r.declared_hour),
    afterHours: r.declared_after_hours === true, method: r.method, createdAt: r.created_at,
  }))
  if (reports.length === 0) return { lines: new Map(), reports: new Map() }
  const days = reports.map(r => r.declaredDate).sort()
  const lines = (await runner.query(
    `SELECT t.id, t.amount::float AS amount, to_char(t.posted_date,'YYYY-MM-DD') AS posted_date, t.description,
            -- 10/6 review: the report a landlord's Undo un-tied from this line.
            t.auto_settle_undo -> 'was' ->> 'declarationId' AS untied_report_id
       FROM bank_transactions t
      WHERE t.landlord_id = $1 AND t.status = 'needs_review' AND t.amount > 0
        AND COALESCE(t.bank_status, 'posted') <> 'void'
        AND t.expense_id IS NULL AND t.landlord_other_income_id IS NULL
        AND t.matched_payment_id IS NULL AND t.matched_disbursement_id IS NULL
        AND NOT (COALESCE(t.auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT}')
        AND t.posted_date BETWEEN ($2::date - 7) AND ($3::date + 7)`,
    [landlordId, days[0], days[days.length - 1]])).rows.map((r: any): LineToAssign => ({
    id: r.id, amount: Number(r.amount), postedDate: r.posted_date, description: r.description ?? null,
    untiedReportIds: r.untied_report_id ? [r.untied_report_id] : [],
  }))
  if (o.alsoLine && !lines.some(l => l.id === o.alsoLine!.id)) lines.push(o.alsoLine)
  return assignReportsToLines(reports, lines)
}
