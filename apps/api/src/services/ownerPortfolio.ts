/**
 * S645 — THE OWNER'S WHOLE PORTFOLIO, IN ONE PLACE, WITH THE MANAGERS SIDE BY SIDE.
 *
 * Nic (S645, DIRECTIVE): "If I'm managing part of an owner's portfolio and a
 * different property manager is managing the other part, the owner portal can
 * still see ALL of their properties... I don't want to have to log in to see
 * half my properties and log into a different thing to see the other half. But
 * then each property manager only sees what's scoped to them."
 *
 * And the reason it matters to him, which is what makes this a scorecard rather
 * than a list: "I want to be able to do side-by-side comparison on who's filling
 * vacancies faster, who's handling evictions promptly, who's collecting on time
 * — just different metrics to compare between property management companies."
 *
 * So: one call, every property the account owns, grouped by who runs it — with
 * SELF-MANAGED as a group of its own, because an owner comparing two managers
 * usually wants to know how their own half is doing too.
 *
 * WHAT IS MEASURED, AND WHY NOT EVICTIONS. Collection timeliness and vacancy
 * both come from records the platform actually keeps: a rent charge knows when
 * it was due and when it settled, and a lease knows when it started and what it
 * followed. Evictions do not. `leases.termination_reason` is free text and
 * `lease_notices` is a generic title/body — there is no structured legal action
 * with stages and dates, so any "eviction promptness" number would be invented.
 * It is reported as unavailable rather than guessed. Building it properly means
 * modelling a legal action (notice served → filed → hearing → writ → possession),
 * and those stages differ by state, which is a design question and not a query.
 *
 * SCOPE. Everything here is filtered to the entities the ACCOUNT owns. A manager
 * never reaches this code — their view is the per-company routes, which is the
 * other half of Nic's sentence.
 */

import { query } from '../db'
import { round2 } from './workTradeCredit'

export interface ManagerScorecard {
  /** null for the properties the owner runs themselves. */
  pmCompanyId: string | null
  pmCompanyName: string
  propertyCount: number
  unitCount: number
  occupiedUnits: number
  vacantUnits: number
  occupancyPct: number | null
  /**
   * Of the rent that came due in the window, the share that settled on or
   * before its due date. null when nothing was due — an empty month is not a
   * 0% score, and showing one would libel a manager with no rent roll yet.
   */
  onTimeRatePct: number | null
  rentDueCount: number
  /** Average days between due date and settlement, late payments only. */
  avgDaysLate: number | null
  /**
   * Average days a unit sat empty between one lease ending and the next
   * beginning, over the window. null when no unit turned over.
   */
  avgDaysToFill: number | null
  turnovers: number
  /** Not measurable yet — see the header. Always null, never a zero. */
  evictionsResolved: null
  properties: Array<{ propertyId: string; propertyName: string; unitCount: number }>
}

export interface OwnerPortfolio {
  /** ISO dates of the window the rates were measured over. */
  windowStart: string
  windowEnd: string
  managers: ManagerScorecard[]
  totals: { propertyCount: number; unitCount: number; occupiedUnits: number }
  /** Said out loud so a screen never has to invent a reason for a null. */
  notMeasured: string[]
}

const SELF_MANAGED = 'Self-managed'

/**
 * Build the portfolio view for one account's entities.
 *
 * `months` is how far back the rate metrics look. A single month is too noisy
 * to judge a manager on — one resident paying late swings a small park's
 * on-time rate by twenty points — so the default is a year.
 */
export async function ownerPortfolio(opts: {
  landlordIds: string[]
  months?: number
}): Promise<OwnerPortfolio> {
  const months = opts.months ?? 12
  if (opts.landlordIds.length === 0) {
    return {
      windowStart: '', windowEnd: '', managers: [],
      totals: { propertyCount: 0, unitCount: 0, occupiedUnits: 0 },
      notMeasured: [],
    }
  }

  const rows = await query<any>(
    `WITH scope AS (
       SELECT p.id, p.name, p.pm_company_id
         FROM properties p
        WHERE p.landlord_id = ANY($1::uuid[])
     ),
     window_bounds AS (
       SELECT (date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int))::date AS w_start,
              CURRENT_DATE AS w_end
     ),
     unit_counts AS (
       SELECT u.property_id,
              COUNT(*)::int AS unit_count,
              COUNT(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM leases l
                   WHERE l.unit_id = u.id AND l.status = 'active'
                )
              )::int AS occupied
         FROM units u
         JOIN scope s ON s.id = u.property_id
        GROUP BY u.property_id
     ),
     rent AS (
       -- Collection timeliness. Only RENT, and only charges that actually came
       -- due in the window: a manager is judged on the rent they were
       -- responsible for collecting, not on fees or one-off charges.
       SELECT u.property_id,
              COUNT(*)::int AS due_count,
              COUNT(*) FILTER (
                WHERE pay.settled_at IS NOT NULL
                  AND pay.settled_at::date <= pay.due_date
              )::int AS on_time_count,
              AVG(
                CASE WHEN pay.settled_at IS NOT NULL
                       AND pay.settled_at::date > pay.due_date
                     THEN (pay.settled_at::date - pay.due_date) END
              )::float AS avg_days_late
         FROM payments pay
         JOIN units u ON u.id = pay.unit_id
         JOIN scope s ON s.id = u.property_id
        CROSS JOIN window_bounds wb
        WHERE pay.type = 'rent'
          AND pay.status NOT IN ('failed', 'returned')
          AND pay.due_date >= wb.w_start AND pay.due_date <= wb.w_end
        GROUP BY u.property_id
     ),
     turns AS (
       -- How long a space sat empty. For every lease that STARTED in the window,
       -- how many days passed since the previous lease on that same unit ended.
       -- A unit's first-ever lease has nothing to measure against and is
       -- excluded rather than counted as zero.
       SELECT property_id,
              COUNT(*)::int AS turnovers,
              AVG(gap)::float AS avg_days_to_fill
         FROM (
           SELECT u.property_id,
                  (l.start_date - LAG(COALESCE(l.terminated_at::date, l.end_date))
                      OVER (PARTITION BY l.unit_id ORDER BY l.start_date)) AS gap,
                  l.start_date
             FROM leases l
             JOIN units u ON u.id = l.unit_id
             JOIN scope s ON s.id = u.property_id
         ) g
        CROSS JOIN window_bounds wb
        WHERE g.gap IS NOT NULL AND g.gap >= 0
          AND g.start_date >= wb.w_start AND g.start_date <= wb.w_end
        GROUP BY property_id
     )
     SELECT s.id AS property_id, s.name AS property_name, s.pm_company_id,
            c.name AS pm_company_name,
            COALESCE(uc.unit_count, 0) AS unit_count,
            COALESCE(uc.occupied, 0)   AS occupied,
            COALESCE(r.due_count, 0)   AS due_count,
            COALESCE(r.on_time_count, 0) AS on_time_count,
            r.avg_days_late,
            COALESCE(t.turnovers, 0)   AS turnovers,
            t.avg_days_to_fill,
            (SELECT w_start::text FROM window_bounds) AS w_start,
            (SELECT w_end::text   FROM window_bounds) AS w_end
       FROM scope s
       LEFT JOIN pm_companies c ON c.id = s.pm_company_id
       LEFT JOIN unit_counts uc ON uc.property_id = s.id
       LEFT JOIN rent r        ON r.property_id  = s.id
       LEFT JOIN turns t       ON t.property_id  = s.id
      ORDER BY c.name NULLS FIRST, s.name`,
    [opts.landlordIds, months])

  // Fold the per-property rows up into one card per manager. Averages are
  // re-weighted by the counts they came from — averaging two property averages
  // would let a four-unit park outvote a four-hundred-unit one.
  const byManager = new Map<string, any>()
  for (const r of rows) {
    const key = r.pm_company_id ?? '__self__'
    let g = byManager.get(key)
    if (!g) {
      g = {
        pmCompanyId: r.pm_company_id ?? null,
        pmCompanyName: r.pm_company_name ?? SELF_MANAGED,
        properties: [], unitCount: 0, occupiedUnits: 0,
        dueCount: 0, onTimeCount: 0,
        lateDaysSum: 0, lateCount: 0,
        turnovers: 0, fillDaysSum: 0,
      }
      byManager.set(key, g)
    }
    g.properties.push({
      propertyId: r.property_id, propertyName: r.property_name,
      unitCount: Number(r.unit_count),
    })
    g.unitCount     += Number(r.unit_count)
    g.occupiedUnits += Number(r.occupied)
    g.dueCount      += Number(r.due_count)
    g.onTimeCount   += Number(r.on_time_count)
    const lateCount = Number(r.due_count) - Number(r.on_time_count)
    if (r.avg_days_late != null && lateCount > 0) {
      g.lateDaysSum += Number(r.avg_days_late) * lateCount
      g.lateCount   += lateCount
    }
    if (r.avg_days_to_fill != null && Number(r.turnovers) > 0) {
      g.fillDaysSum += Number(r.avg_days_to_fill) * Number(r.turnovers)
      g.turnovers   += Number(r.turnovers)
    }
  }

  const managers: ManagerScorecard[] = [...byManager.values()].map(g => ({
    pmCompanyId: g.pmCompanyId,
    pmCompanyName: g.pmCompanyName,
    propertyCount: g.properties.length,
    unitCount: g.unitCount,
    occupiedUnits: g.occupiedUnits,
    vacantUnits: Math.max(0, g.unitCount - g.occupiedUnits),
    occupancyPct: g.unitCount > 0
      ? round2((g.occupiedUnits / g.unitCount) * 100) : null,
    // No rent due is not a 0% score. A manager who has not billed anything yet
    // has not failed to collect anything.
    onTimeRatePct: g.dueCount > 0
      ? round2((g.onTimeCount / g.dueCount) * 100) : null,
    rentDueCount: g.dueCount,
    avgDaysLate: g.lateCount > 0 ? round2(g.lateDaysSum / g.lateCount) : null,
    avgDaysToFill: g.turnovers > 0 ? round2(g.fillDaysSum / g.turnovers) : null,
    turnovers: g.turnovers,
    evictionsResolved: null,
    properties: g.properties,
  }))

  // Self-managed sorts first, then managers by name — an owner reads their own
  // half as the baseline they are judging the others against.
  managers.sort((a, b) => {
    if (a.pmCompanyId === null) return -1
    if (b.pmCompanyId === null) return 1
    return a.pmCompanyName.localeCompare(b.pmCompanyName)
  })

  return {
    windowStart: rows[0]?.w_start ?? '',
    windowEnd: rows[0]?.w_end ?? '',
    managers,
    totals: {
      propertyCount: rows.length,
      unitCount: managers.reduce((s, m) => s + m.unitCount, 0),
      occupiedUnits: managers.reduce((s, m) => s + m.occupiedUnits, 0),
    },
    notMeasured: [
      'Eviction handling — the platform does not yet record a legal action with '
      + 'stages and dates, so there is nothing honest to compare. Ask GAM to add it.',
    ],
  }
}
