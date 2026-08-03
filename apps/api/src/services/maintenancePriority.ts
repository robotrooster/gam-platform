/**
 * Maintenance priority recommendation (S571).
 *
 * The tenant no longer chooses a priority. When a request is filed, the
 * in-house tenant agent (Ava — the `tenant_entry` persona's model) reads the
 * category + description and RECOMMENDS a priority. The landlord can override
 * the effective priority afterward; we store the recommendation separately so
 * the suggestion stays visible and auditable.
 *
 * This is a single-shot classification, NOT a conversational agent turn, so it
 * calls `chatCompletion` directly with a tight, JSON-only instruction rather
 * than going through runAgentWithTools. If the self-hosted model is slow or
 * unreachable, we fall back to a deterministic keyword heuristic so a tenant
 * can ALWAYS file a request — the AI is an enhancement, never a gate.
 */

import { chatCompletion } from './agents/engine'
import { MAINTENANCE_CATEGORY_LABEL, type MaintenanceCategory, type MaintenancePriority } from '@gam/shared'
import { logger } from '../lib/logger'

export interface PriorityRecommendation {
  priority: MaintenancePriority
  source: 'agent' | 'heuristic'
}

const VALID: readonly MaintenancePriority[] = ['emergency', 'high', 'normal', 'low']

/**
 * Deterministic fallback. Habitability/safety terms → emergency; loss-of-
 * essential-service terms → high; everything else → normal (never auto-low —
 * a human downgrades). Category nudges the baseline.
 */
export function heuristicPriority(category: string, title: string, description: string): MaintenancePriority {
  const text = `${title} ${description}`.toLowerCase()

  // Gas/water/fire/CO/electrical-shock/flood/sewage/security are life-safety.
  if (/\b(gas|smoke|fire|carbon monoxide|co detector|spark|exposed wire|shock|flood|sewage|sewer backup|burst pipe|no heat|no water|break[- ]?in|broken lock|can'?t lock|cannot lock|locked out)\b/.test(text)) {
    return 'emergency'
  }

  const high = [
    'leak', 'leaking', 'no hot water', 'not working', "won't turn", 'overflow',
    'clogged', 'backed up', 'ac not', 'air conditioning', 'heater', 'refrigerator',
    'fridge', 'freezer', 'toilet', 'mold', 'pest', 'infestation', 'roaches', 'rats', 'mice',
  ]
  if (high.some(k => text.includes(k))) return 'high'

  // Category baselines for vague descriptions.
  if (category === 'plumbing' || category === 'electrical' || category === 'hvac') return 'high'
  if (category === 'pest' || category === 'appliance' || category === 'roofing' || category === 'structural') return 'normal'

  return 'normal'
}

const SYSTEM_PROMPT = `You are a maintenance triage assistant for a property-management platform. \
Given a tenant's maintenance request, classify its urgency into exactly one of: emergency, high, normal, low.

Guidance:
- emergency = a threat to health, safety, or the building: gas smell, fire/smoke, carbon monoxide, electrical shock/sparks/exposed wires, flooding, sewage backup, no heat in cold weather, no running water, no working toilet, or a security failure (broken lock, can't secure the unit).
- high = loss of an essential service or something that will worsen fast: active leak, no hot water, HVAC not working, refrigerator/freezer failure, clogged/overflowing drain, mold, or an infestation.
- normal = a routine repair that is not urgent: a dripping faucet, a loose fixture, cosmetic damage, a squeaky door.
- low = optional/cosmetic with no functional impact.

Respond with ONLY a compact JSON object: {"priority":"<value>"}. No prose.`

/**
 * Recommend a priority via the in-house LLM, falling back to the heuristic on
 * any failure (unreachable model, timeout, unparseable output). Never throws.
 */
export async function recommendMaintenancePriority(input: {
  category: string
  title: string
  description: string
}): Promise<PriorityRecommendation> {
  const { category, title, description } = input
  const categoryLabel = MAINTENANCE_CATEGORY_LABEL[category as MaintenanceCategory] || category

  try {
    const out = await chatCompletion(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Category: ${categoryLabel}\nDescription: ${description || '(none)'}`,
        },
      ],
      // Deterministic — this is a classifier, not a chat. (max_tokens is
      // capped by the engine config; the reply is a short JSON object.)
      { sampler: { temperature: 0 } },
    )
    const parsed = parsePriority(out.content)
    if (parsed) return { priority: parsed, source: 'agent' }
    logger.warn({ raw: out.content }, '[maint-priority] agent output unparseable, using heuristic')
  } catch (e) {
    logger.warn({ err: e }, '[maint-priority] agent call failed, using heuristic')
  }

  return { priority: heuristicPriority(category, title, description), source: 'heuristic' }
}

/** Pull a valid priority out of the model's reply (tolerant of stray text). */
function parsePriority(raw: string): MaintenancePriority | null {
  if (!raw) return null
  // Try JSON first.
  const jsonMatch = raw.match(/\{[^}]*\}/)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0])
      const p = String(obj.priority || '').toLowerCase().trim()
      if (VALID.includes(p as MaintenancePriority)) return p as MaintenancePriority
    } catch { /* fall through to bare-word scan */ }
  }
  // Bare word fallback.
  const lower = raw.toLowerCase()
  for (const p of VALID) if (lower.includes(p)) return p
  return null
}
