// 10/27 (Nic) — ONE SEARCH BAR THAT FINDS ANYTHING IN THE LANDLORD PORTAL.
//
//   "we have search bars on each kind of sub page. So if I go into a unit and
//    I could type somebody's name in, but like if I'm just on the dashboard, I
//    should have a search bar where I can quickly type in, you know, this
//    person's name or unit 5, and it will link to every matching text across
//    any page in the landlord portal. So if I type in mobile home 5, I can see
//    that at, you know, 2 or 3 different properties. And then I can just click
//    on the one I want, or I can type a first name. I can type John, and every
//    tenant I have named John will show up in a list."
//
// And the reason, which shapes the whole design:
//
//   "because people that are not familiar, as they're getting used to the
//    landlord portal, because of how much stuff we have, they're not going to
//    know that they need to go into, you know, this thing or this thing to
//    find what they need until they get used to it."
//
// So it is a SHORTCUT, not a report. Every hit carries where to go, the thing
// is named the way the portal names it, and a space says which property it is
// at — because "mobile home 5" exists at more than one park and the whole
// point is being able to tell them apart at a glance.
//
// WHAT IT IS SCOPED TO. The same two gates every landlord-side read uses: the
// companies the caller holds (landlordScopeIds) and, for staff narrowed to
// particular properties, those properties (getScopedPropertyIds, where null
// means not narrowed rather than none). A search bar that reached past a
// manager's own park would be the widest leak in the portal, so the scope is
// applied in SQL on every branch rather than filtered afterwards.

import { query } from '../db'

export type PortalSearchKind = 'resident' | 'space' | 'property' | 'lease'

export interface PortalSearchHit {
  kind:  PortalSearchKind
  /** What the portal calls it. */
  title: string
  /** Where it is, said the way a person would say it. Null for a property. */
  where: string | null
  /** Anything else worth seeing without clicking: a balance, a status. */
  note:  string | null
  /** The landlord-portal path to open. */
  href:  string
}

export interface PortalSearchResults {
  query: string
  hits:  PortalSearchHit[]
  /** True when the list was cut short, so the UI can say "keep typing". */
  truncated: boolean
}

/** Per kind, so one busy kind cannot crowd the others out of the list. */
const PER_KIND = 6

/**
 * Matching is case-insensitive and substring-based on purpose: Nic's examples
 * are "John" and "mobile home 5", neither of which is a prefix of the stored
 * value ("mobile home 5" is stored as unit_type 'mobile_home' plus unit_number
 * '5'). So a space is matched on a NORMALISED label — the unit type's words
 * and the number, with underscores and punctuation flattened — which is what
 * makes "mh 5", "mobile home 5" and "5" all find it.
 */
function normalizedSpaceLabelSql(u: string): string {
  return `LOWER(REGEXP_REPLACE(
            COALESCE(${u}.display_label, '') || ' ' ||
            COALESCE(REPLACE(${u}.unit_type, '_', ' '), '') || ' ' ||
            COALESCE(${u}.unit_number, ''),
            '[^a-z0-9]+', ' ', 'gi'))`
}

/** The same flattening on the search term, so both sides are comparable. */
function normalizeTerm(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Every word has to appear somewhere in the label, in any order: "5 mobile
 * home" and "mobile home 5" are the same search, and "mh 5" finds a mobile
 * home 5 because 'mh' is in the display label. An AND over the words rather
 * than one LIKE of the whole phrase, because the stored order is not the order
 * anybody types.
 */
function everyWordLike(expr: string, words: string[], from: number): { sql: string; params: string[] } {
  const parts: string[] = []
  const params: string[] = []
  words.forEach((w, i) => {
    if (/^\d+$/.test(w)) {
      // A NUMBER MATCHES AS A WHOLE TOKEN, not a substring. Searching
      // "mobile home 5" with a substring match also returned MH 15 and MH 25,
      // which is the opposite of the point — his example is the same space
      // number at different parks, so the number has to mean the number.
      // \m and \M are Postgres's word-boundary anchors; the label is already
      // flattened to space-separated words, so "MH 3.5" still offers 5 as a
      // token of its own, which is right.
      //
      // LEADING ZEROS ARE IGNORED on both sides, because the spaces are
      // numbered "MH 05" and nobody types the zero: the stored token is "05"
      // and a bare \m5\M would miss it. `0*` on the pattern and a strip on the
      // term make 5, 05 and 005 one search.
      parts.push(`${expr} ~ ('\\m0*' || $${from + i} || '\\M')`)
    } else {
      // A WORD matches as a substring, so "mob" finds a mobile home and "cast"
      // finds Castellan — somebody typing fast should not have to finish.
      parts.push(`${expr} LIKE '%' || $${from + i} || '%'`)
    }
    // A term of "05" is the same search as "5"; the pattern's own 0* covers
    // the stored side.
    params.push(/^\d+$/.test(w) ? w.replace(/^0+(?=\d)/, '') : w)
  })
  return { sql: parts.join(' AND '), params }
}

export async function portalSearch(args: {
  landlordIds:        string[]
  /** null = not narrowed to particular properties (an owner, or all_properties). */
  scopedPropertyIds:  string[] | null
  q:                  string
  /** Whether this caller may see money. Staff who cannot are shown no balances. */
  seesMoney?:         boolean
}): Promise<PortalSearchResults> {
  const q = (args.q ?? '').trim()
  const empty: PortalSearchResults = { query: q, hits: [], truncated: false }
  // One character matches most of the portfolio and is never what anybody
  // meant; it is a shortcut, so it waits until the typing says something.
  if (q.length < 2 || args.landlordIds.length === 0) return empty

  const words = normalizeTerm(q).split(' ').filter(Boolean)
  if (words.length === 0) return empty
  const like = `%${q.toLowerCase()}%`

  // Applied on every branch, in SQL. `null` means NOT NARROWED, which is not
  // the same as "no properties" — getting that backwards would either hide a
  // whole portfolio from its owner or show a manager somebody else's park.
  const propGate = (alias: string, idx: number) =>
    `($${idx}::uuid[] IS NULL OR ${alias}.property_id = ANY($${idx}::uuid[]))`

  const hits: PortalSearchHit[] = []
  let truncated = false

  // ── Residents ───────────────────────────────────────────────────────────
  // Found by any part of a name, which is the case Nic named: "I can type
  // John, and every tenant I have named John will show up in a list."
  const residents = await query<{
    tenant_id: string; name: string; space: string | null; property: string | null; balance: string | null
  }>(
    `SELECT t.id AS tenant_id,
            TRIM(COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) AS name,
            COALESCE(NULLIF(TRIM(u.display_label), ''), u.unit_number) AS space,
            p.name AS property,
            NULL AS balance
       FROM tenants t
       JOIN users us ON us.id = t.user_id
       LEFT JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
       LEFT JOIN leases l  ON l.id = lt.lease_id AND l.status IN ('active','pending')
       LEFT JOIN units u   ON u.id = l.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
      WHERE l.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
        AND (LOWER(COALESCE(us.first_name,'')) LIKE $3
             OR LOWER(COALESCE(us.last_name,'')) LIKE $3
             OR LOWER(TRIM(COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,''))) LIKE $3)
      ORDER BY us.last_name, us.first_name
      LIMIT ${PER_KIND + 1}`,
    [args.landlordIds, args.scopedPropertyIds, like],
  )
  if (residents.length > PER_KIND) truncated = true
  for (const r of residents.slice(0, PER_KIND)) {
    hits.push({
      kind:  'resident',
      title: r.name || 'Resident',
      where: r.space && r.property ? `${r.space} · ${r.property}` : r.property ?? null,
      note:  null,
      href:  `/tenants/${r.tenant_id}`,
    })
  }

  // ── Spaces ──────────────────────────────────────────────────────────────
  // "if I type in mobile home 5, I can see that at 2 or 3 different
  // properties" — so the property is part of the answer, never a filter.
  const spaceExpr = normalizedSpaceLabelSql('u')
  const w = everyWordLike(spaceExpr, words, 3)
  const spaces = await query<{
    unit_id: string; label: string; property: string; status: string | null; resident: string | null
  }>(
    `SELECT u.id AS unit_id,
            -- The landlord's own label, else the number as they wrote it.
            -- unit_number already carries its prefix ("MH 05"), so adding the
            -- type back would read "mobile home MH 05". The type is still how
            -- "mobile home 5" FINDS it (normalizedSpaceLabelSql).
            COALESCE(NULLIF(TRIM(u.display_label), ''), u.unit_number) AS label,
            p.name AS property,
            u.status,
            TRIM(COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) AS resident
       FROM units u
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
       LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active' AND lt.role = 'primary'
       LEFT JOIN tenants t ON t.id = lt.tenant_id
       LEFT JOIN users us ON us.id = t.user_id
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ${propGate('u', 2)}
        AND ${w.sql}
      ORDER BY p.name, u.unit_number
      LIMIT ${PER_KIND + 1}`,
    [args.landlordIds, args.scopedPropertyIds, ...w.params],
  )
  if (spaces.length > PER_KIND) truncated = true
  for (const s of spaces.slice(0, PER_KIND)) {
    hits.push({
      kind:  'space',
      title: s.label,
      where: s.property,
      // Who is in it, because that is the next thing anybody wants to know.
      note:  s.resident?.trim() ? s.resident : (s.status === 'vacant' ? 'vacant' : null),
      href:  `/units/${s.unit_id}`,
    })
  }

  // ── Properties ──────────────────────────────────────────────────────────
  const props = await query<{ id: string; name: string; city: string | null; state: string | null }>(
    `SELECT p.id, p.name, p.city, p.state
       FROM properties p
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
        AND LOWER(p.name) LIKE $3
      ORDER BY p.name
      LIMIT ${PER_KIND + 1}`,
    [args.landlordIds, args.scopedPropertyIds, like],
  )
  if (props.length > PER_KIND) truncated = true
  for (const p of props.slice(0, PER_KIND)) {
    hits.push({
      kind:  'property',
      title: p.name,
      where: [p.city, p.state].filter(Boolean).join(', ') || null,
      note:  null,
      href:  `/properties/${p.id}`,
    })
  }

  return { query: q, hits, truncated }
}
