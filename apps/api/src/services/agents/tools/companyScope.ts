/**
 * S634 — WHEN A LANDLORD TOOL GENUINELY NEEDS ONE COMPANY.
 *
 * Most landlord tools read across the whole account, because that is what "how
 * many units do I have" means. A few cannot: a profit-and-loss statement and a
 * bank reconciliation are per COMPANY by the platform's own design — each entity
 * keeps its own Connect account, its own bank and its own books, and adding two
 * of them together produces a figure that is not true of anything.
 *
 * For those, the account names the company. One company and there is nothing to
 * ask; several and the agent asks, which is a normal conversational turn and far
 * better than a confidently-stated number that merges two sets of books.
 *
 * Matching is by spoken NAME, never by id — a landlord says "Oak Park", not a
 * uuid (see the agent ids-are-spoken rule). Ambiguity is refused rather than
 * guessed.
 */
import { query } from '../../../db'
import { actorLandlordIds, type AgentActor } from './types'

export type CompanyChoice =
  | { ok: true; landlordId: string; name: string | null }
  | { ok: false; error: string }

export async function resolveActorCompany(
  actor: AgentActor,
  spokenName?: unknown,
): Promise<CompanyChoice> {
  const owned = actorLandlordIds(actor)
  if (owned.length === 0) return { ok: false, error: 'There is no company on this account.' }

  const rows = await query<{ id: string; business_name: string | null }>(
    `SELECT id, business_name FROM landlords WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`,
    [owned],
  )
  if (rows.length === 1) return { ok: true, landlordId: rows[0].id, name: rows[0].business_name }

  const needle = String(spokenName ?? '').trim().toLowerCase()
  if (needle) {
    const hits = rows.filter(r => (r.business_name ?? '').toLowerCase().includes(needle))
    if (hits.length === 1) return { ok: true, landlordId: hits[0].id, name: hits[0].business_name }
    if (hits.length > 1) {
      return { ok: false,
        error: `"${spokenName}" matches more than one of your companies (${hits.map(h => h.business_name).join(', ')}). Which one?` }
    }
    return { ok: false,
      error: `You don't have a company called "${spokenName}". You have: ${rows.map(r => r.business_name || 'an unnamed company').join(', ')}.` }
  }

  return { ok: false,
    error: `Which company? You own ${rows.length}: ${rows.map(r => r.business_name || 'an unnamed company').join(', ')}. `
      + 'They keep separate books and separate bank accounts, so this only makes sense for one at a time.' }
}

/** The `company` parameter every tool using the resolver above should declare. */
export const COMPANY_PARAM = {
  company: {
    type: 'string',
    description:
      'Which of the landlord\'s companies, by name (e.g. "Oak Park"). Only needed when they own more than one — ' +
      'leave blank and you will be told the names to choose from.',
  },
} as const
