/**
 * S640 — emergency contacts: import them, and finish the ones that are missing
 * a number.
 *
 * Nic: "one lady, Carine Covarrubius, has her daughter, Irma, as an emergency
 * contact. She didn't put the phone number down. Irma is also a tenant... Can
 * you merge or pull the applicable data from different sources to get a
 * complete table? ...what if two or three other people have the same person as
 * an emergency contact?"
 *
 * Both of those turned out to be real at Mountain View and Oak Park:
 *   * Coreen Covarrubias wrote "Irma Fuentes" and no number. Irma is in the
 *     system with 520-204-3181.
 *   * Kevin Black and Marci Neeld are each other's emergency contact. His line
 *     has no number; hers does, and it matches his tenant record — which is the
 *     same technique working in the direction we can check.
 *
 * A match is SUGGESTED and never applied. The number here is the one somebody
 * dials on the worst day of a resident's life; a wrong one is worse than a
 * blank, because a blank prompts a question at the counter and a wrong one gets
 * called.
 */
import { query, queryOne } from '../db'
import { parseEmergencyContact, namesLikelySamePerson } from '@gam/shared'
import { logger } from '../lib/logger'

export interface ImportResult {
  scanned: number
  created: number
  updated: number
  skipped: number
}

/**
 * Pull every "Emergency contact" field off signed leases into the table.
 *
 * Idempotent per lease field: re-running corrects a row rather than adding a
 * second one, and never touches a contact somebody typed at the counter (those
 * carry no source_field_id).
 */
export async function importEmergencyContactsFromLeases(
  opts: { landlordIds?: string[] } = {},
): Promise<ImportResult> {
  const out: ImportResult = { scanned: 0, created: 0, updated: 0, skipped: 0 }

  const rows = await query<{
    field_id: string; value: string; tenant_id: string
  }>(
    `SELECT ldf.id AS field_id, ldf.value, lt.tenant_id
       FROM lease_document_fields ldf
       JOIN lease_documents ld ON ld.id = ldf.document_id
       JOIN leases l          ON l.id  = ld.lease_id
       JOIN lease_tenants lt  ON lt.lease_id = l.id AND lt.role = 'primary'
      WHERE ldf.label ILIKE 'emergency contact%'
        AND COALESCE(ldf.value, '') <> ''
        AND ($1::uuid[] IS NULL OR l.landlord_id = ANY($1::uuid[]))`,
    [opts.landlordIds ?? null],
  )
  out.scanned = rows.length

  for (const r of rows) {
    const parsed = parseEmergencyContact(r.value)
    try {
      // ── S640: DO NOT ADD A SECOND ROW FOR THE SAME PERSON ────────────────
      //
      // A contact somebody typed at the counter has no source_field_id, so the
      // conflict clause below cannot see it — and the import happily created a
      // duplicate beside it. David Shultz ended up with "Henry Sauer" twice,
      // once from his lease and once from staff, and the roster then reported
      // Henry as the emergency contact for two households.
      //
      // When the lease names somebody this tenant already has, claim that row
      // instead: it keeps the provenance, fills whatever is still blank, and
      // leaves what a person typed alone.
      if (parsed.name) {
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM emergency_contacts
            WHERE tenant_id = $1 AND source_field_id IS NULL
              AND name IS NOT NULL AND lower(trim(name)) = lower(trim($2))
            ORDER BY created_at LIMIT 1`,
          [r.tenant_id, parsed.name],
        )
        if (existing) {
          await query(
            `UPDATE emergency_contacts
                SET source_field_id = $2,
                    phone        = COALESCE(phone, $3),
                    relationship = COALESCE(relationship, $4),
                    raw_text     = COALESCE(raw_text, $5),
                    updated_at   = NOW()
              WHERE id = $1`,
            [existing.id, r.field_id, parsed.phone, parsed.relationship, parsed.raw],
          )
          out.updated++
          continue
        }
      }
      // Even an unusable line is kept — "Wife" or "NA" tells the desk the
      // question was asked and answered badly, which is different from never
      // having been asked. What is NOT kept is a name or number we invented.
      const res = await query<{ id: string; inserted: boolean }>(
        `INSERT INTO emergency_contacts
           (tenant_id, name, phone, relationship, raw_text, source, source_field_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, 'lease', $6, 0)
         ON CONFLICT (source_field_id) WHERE source_field_id IS NOT NULL
         DO UPDATE SET
           -- Never overwrite something a person has since filled in by hand.
           name         = COALESCE(emergency_contacts.name, EXCLUDED.name),
           phone        = COALESCE(emergency_contacts.phone, EXCLUDED.phone),
           relationship = COALESCE(emergency_contacts.relationship, EXCLUDED.relationship),
           raw_text     = EXCLUDED.raw_text,
           updated_at   = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [r.tenant_id, parsed.name, parsed.phone, parsed.relationship, parsed.raw, r.field_id],
      )
      if (res[0]?.inserted) out.created++; else out.updated++
    } catch (e) {
      out.skipped++
      logger.error({ err: e, fieldId: r.field_id }, '[emergency-contacts] could not import one lease field')
    }
  }
  logger.info(out, '[emergency-contacts] lease import')
  return out
}

export interface ContactSuggestion {
  phone: string
  fromName: string
  /** How we know them: a tenant here, and where. */
  context: string
}

/**
 * Somebody already in the system whose name matches this contact, and who has a
 * phone number we could offer.
 *
 * Searches USERS, not active lease-holders: Irma Fuentes is in the system with
 * a number but is not a primary tenant on a current lease, and she is exactly
 * the case this exists for.
 */
export async function suggestPhoneForContact(
  contactName: string | null,
  landlordIds: string[],
): Promise<ContactSuggestion | null> {
  if (!contactName || !contactName.trim()) return null

  const candidates = await query<{
    first_name: string; last_name: string; phone: string; unit_number: string | null; property_name: string | null
  }>(
    `SELECT DISTINCT u.first_name, u.last_name, u.phone,
            un.unit_number, p.name AS property_name
       FROM users u
       JOIN tenants t        ON t.user_id = u.id
       LEFT JOIN lease_tenants lt ON lt.tenant_id = t.id
       LEFT JOIN leases l    ON l.id = lt.lease_id AND l.status = 'active'
       LEFT JOIN units un    ON un.id = l.unit_id
       LEFT JOIN properties p ON p.id = un.property_id
      WHERE COALESCE(u.phone, '') <> ''
        AND (p.landlord_id IS NULL OR p.landlord_id = ANY($1::uuid[]))`,
    [landlordIds],
  )

  for (const c of candidates) {
    const full = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
    if (!namesLikelySamePerson(contactName, full)) continue
    return {
      phone: String(c.phone).replace(/\D/g, ''),
      fromName: full,
      context: c.unit_number
        ? `also a resident — ${c.unit_number}${c.property_name ? ` at ${c.property_name}` : ''}`
        : 'already in your records',
    }
  }
  return null
}

/**
 * The desk's view: every current resident, what emergency contact is on file,
 * and what is missing. Scoped to the properties the caller may see.
 */
export async function emergencyContactRoster(args: {
  landlordIds: string[]
  propertyIds: string[] | null
}) {
  return query<any>(
    `SELECT
       t.id                 AS tenant_id,
       u.first_name         AS tenant_first,
       u.last_name          AS tenant_last,
       u.phone              AS tenant_phone,
       un.unit_number,
       p.name               AS property_name,
       p.id                 AS property_id,
       ec.id                AS contact_id,
       ec.name              AS contact_name,
       ec.phone             AS contact_phone,
       ec.relationship      AS contact_relationship,
       ec.raw_text          AS contact_raw,
       ec.source            AS contact_source,
       ec.confirmed_at      AS contact_confirmed_at,
       -- S640 (Nic): "what if two or three other people have the same person as
       -- an emergency contact?" Then that person is worth knowing about — they
       -- are the one call that reaches several households.
       -- S640: DISTINCT TENANTS, not rows. Counting rows read a duplicate on
       -- ONE resident as two households — David Shultz had "Henry Sauer" from
       -- his lease and again from the counter, and the page announced Henry as
       -- the call for two homes. A number that reaches several households is
       -- worth flagging; a double entry is worth fixing, not announcing.
       (SELECT COUNT(DISTINCT o.tenant_id) FROM emergency_contacts o
         WHERE o.name IS NOT NULL AND ec.name IS NOT NULL
           AND lower(trim(o.name)) = lower(trim(ec.name)))::int AS shared_with_count
     FROM lease_tenants lt
     JOIN leases l    ON l.id = lt.lease_id AND l.status = 'active'
     JOIN tenants t   ON t.id = lt.tenant_id
     JOIN users u     ON u.id = t.user_id
     JOIN units un    ON un.id = l.unit_id
     JOIN properties p ON p.id = un.property_id
     LEFT JOIN LATERAL (
       SELECT * FROM emergency_contacts e
        WHERE e.tenant_id = t.id
        ORDER BY (e.phone IS NOT NULL) DESC, e.sort_order, e.created_at
        LIMIT 1
     ) ec ON TRUE
     WHERE p.landlord_id = ANY($1::uuid[])
       AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
     ORDER BY p.name, un.unit_number`,
    [args.landlordIds, args.propertyIds],
  )
}
