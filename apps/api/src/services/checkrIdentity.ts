/**
 * ── THE LICENCE CHECKR ALREADY TOOK (Nic, 10/29) ────────────────────────────
 *
 *   "License capture is going to happen everywhere. It's just a different
 *    window. We need to take all the licenses that are uploaded into Checker
 *    and run them in our system. With the identity verification on, the person
 *    has to take a selfie of their identification."
 *
 * Every screening order asks for Checkr's live ID scan (CHECKR_ID_SCAN_ADD_ON,
 * 'identity_verification') — the applicant photographs their licence and takes
 * a selfie, and Checkr reads the card. GAM has been receiving the result all
 * along and archiving it; nothing has ever read it.
 *
 * What comes back, confirmed against the reports actually in the database:
 *
 *   identity_verification.document_data  first_name, last_name, full_name,
 *                                        dob, document_number, address,
 *                                        issue_date, expiration_date
 *   identity_verification.document_type  { type, state, country }
 *
 * Which is the same set of facts the desk takes off a licence at the counter,
 * from a better source — Checkr read the card itself and checked the face
 * against it. So it lands in the SAME table, and the left-owing matcher asks
 * one question of everybody regardless of which window identified them.
 *
 * Nothing here is shown to a landlord. HELD_FROM_LANDLORD already strips
 * document data out of what travels to them, and that is unchanged: this is
 * for telling one person from another inside GAM, never for a landlord to
 * read somebody's licence number off a screen.
 */
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'

/** Checkr's document_type.type, in the words it uses, to our id_type. */
function idType(raw: string | null | undefined): string {
  const t = String(raw ?? '').toLowerCase()
  if (t.includes('driver')) return 'drivers_license'
  if (t.includes('passport')) return 'passport'
  if (t.includes('military')) return 'military_id'
  if (t.includes('resident')) return 'permanent_resident_card'
  if (t.includes('identification') || t.includes('id card')) return 'state_id'
  return 'other'
}

/** Checkr gives 'USA'; the column holds two letters. */
function country(raw: string | null | undefined): string {
  const c = String(raw ?? 'US').toUpperCase()
  return c.startsWith('CA') ? 'CA' : 'US'
}

/** A date Checkr may give as YYYY-MM-DD or with a time on it. */
function asDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * File the licence from one screening's ID scan against that tenant.
 *
 * Idempotent per background check: re-running a sync, or a report arriving
 * twice, restates the record rather than filing a second one. Returns the
 * identification id, or null when the scan did not run, was refused, or
 * carried no document — all of which are ordinary.
 */
export async function fileCheckrIdentity(args: {
  client:            PoolClient
  backgroundCheckId: string
}): Promise<string | null> {
  const c = args.client
  const r = await c.query<{
    tenant_id: string | null; doc: any; type: any
  }>(
    // The newest report for this check that actually carries a document: a
    // check is reported several times as its products finish, and only some
    // of those bodies have the ID scan in them.
    `SELECT bc.tenant_id,
            rep.payload->'identity_verification'->'document_data' AS doc,
            rep.payload->'identity_verification'->'document_type' AS type
       FROM background_checks bc
       JOIN background_check_reports rep ON rep.background_check_id = bc.id
      WHERE bc.id = $1
        AND jsonb_typeof(rep.payload->'identity_verification'->'document_data') = 'object'
      ORDER BY rep.received_at DESC
      LIMIT 1`,
    [args.backgroundCheckId])

  const row = r.rows[0]
  if (!row?.tenant_id || !row.doc) return null

  const number = String(row.doc.document_number ?? '').trim()
  const dob = asDate(row.doc.dob)
  // A scan with neither a number nor a birthday identifies nobody, and an
  // empty record would only get in the matcher's way.
  if (!number && !dob) return null

  const made = await c.query<{ id: string }>(
    `INSERT INTO tenant_identifications
       (tenant_id, id_type, id_number, issuing_state, issuing_country,
        expiry_date, date_of_birth, captured_how, is_primary, notes)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, 'scanned', TRUE,
             'Read by Checkr from the applicant''s own photo of the document')
     ON CONFLICT (tenant_id, id_type, id_number) WHERE tenant_id IS NOT NULL DO UPDATE
        SET issuing_state  = COALESCE(EXCLUDED.issuing_state, tenant_identifications.issuing_state),
            expiry_date    = COALESCE(EXCLUDED.expiry_date, tenant_identifications.expiry_date),
            date_of_birth  = COALESCE(EXCLUDED.date_of_birth, tenant_identifications.date_of_birth),
            captured_how   = 'scanned',
            updated_at     = NOW()
     RETURNING id`,
    [row.tenant_id, idType(row.type?.type), number,
     row.type?.state ? String(row.type.state).slice(0, 2).toUpperCase() : null,
     country(row.type?.country),
     asDate(row.doc.expiration_date), dob])

  // The tenant's own birthday, where it was not already known — it is what
  // tells two people of one name apart.
  if (dob) {
    await c.query(
      `UPDATE tenants SET date_of_birth = COALESCE(date_of_birth, $2::date), updated_at = NOW()
        WHERE id = $1`, [row.tenant_id, dob])
  }

  logger.info({ background_check_id: args.backgroundCheckId, tenant_id: row.tenant_id },
    '[checkr-identity] licence filed from the ID scan')
  return made.rows[0].id
}

/**
 * Catch up every screening already taken. Checkr has been reading licences
 * since the ID scan was switched on and GAM kept every one of them; this puts
 * the ones already in hand where the matcher can see them.
 */
export async function fileAllCheckrIdentities(client: PoolClient): Promise<{ filed: number }> {
  const ids = await client.query<{ id: string }>(
    `SELECT DISTINCT bc.id
       FROM background_checks bc
       JOIN background_check_reports rep ON rep.background_check_id = bc.id
      WHERE bc.tenant_id IS NOT NULL
        AND jsonb_typeof(rep.payload->'identity_verification'->'document_data') = 'object'`)
  let filed = 0
  for (const { id } of ids.rows) {
    try { if (await fileCheckrIdentity({ client, backgroundCheckId: id })) filed += 1 }
    catch (err) { logger.error({ err, background_check_id: id }, '[checkr-identity] could not file one') }
  }
  return { filed }
}
