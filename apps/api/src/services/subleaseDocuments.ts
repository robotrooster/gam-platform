/**
 * S251: Sublease agreement document generator + e-sign integration.
 *
 * When a landlord approves a sublease, this service creates the
 * agreement PDF + a lease_documents row of type='sublease_agreement',
 * registers sublessor + sublessee as signers, and triggers the
 * existing e-sign email flow. On both-party completion the executor
 * (in routes/esign.ts dispatch) flips sublease.status='active'.
 *
 * Template resolution (S251 product decision Nic-confirmed):
 *   - properties.sublease_agreement_template_url, if set, points to
 *     a landlord-uploaded PDF that's used as the base PDF (no merge
 *     fields rendered — landlord provides their own filled template).
 *   - Otherwise, GAM generates a default PDF programmatically via
 *     pdf-lib with parties, dates, amounts, and generic boilerplate.
 *     No state-specific language per CLAUDE.md.
 *
 * Output convention mirrors addendumPdf.ts:
 *   filesystem  → process.cwd()/uploads/subleases/<filename>
 *   served via  → /api/esign/files/<filename>
 *   filename    → sublease-<subleaseId>-<random8>.pdf
 */

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'subleases')

export interface GenerateSubleaseDocumentResult {
  documentId:  string
  filename:    string
  fileUrl:     string
  firstSignerEmail: string
}

interface SubleaseContext {
  id:                string
  master_lease_id:   string
  landlord_id:       string
  unit_id:           string
  unit_number:       string
  property_name:     string
  property_template_url: string | null
  landlord_name:     string
  sublessor_tenant_id:   string
  sublessor_user_id:     string
  sublessor_name:        string
  sublessor_email:       string
  sublessee_tenant_id:   string
  sublessee_user_id:     string
  sublessee_name:        string
  sublessee_email:       string
  start_date:        string
  end_date:          string | null
  sub_monthly_amount: string
  master_share_amount: string
  notes:             string | null
}

async function loadSubleaseContext(subleaseId: string): Promise<SubleaseContext> {
  const row = await queryOne<SubleaseContext>(`
    SELECT s.id, s.master_lease_id, l.landlord_id, l.unit_id,
           u.unit_number,
           p.name AS property_name,
           p.sublease_agreement_template_url AS property_template_url,
           lu.first_name || ' ' || lu.last_name AS landlord_name,
           s.sublessor_tenant_id, t_or.user_id AS sublessor_user_id,
           ur_or.first_name || ' ' || ur_or.last_name AS sublessor_name,
           ur_or.email AS sublessor_email,
           s.sublessee_tenant_id, t_ee.user_id AS sublessee_user_id,
           ur_ee.first_name || ' ' || ur_ee.last_name AS sublessee_name,
           ur_ee.email AS sublessee_email,
           s.start_date::text  AS start_date,
           s.end_date::text    AS end_date,
           s.sub_monthly_amount::text   AS sub_monthly_amount,
           s.master_share_amount::text  AS master_share_amount,
           s.notes
      FROM subleases s
      JOIN leases     l      ON l.id = s.master_lease_id
      JOIN units      u      ON u.id = l.unit_id
      JOIN properties p      ON p.id = u.property_id
      JOIN landlords  la     ON la.id = l.landlord_id
      JOIN users      lu     ON lu.id = la.user_id
      JOIN tenants    t_or   ON t_or.id = s.sublessor_tenant_id
      JOIN users      ur_or  ON ur_or.id = t_or.user_id
      JOIN tenants    t_ee   ON t_ee.id = s.sublessee_tenant_id
      JOIN users      ur_ee  ON ur_ee.id = t_ee.user_id
     WHERE s.id = $1`,
    [subleaseId],
  )
  if (!row) throw new AppError(404, 'Sublease not found or sublessee not yet linked')
  return row
}

async function generateDefaultPdf(ctx: SubleaseContext): Promise<{ filename: string; fileUrl: string; pageCount: number }> {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

  const pdfDoc = await PDFDocument.create()
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const page = pdfDoc.addPage([612, 792])
  const { width, height } = page.getSize()
  const margin = 54
  const black = rgb(0, 0, 0)
  const grey  = rgb(0.4, 0.4, 0.4)
  const gold  = rgb(0.788, 0.635, 0.153)

  let y = height - margin

  // Header
  page.drawText('SUBLEASE AGREEMENT', {
    x: margin, y, size: 22, font: helveticaBold, color: black,
  })
  y -= 8
  page.drawLine({
    start: { x: margin, y: y - 4 },
    end:   { x: width - margin, y: y - 4 },
    thickness: 1.5, color: gold,
  })
  y -= 28

  // Property + dates block
  const moneyFmt = (n: string) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const dateFmt  = (d: string | null) => d ? new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' }) : '(open-ended)'

  const infoLines: Array<[string, string]> = [
    ['Property:',  ctx.property_name],
    ['Unit:',      ctx.unit_number],
    ['Term:',      `${dateFmt(ctx.start_date)} – ${dateFmt(ctx.end_date)}`],
    ['Sub rent:',  `${moneyFmt(ctx.sub_monthly_amount)} / month, paid by the Sublessee to GAM`],
    ['Effective:', new Date().toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' })],
  ]
  for (const [label, value] of infoLines) {
    page.drawText(label, { x: margin,       y, size: 10, font: helveticaBold, color: grey })
    page.drawText(value, { x: margin + 110, y, size: 10, font: helvetica,     color: black })
    y -= 16
  }
  y -= 8

  // Parties
  page.drawText('PARTIES', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 16
  page.drawText('Sublessor (original tenant):', { x: margin, y, size: 10, font: helveticaBold, color: black })
  y -= 14
  page.drawText(`${ctx.sublessor_name} (${ctx.sublessor_email})`, { x: margin + 14, y, size: 10, font: helvetica, color: black })
  y -= 18
  page.drawText('Sublessee:', { x: margin, y, size: 10, font: helveticaBold, color: black })
  y -= 14
  page.drawText(`${ctx.sublessee_name} (${ctx.sublessee_email})`, { x: margin + 14, y, size: 10, font: helvetica, color: black })
  y -= 18
  page.drawText('Property owner:', { x: margin, y, size: 10, font: helveticaBold, color: black })
  y -= 14
  page.drawText(ctx.landlord_name, { x: margin + 14, y, size: 10, font: helvetica, color: black })
  y -= 18

  // Terms / boilerplate
  page.drawText('TERMS', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 16
  const terms = [
    '1. The Sublessor remains responsible to the property owner under the master lease.',
    '2. The Sublessee will pay rent on the schedule above directly through the GAM platform.',
    '3. The Sublessor is jointly and severally liable with the Sublessee for any unpaid rent',
    '   or damage caused during the sublease term. Damage may be charged against the master',
    '   lease security deposit.',
    '4. The Sublessee agrees to abide by all terms of the master lease, including any',
    '   property rules, occupancy limits, and conduct expectations.',
    '5. Either party may terminate this agreement under the conditions set out in the',
    '   master lease and applicable local law.',
    '6. This agreement is governed by the laws of the jurisdiction in which the property',
    '   is located. Each party is responsible for verifying compliance with local',
    '   landlord-tenant requirements.',
  ]
  for (const line of terms) {
    page.drawText(line, { x: margin, y, size: 10, font: helvetica, color: black })
    y -= 13
  }
  y -= 10
  if (ctx.notes) {
    page.drawText('ADDITIONAL NOTES', { x: margin, y, size: 10, font: helveticaBold, color: grey })
    y -= 14
    const wrapped = wrapText(ctx.notes, 92)
    for (const line of wrapped) {
      page.drawText(line, { x: margin, y, size: 10, font: helvetica, color: black })
      y -= 13
    }
    y -= 8
  }

  // Signatures
  page.drawText('SIGNATURES', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 22
  for (const [label, name] of [
    ['Sublessor', ctx.sublessor_name],
    ['Sublessee', ctx.sublessee_name],
  ] as const) {
    if (y < margin + 80) {
      const next = pdfDoc.addPage([612, 792])
      y = next.getSize().height - margin
    }
    page.drawText(`${label}: ${name}`, { x: margin, y, size: 10, font: helveticaBold, color: black })
    y -= 14
    page.drawLine({ start: { x: margin,       y }, end: { x: margin + 240, y }, thickness: 0.7, color: grey })
    page.drawLine({ start: { x: margin + 280, y }, end: { x: margin + 420, y }, thickness: 0.7, color: grey })
    y -= 11
    page.drawText('Signature', { x: margin,       y, size: 8, font: helvetica, color: grey })
    page.drawText('Date',      { x: margin + 280, y, size: 8, font: helvetica, color: grey })
    y -= 26
  }

  const pdfBytes = await pdfDoc.save()
  const filename = 'sublease-' + ctx.id + '-' + crypto.randomBytes(4).toString('hex') + '.pdf'
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), pdfBytes)
  return { filename, fileUrl: '/api/esign/files/' + filename, pageCount: pdfDoc.getPageCount() }
}

function wrapText(s: string, maxChars: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line)
      line = w
    } else {
      line = (line ? line + ' ' : '') + w
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Generate the sublease agreement document, register signers, and
 * trigger the first signing email. Returns the new lease_documents.id
 * so the caller (subleases approve route) can stamp it onto the
 * sublease row + flip status to 'awaiting_signatures'.
 *
 * Called from the landlord approve route — see routes/subleases.ts.
 */
export async function generateSubleaseDocument(args: {
  subleaseId: string
}): Promise<GenerateSubleaseDocumentResult> {
  const ctx = await loadSubleaseContext(args.subleaseId)

  // PDF source: landlord-uploaded property template (if set) wins;
  // else GAM default generated PDF.
  let pdfUrl: string
  let filename: string
  if (ctx.property_template_url) {
    pdfUrl = ctx.property_template_url
    filename = ctx.property_template_url.split('/').pop() || 'sublease-template.pdf'
  } else {
    const gen = await generateDefaultPdf(ctx)
    pdfUrl = gen.fileUrl
    filename = gen.filename
  }

  // Create lease_documents row + signers + initial state.
  const doc = await queryOne<{ id: string }>(
    `INSERT INTO lease_documents (
       template_id, landlord_id, unit_id, lease_id,
       title, base_pdf_url, document_type,
       status
     ) VALUES (NULL, $1, $2, NULL, $3, $4, 'sublease_agreement', 'pending')
     RETURNING id`,
    [
      ctx.landlord_id, ctx.unit_id,
      `Sublease Agreement — ${ctx.property_name} Unit ${ctx.unit_number}`,
      pdfUrl,
    ],
  )
  if (!doc) throw new AppError(500, 'Failed to create sublease document row')

  // Signers — sublessor first (they initiated), sublessee second.
  const signers = [
    { userId: ctx.sublessor_user_id, role: 'tenant',          name: ctx.sublessor_name, email: ctx.sublessor_email, order: 1 },
    { userId: ctx.sublessee_user_id, role: 'co_tenant',       name: ctx.sublessee_name, email: ctx.sublessee_email, order: 2 },
  ]
  for (const s of signers) {
    const token = crypto.randomBytes(32).toString('hex')
    await query(
      `INSERT INTO lease_document_signers
         (document_id, user_id, role, name, email, order_index, token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [doc.id, s.userId, s.role, s.name, s.email, s.order, token],
    )
  }

  // Link the document on the sublease row.
  await query(
    `UPDATE subleases SET sublease_document_id = $1, updated_at = NOW() WHERE id = $2`,
    [doc.id, args.subleaseId],
  )

  // Send first signing email + flip statuses to 'sent'.
  const firstSigner = signers[0]
  const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
  const signingUrl = `${tenantAppUrl}/sign/${doc.id}`

  try {
    const { emailSigningRequest } = await import('./email')
    await emailSigningRequest(
      firstSigner.email,
      firstSigner.name,
      `Sublease Agreement — ${ctx.property_name} Unit ${ctx.unit_number}`,
      `Unit ${ctx.unit_number} — ${ctx.property_name}`,
      ctx.landlord_name,
      signingUrl,
      { landlordId: ctx.landlord_id, documentId: doc.id },
    )
  } catch (e) {
    logger.error({ err: e }, '[SUBLEASE-DOC] signer email failed:')
  }

  await query(
    `UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [doc.id],
  )
  await query(
    `UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW()
      WHERE document_id=$1 AND order_index=1`,
    [doc.id],
  )

  return {
    documentId:       doc.id,
    filename,
    fileUrl:          pdfUrl,
    firstSignerEmail: firstSigner.email,
  }
}

/**
 * Completion hook — called from the e-sign dispatch when a
 * sublease_agreement document has both signers signed. Flips the
 * linked sublease to 'active' and stamps the document URL.
 *
 * S337: optional `externalClient` participates in the caller's
 * transaction (mirrors `generateMoveInInvoice` ownership pattern in
 * jobs/moveInBundle.ts). When buildLeaseFromDocument calls this from
 * its open BEGIN/COMMIT block, the sublease flip is now atomic with
 * the rest of the completion chain — if the outer txn rolls back,
 * the sublease status reverts too. Standalone call path (no client)
 * preserved for future one-shot use.
 */
export async function executeSubleaseAgreementCompletion(
  args: { documentId: string },
  externalClient?: PoolClient,
): Promise<{ subleaseId: string; status: string }> {
  const ownsClient = !externalClient
  const client: PoolClient = externalClient ?? await getClient()
  try {
    const docRes = await client.query<{ id: string; base_pdf_url: string; executed_pdf_url: string | null }>(
      `SELECT id, base_pdf_url, executed_pdf_url FROM lease_documents WHERE id = $1`,
      [args.documentId],
    )
    const doc = docRes.rows[0]
    if (!doc) throw new Error(`Sublease document ${args.documentId} not found`)

    const subRes = await client.query<{ id: string }>(
      `SELECT id FROM subleases WHERE sublease_document_id = $1`,
      [args.documentId],
    )
    const sublease = subRes.rows[0]
    if (!sublease) throw new Error(`Sublease for document ${args.documentId} not found`)

    await client.query(
      `UPDATE subleases
          SET status                = 'active',
              sublease_document_url = $1,
              landlord_consent_date = COALESCE(landlord_consent_date, CURRENT_DATE),
              updated_at            = NOW()
        WHERE id = $2`,
      [doc.executed_pdf_url || doc.base_pdf_url, sublease.id],
    )

    return { subleaseId: sublease.id, status: 'active' }
  } finally {
    if (ownsClient) client.release()
  }
}
