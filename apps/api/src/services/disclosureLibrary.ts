/**
 * S652 — GAM'S SHELF OF GOVERNMENT FORMS.
 *
 * Nic: "the library should only be government published documents that
 * something we're not altering at all... Anything that the landlord has to
 * publish, they can do on their own. They can upload their own form the same way
 * they upload their own lease."
 *
 * So this module does exactly two things and refuses a third:
 *
 *   IT LISTS what the publishing agencies put out, narrowed to the states and
 *   kinds of space a given landlord actually operates in.
 *
 *   IT ADOPTS one onto a landlord's shelf as an ordinary, locked template, so
 *   every existing packet / send / sign / stamp path works unchanged.
 *
 *   IT DOES NOT tell anybody what their state requires. Nic: "we don't want to
 *   show what the statute asks for because a landlord may have properties in
 *   multiple states. We don't want to clutter all that screen." The suggestion
 *   is "this form exists and it was written for where you operate," never "you
 *   must send this." See the no-compliance-language test.
 *
 * THE DOCUMENT IS THE GOVERNMENT'S; THE SIGNING LAYER IS OURS. Nic: "they can't
 * alter the document, but when they send it out for signature, it needs to have
 * e-signature flow on it where the page can at least have the tenant's initials
 * that they received it as part of the lease signing flow." The library ships
 * the field map with the PDF and the landlord edits neither — a form that is
 * "unaltered" cannot also be one every landlord re-positions boxes on.
 */
import { AppError } from '../middleware/errorHandler'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

export type LibraryDocument = {
  id: string
  disclosure_type: string
  jurisdiction: string
  applies_to: 'any' | 'rental' | 'sale'
  unit_types: string[] | null
  name: string
  description: string | null
  source_name: string
  source_url: string
  publication_ref: string | null
  base_pdf_url: string
  page_count: number
  version: number
}

/**
 * The shelf as one landlord sees it: every current form published for the
 * United States or for a state they hold property in, limited to the kinds of
 * space they actually operate, with the ones they have already taken marked.
 *
 * A landlord with parks in three states sees three states' forms and no others.
 * That is the whole of the "suggestion" — location and kind of space, which are
 * facts we hold, and nothing about obligation, which is not ours to assert.
 */
export async function libraryForLandlord(q: Exec, landlordIds: string[]) {
  const { rows } = await q.query(
    `WITH operating AS (
       SELECT DISTINCT p.state AS st
         FROM properties p
        WHERE p.landlord_id = ANY($1::uuid[]) AND p.state IS NOT NULL
     ), kinds AS (
       SELECT DISTINCT u.unit_type AS ut
         FROM units u
        WHERE u.landlord_id = ANY($1::uuid[]) AND u.retired_at IS NULL
     )
     SELECT d.*,
            t.id AS adopted_template_id,
            (SELECT array_agg(DISTINCT o.st) FROM operating o) AS landlord_states
       FROM disclosure_library_documents d
       LEFT JOIN lease_templates t
              ON t.library_document_id = d.id
             AND t.landlord_id = ANY($1::uuid[])
      WHERE d.retired_at IS NULL
        AND d.superseded_by_id IS NULL
        AND (d.jurisdiction = 'US' OR d.jurisdiction IN (SELECT st FROM operating))
        AND (d.unit_types IS NULL
             OR EXISTS (SELECT 1 FROM kinds k WHERE k.ut = ANY(d.unit_types)))
      ORDER BY (d.jurisdiction = 'US') DESC, d.jurisdiction, d.name`,
    [landlordIds])
  return rows
}

/**
 * S652 — THE LIBRARY A LANDLORD SEES: Federal, plus the states they hold
 * property in, for the kinds of space they run there.
 *
 * Nic, revising the first version (which showed all fifty states): "The library
 * should only show relevant stuff to properties they've uploaded. They'll all be
 * there on the back end. As soon as somebody uploads a property in Texas, boom,
 * the Texas documents show up." The rest of the catalog is untouched; adding a
 * property is what reveals it.
 *
 * libraryForLandlord (above) stays narrowed on purpose — it is what the agent
 * resolves a spoken name against, and "the lead form" should mean the one for
 * where they are, not a guess across fifty states.
 */
export async function libraryCatalog(q: Exec, landlordIds: string[]) {
  const docs = await q.query(
    `SELECT d.*, t.id AS adopted_template_id,
            (SELECT count(*) FROM lease_template_fields f WHERE f.template_id = t.id)::int AS adopted_field_count
       FROM disclosure_library_documents d
       LEFT JOIN lease_templates t
              ON t.library_document_id = d.id
             AND t.landlord_id = ANY($1::uuid[])
             AND t.is_active
      WHERE d.retired_at IS NULL AND d.superseded_by_id IS NULL
        AND (d.jurisdiction = 'US' OR d.jurisdiction IN (
              SELECT p.state FROM properties p WHERE p.landlord_id = ANY($1::uuid[]) AND p.state IS NOT NULL))
        AND (d.unit_types IS NULL OR d.unit_types && ARRAY(
              SELECT DISTINCT u.unit_type FROM units u
               WHERE u.landlord_id = ANY($1::uuid[]) AND u.retired_at IS NULL AND u.unit_type IS NOT NULL))
      ORDER BY (d.jurisdiction = 'US') DESC, d.jurisdiction, lower(d.name)`,
    [landlordIds]).then(r => r.rows)
  const states = await q.query(
    `SELECT DISTINCT p.state FROM properties p
      WHERE p.landlord_id = ANY($1::uuid[]) AND p.state IS NOT NULL
      ORDER BY p.state`, [landlordIds]).then(r => r.rows.map((x: any) => x.state as string))
  return { docs, operatingStates: states }
}

/**
 * Put a library form on this landlord's shelf.
 *
 * The result is a normal lease_templates row carrying library_document_id, which
 * is what makes it locked — see assertTemplateIsEditable. Fields come across as
 * the library wrote them. Adopting twice is a no-op rather than an error: the
 * landlord's intent ("I want this form") is already satisfied.
 */
export async function adoptLibraryDocument(
  q: Exec, landlordId: string, documentId: string
): Promise<{ templateId: string; alreadyHeld: boolean }> {
  const doc = await q.query(
    `SELECT * FROM disclosure_library_documents
      WHERE id=$1 AND retired_at IS NULL AND superseded_by_id IS NULL`, [documentId])
    .then(r => r.rows[0] as LibraryDocument | undefined)
  if (!doc) throw new AppError(404, 'That form is not on the shelf')

  const held = await q.query(
    `SELECT id FROM lease_templates WHERE landlord_id=$1 AND library_document_id=$2`,
    [landlordId, documentId]).then(r => r.rows[0])
  if (held) return { templateId: held.id, alreadyHeld: true }

  // purpose 'state_disclosure' is what the packet builder already groups
  // disclosures under; a federal form is the same kind of item to a packet.
  const tpl = await q.query(
    `INSERT INTO lease_templates
       (landlord_id, name, description, base_pdf_url, page_count, purpose,
        applies_to, disclosure_type, state_code, library_document_id)
     VALUES ($1,$2,$3,$4,$5,'state_disclosure',$6,$7,$8,$9)
     RETURNING id`,
    [landlordId, doc.name, doc.description, doc.base_pdf_url, doc.page_count,
     doc.applies_to, doc.disclosure_type,
     // 'US' is not a state; a federal form is not tagged to one.
     doc.jurisdiction === 'US' ? null : doc.jurisdiction,
     doc.id]).then(r => r.rows[0])

  await copyLibraryFields(q, doc.id, tpl.id)
  return { templateId: tpl.id, alreadyHeld: false }
}

/** The field map, library → template. Used on adoption and again on refresh. */
export async function copyLibraryFields(q: Exec, documentId: string, templateId: string) {
  await q.query(
    `INSERT INTO lease_template_fields
       (template_id, field_type, signer_role, label, lease_column, page,
        x, y, width, height, required, sort_order, options, default_value, checkbox_mark)
     SELECT $2, f.field_type, f.signer_role, f.label, f.lease_column, f.page,
            f.x, f.y, f.width, f.height, f.required, f.sort_order, f.options,
            f.default_value, f.checkbox_mark
       FROM disclosure_library_fields f
      WHERE f.document_id = $1
      ORDER BY f.sort_order`,
    [documentId, templateId])
}

/**
 * THE ANNUAL REFRESH — the reason a linked copy beat a download.
 *
 * Nic: "every year we just check on any updated documents and send them, or
 * update them in the pamphlet." A newer version of a form reaches every landlord
 * holding the old one, because they hold a LINK and not a file they downloaded
 * in 2026 and forgot.
 *
 * Safe to overwrite precisely because nobody could edit it. And it cannot reach
 * backwards: a document already drafted or sent carries its own base_pdf_url and
 * its own copied fields, so a tenant who signed version 1 signed version 1 and
 * the record still says so.
 */
export async function resyncAdoptions(q: Exec, supersededId: string, replacementId: string) {
  const next = await q.query(
    `SELECT * FROM disclosure_library_documents WHERE id=$1`, [replacementId])
    .then(r => r.rows[0] as LibraryDocument | undefined)
  if (!next) throw new AppError(404, 'Replacement form not found')

  const adopted = await q.query(
    `SELECT id FROM lease_templates WHERE library_document_id=$1`, [supersededId])
    .then(r => r.rows as Array<{ id: string }>)

  for (const t of adopted) {
    await q.query(
      `UPDATE lease_templates
          SET name=$2, description=$3, base_pdf_url=$4, page_count=$5,
              library_document_id=$6, version = version + 1, updated_at = now()
        WHERE id=$1`,
      [t.id, next.name, next.description, next.base_pdf_url, next.page_count, next.id])
    await q.query(`DELETE FROM lease_template_fields WHERE template_id=$1`, [t.id])
    await copyLibraryFields(q, next.id, t.id)
  }
  return adopted.length
}
