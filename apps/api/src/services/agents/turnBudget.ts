/**
 * Per-user daily turn budgets (S553, Nic's spec) — the deterministic
 * bandwidth guard in front of the model fleet.
 *
 * Two counters per user per day, computed live from agent_interaction_logs:
 *  - TOTAL turns, capped by an on-topic budget sized to the user
 *    (tenant: flat; landlord: scales with occupied units — Nic's formula
 *    tenant_budget × occupied_units / 8, floored at the tenant budget so
 *    small/still-onboarding landlords aren't starved).
 *  - UNPRODUCTIVE turns ("what's ten plus ten"), capped low. A turn is
 *    unproductive when nothing grounded it: no knowledge chunk cleared the
 *    0.3 similarity bar, no tool ran, nothing escalated. Courtesy messages
 *    (< 15 chars: "thanks!", "ok") and answer-cache hits never count.
 *
 * Hitting either cap → the session serves a canned reply with ZERO model
 * calls for the rest of the day (see agentSession). Cache-hit answers stay
 * available to capped users — they cost nothing.
 *
 * Budgets are env-tunable (no redeploy): design goal is RARE to hit for
 * legit users — busiest real day on record is 76 turns platform-wide.
 *
 * Silent auto-hide (built DARK, AGENT_ABUSE_AUTOHIDE=1 to arm): a user who
 * hits the unproductive cap on 3+ of the trailing 7 days stops seeing the
 * assistant bubble for HIDE_DAYS. Computed live; no state table.
 */

import { query, queryOne } from '../../db'

function envNum(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : def
}

export function getBudgetConfig() {
  const tenantDaily = envNum('AGENT_TENANT_DAILY_TURNS', 60)
  return {
    tenantDaily,
    tenantOffTopicDaily: envNum('AGENT_TENANT_DAILY_OFFTOPIC', 5),
    landlordOffTopicDaily: envNum('AGENT_LANDLORD_DAILY_OFFTOPIC', 10),
    /** landlord on-topic = max(tenantDaily, perUnit × occupied units) */
    landlordPerUnit: envNum('AGENT_LANDLORD_TURNS_PER_UNIT', tenantDaily / 8),
    autoHideEnabled: process.env.AGENT_ABUSE_AUTOHIDE === '1',
    autoHideTriggerDays: envNum('AGENT_ABUSE_AUTOHIDE_TRIGGER_DAYS', 3),
    autoHideHideDays: envNum('AGENT_ABUSE_AUTOHIDE_HIDE_DAYS', 7),
  }
}

/** SQL predicate for an unproductive turn, against an optionally-aliased
 *  agent_interaction_logs. One definition — the analytics endpoint and the
 *  budget counters must never drift. */
export function unproductiveTurnSql(alias = ''): string {
  const a = alias ? `${alias}.` : ''
  return `
  ${a}grounded IS NOT TRUE
  AND ${a}tool_invocation_count = 0
  AND ${a}escalated_to_human = FALSE
  AND ${a}outcome NOT IN ('shed', 'rate_limited', 'error')
  AND length(${a}user_message) >= 15
  AND COALESCE(${a}metadata->>'cached', '') <> 'true'`
}
const UNPRODUCTIVE_TURN_SQL = unproductiveTurnSql()

async function todayCounts(userId: string): Promise<{ total: number; unproductive: number }> {
  const row = await queryOne<{ total: number; unproductive: number }>(
    `SELECT COUNT(*) FILTER (WHERE outcome NOT IN ('shed', 'rate_limited'))::int AS total,
            COUNT(*) FILTER (WHERE ${UNPRODUCTIVE_TURN_SQL})::int AS unproductive
       FROM agent_interaction_logs
      WHERE actor_user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  )
  return { total: row?.total ?? 0, unproductive: row?.unproductive ?? 0 }
}

// S634: the per-unit turn allowance is earned by the whole ACCOUNT. Counting one
// company's units gave a landlord who owns two a budget sized to half their
// portfolio, and the symptom would have been the agent going quiet early.
async function occupiedUnits(landlordIds: string[]): Promise<number> {
  if (!landlordIds.length) return 0
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE p.landlord_id = ANY($1::uuid[]) AND u.status <> 'vacant'`,
    [landlordIds]
  )
  return row?.n ?? 0
}

export interface BudgetCheck {
  allowed: boolean
  /** which cap tripped (for logging only — the customer copy never says) */
  reason?: 'daily_total' | 'daily_unproductive'
}

/** Admission check for one turn. Tenant/landlord only — prospects are
 *  rate-limited at the route, guests are bounded by their stay. */
export async function checkTurnBudget(
  audience: string,
  userId: string,
  // S634: for a landlord this is every company the ACCOUNT owns — the allowance
  // is earned by the whole portfolio. Tenants pass their own single id, unused
  // below (their cap is flat).
  landlordIds: string[]
): Promise<BudgetCheck> {
  if (audience !== 'tenant' && audience !== 'landlord') return { allowed: true }
  const cfg = getBudgetConfig()
  const { total, unproductive } = await todayCounts(userId)

  const offTopicCap = audience === 'tenant' ? cfg.tenantOffTopicDaily : cfg.landlordOffTopicDaily
  if (unproductive >= offTopicCap) return { allowed: false, reason: 'daily_unproductive' }

  let totalCap = cfg.tenantDaily
  if (audience === 'landlord') {
    const units = await occupiedUnits(landlordIds)
    totalCap = Math.max(cfg.tenantDaily, Math.ceil(cfg.landlordPerUnit * units))
  }
  if (total >= totalCap) return { allowed: false, reason: 'daily_total' }
  return { allowed: true }
}

/** Silent auto-hide: true when the assistant bubble should NOT render for
 *  this user. Always false while the feature is dark. */
export async function isAssistantHidden(userId: string, role: string): Promise<boolean> {
  const cfg = getBudgetConfig()
  if (!cfg.autoHideEnabled) return false
  if (role !== 'tenant' && role !== 'landlord') return false
  const offTopicCap = role === 'tenant' ? cfg.tenantOffTopicDaily : cfg.landlordOffTopicDaily

  // Days in the trailing window where the unproductive cap was hit; if the
  // trigger count is reached, hide until the most recent offending day +
  // hideDays.
  const rows = await query<{ day: string; n: number }>(
    `SELECT created_at::date AS day, COUNT(*) FILTER (WHERE ${UNPRODUCTIVE_TURN_SQL})::int AS n
       FROM agent_interaction_logs
      WHERE actor_user_id = $1
        AND created_at >= date_trunc('day', now()) - interval '7 days'
      GROUP BY 1`,
    [userId]
  )
  const offending = rows.filter((r) => Number(r.n) >= offTopicCap).map((r) => r.day).sort()
  if (offending.length < cfg.autoHideTriggerDays) return false
  const last = new Date(offending[offending.length - 1])
  const hiddenUntil = new Date(last.getTime() + cfg.autoHideHideDays * 86_400_000)
  return new Date() < hiddenUntil
}

/** Canned reply for a capped user — friendly, never mentions abuse
 *  tracking, and identical for both caps. */
export const BUDGET_CAPPED_REPLY =
  "I've hit my limit for our conversations today — to keep things fast for everyone I have to pause here, " +
  "and I'll be ready to pick this back up tomorrow. If something urgent comes up in the meantime, the " +
  'portal itself has everything we usually look at together — and for a property emergency, use the ' +
  'maintenance request with emergency priority.'
