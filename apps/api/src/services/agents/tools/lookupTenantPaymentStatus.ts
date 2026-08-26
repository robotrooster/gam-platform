/**
 * Tool: lookup_tenant_payment_status (landlord).
 *
 * Lets a landlord check the payment status of one of THEIR OWN tenants by
 * name or email. Doubly scoped to actor.profileId (the landlord id):
 *   1. the tenant must be on a lease owned by this landlord, AND
 *   2. the payments summed are only those tied to this landlord.
 * A landlord can never see a tenant who isn't theirs, nor another
 * landlord's payments for a shared tenant.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface TenantMatch {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  email: string
  unit_number: string | null
  property_name: string | null | null
}

const OUTSTANDING_STATUSES = ['pending', 'processing', 'failed', 'returned']

/**
 * S624 — strip the question off a name before searching for it.
 *
 * "what's chen's balance?" reached this tool as tenant="what's chen", and it was
 * searched literally: "I couldn't find a tenant matching 'what's chen'". The
 * landlord then had to narrow a question that was never ambiguous — and the
 * reply gave away that nothing was reading it like a person would.
 *
 * A human sees "Chen's", reads the possessive, and searches Chen. So: drop
 * leading interrogatives and filler, drop trailing possessives, and drop the
 * noun the landlord was asking ABOUT ("balance", "rent") when it trails a name.
 *
 * Deliberately conservative — it only trims recognised words from the ENDS. A
 * real name is never removed, because whatever remains after the known filler is
 * what gets searched.
 */
const LEAD_NOISE = /^(?:what(?:'|’)?s|what is|whats|hows|how(?:'|’)?s|how is|who(?:'|’)?s|who is|show me|tell me|check|look ?up|get|find|pull ?up|about|for|the|my|is|does|did|can you)\s+/i
const TRAIL_NOISE = /\s+(?:balance|rent|payment|payments|status|account|ledger|owe|owes|owing|due|total|info|information|details|doing|on|with|at|right now|now|lately)\??$/i
/** A question word left standing alone is not a name. */
const BARE_NOISE = /^(?:what|whats|who|how|show|tell|check|find|get|about|for|the|my|is|does|did|look|pull)$/i

export function cleanNeedle(raw: unknown): string {
  let s = String(raw ?? '').trim()
  // A separator means the name is what comes AFTER it — "tenant: dan okafor",
  // "who's behind — dan okafor". Only when something substantial follows, so a
  // hyphenated name (Anne-Marie) is untouched.
  const sep = s.match(/^[^:—–]*[:—–]\s*(.+)$/)
  if (sep && sep[1].trim().length >= 2) s = sep[1].trim()
  // Repeat: "what's my tenant chen" has two leading words to shed.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEAD_NOISE, '')
    if (next === s) break
    s = next
  }
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TRAIL_NOISE, '')
    if (next === s) break
    s = next
  }
  // Possessive: Chen's → Chen. Left until last so "chen's balance" loses the
  // noun first and does not strip an apostrophe out of a name like O'Neill.
  s = s.replace(/(?:'|’)s$/i, '')
  s = s.replace(/[?!.,]+$/, '').trim()
  // "what's" on its own reduces to "what", which is a question, not a tenant.
  return BARE_NOISE.test(s) ? '' : s
}

export const lookupTenantPaymentStatus: AgentTool = {
  name: 'lookup_tenant_payment_status',
  description:
    'Look up the payment status (current balance owed + recent payments) of one of the landlord’s ' +
    'OWN tenants, by name or email. Use for “is Jane Doe paid up?” or “what does the tenant in unit ' +
    '4 owe me?”. Only returns tenants on this landlord’s leases. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or email — or the unit they live in (e.g. "Apt 101", "RV 04", or just "101").' },
    },
    required: ['tenant'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = cleanNeedle(args.tenant)
    // S617 (Nic): "I've got RV spot number one in four different RV parks." A
    // bare "1" is a real way to name a unit, so a single character is allowed
    // when it is a digit. Anything else still needs two, or the match is noise.
    if (needle.length < 2 && !/^\d$/.test(needle)) {
      return { ok: false, error: 'Provide at least part of the tenant’s name, their email, or their unit.' }
    }

    // Tenants on THIS landlord's leases matching the name, email — or the UNIT.
    //
    // S617 (Nic): "it should find the actual lease based on the signed in person
    // ... unless it's the landlord talking about a specific person and then
    // should be able to find that by name in occupied units."
    //
    // A landlord asking "how much does apt 101 owe" is naming the space, not the
    // person — often the only handle they have in front of them. This used to
    // match name and email only, so it answered "I don't see a tenant named
    // 'Apt 101'", which is true and useless. Unit number is matched too now,
    // scoped through the same landlord join, so it can never reach a unit that
    // is not theirs.
    // S617 (Nic): "how much rent does RV spot number one owe" — the word "spot"
    // is part of the address, not noise. Without it, a numeric match on 1 also
    // returns House 01 and Apt 101, and the landlord is asked to choose between
    // a house and an RV site they never mentioned. When the question names a
    // KIND of unit, only that kind is considered.
    // ONLY words that name one kind of thing and nothing else.
    //
    // S617, corrected by Nic: I had "spot" narrowing to rv_spot, and he pushed
    // back — "spot number one. This is how people talk... is that RV one? Is
    // that mobile home one? Is that apartment one?" He is right. "Spot", "site"
    // and "lot" are how someone refers to ANY numbered space, so treating them
    // as a type silently picks one and answers about the wrong unit. A loose
    // word must produce the QUESTION, not a guess.
    //
    // "RV", "apartment", "house", "storage" name exactly one thing, so they
    // narrow. Everything vague is left out on purpose.
    const TYPE_WORDS: Record<string, string> = {
      rv: 'rv_spot', campsite: 'campsite',
      apt: 'apartment', apartment: 'apartment',
      house: 'single_family',
      'mobile home': 'mobile_home', trailer: 'mobile_home',
      storage: 'storage', parking: 'parking', slip: 'boat_slip',
    }
    const named = Object.entries(TYPE_WORDS)
      .filter(([w, t]) => t && new RegExp(`\\b${w}\\b`, 'i').test(needle))
      .map(([, t]) => t)
    const typeFilter = named.length > 0 ? [...new Set(named)] : null

    const matches = await query<TenantMatch>(
      `SELECT DISTINCT t.id AS tenant_id, us.first_name, us.last_name, us.email,
              un.unit_number, p.name AS property_name
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users us ON us.id = t.user_id
         JOIN units un ON un.id = l.unit_id
         JOIN properties p ON p.id = un.property_id
        WHERE (
              us.email ILIKE $2
           OR (COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) ILIKE $2
           OR un.unit_number ILIKE $2
           -- S617: compared as NUMBERS, not text. "spot 1" normalises to "1"
           -- and the unit "RV 01" to "01"; as strings those differ, so asking
           -- about spot 1 returned "no tenant matches" while the spot existed.
           OR ($3 ~ '[0-9]'
               AND regexp_replace(un.unit_number, '[^0-9]', '', 'g') <> ''
               AND regexp_replace(un.unit_number, '[^0-9]', '', 'g')::bigint
                   = regexp_replace($3, '[^0-9]', '', 'g')::bigint))
          AND ($4::text[] IS NULL OR un.unit_type = ANY($4))`,
      [actor.profileId, `%${needle}%`, needle, typeFilter]
    )

    if (matches.length === 0) {
      return { ok: false, error: `No tenant on your leases matches “${needle}”.` }
    }
    if (matches.length > 1) {
      // S617 (Nic): "a bunch of single family houses all on their own property
      // are gonna come back as hundreds of spot ones across the portfolio."
      // Right — for single-family the unit number is meaningless and the
      // ADDRESS is the identifier, so listing two hundred "Unit 1"s answers
      // nothing. Narrow by PROPERTY first, which is the question the landlord
      // can actually answer, and only fall back to listing units when the
      // matches all sit in one place.
      const byProperty = new Map<string, number>()
      for (const m of matches) {
        const k = m.property_name ?? '(unknown property)'
        byProperty.set(k, (byProperty.get(k) ?? 0) + 1)
      }
      if (byProperty.size > 1) {
        const properties = [...byProperty.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([property, count]) => ({ property, matchingUnits: count }))
        return {
          ok: false,
          needsDisambiguation: true,
          scope: 'property',
          totalMatches: matches.length,
          message:
            `${matches.length} units across ${byProperty.size} properties match that. ` +
            'Ask WHICH PROPERTY — not which unit. Offer these and let them pick one; ' +
            'once they name a property, look up that unit there and give them the answer.',
          properties,
          truncated: byProperty.size > 12 ? byProperty.size - 12 : 0,
        }
      }
      return {
        ok: false,
        needsDisambiguation: true,
        scope: 'unit',
        totalMatches: matches.length,
        message: 'More than one unit at that property matches. Ask which one, listing them.',
        // Naming the UNIT is what makes the question answerable — "Chen" alone
        // does not tell a landlord which of their tenants you mean.
        matches: matches.slice(0, 15).map((m) => ({
          name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
          email: m.email,
          unit: m.unit_number,
          property: m.property_name,
        })),
      }
    }

    const m = matches[0]

    // S617 (Nic): "when linking partial information to somebody in a unit in a
    // landlord's portfolio, it should say 'do you mean this person in this
    // unit' before confirming — or did you mean somebody else?"
    //
    // A surname or a bare number is PARTIAL. Landing on one row does not mean
    // the landlord meant that row, and the answer is somebody's financial
    // standing — the thing a notice gets served over. So the result says how
    // thin the match was, and the agent names the person AND the unit so a
    // wrong guess is caught in the same breath rather than acted on.
    const full = `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim().toLowerCase()
    const exact = needle.toLowerCase() === full || needle.toLowerCase() === (m.email ?? '').toLowerCase()
    const matchedOn = exact ? 'exact' : 'partial'
    // Payments are scoped to BOTH the tenant AND this landlord.
    const owed = await query<{ outstanding: string | null; count: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS outstanding, COUNT(*) AS count
         FROM payments
        WHERE tenant_id = $1 AND landlord_id = $2 AND status = ANY($3)`,
      [m.tenant_id, actor.profileId, OUTSTANDING_STATUSES]
    )
    const recent = await query<{ type: string; amount: string; status: string; due_date: string | null }>(
      `SELECT type, amount, status, due_date
         FROM payments
        WHERE tenant_id = $1 AND landlord_id = $2
        ORDER BY COALESCE(due_date, created_at) DESC
        LIMIT 5`,
      [m.tenant_id, actor.profileId]
    )

    return {
      ok: true,
      matchedOn,
      confirmBeforeActing: matchedOn === 'partial'
        ? 'You matched on partial information. Name this tenant AND their unit in your reply so the landlord can catch it if you have the wrong person, and offer that it might be someone else.'
        : undefined,
      tenant: {
        name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
        email: m.email,
        unit: m.unit_number,
        property: m.property_name,
      },
      outstandingBalance: Number(owed[0]?.outstanding ?? 0),
      outstandingItemCount: Number(owed[0]?.count ?? 0),
      recentPayments: recent.map((r) => ({ type: r.type, amount: Number(r.amount), status: r.status, dueDate: r.due_date })),
    }
  },
}
