import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stampPdf } from '../services/pdfStamp'
import crypto from 'crypto'

export const esignRouter = Router()

// ── EMAIL HELPERS ─────────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string) {
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`)
  // Swap for SendGrid: await sgMail.send({ to, from: 'noreply@gamplatform.com', subject, html })
}

function emailBase(body: string) {
  return `<!DOCTYPE html><html><head><style>
    body{font-family:system-ui,sans-serif;background:#f5f5f0;margin:0;padding:20px}
    .c{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0}
    .h{background:#0a0d10;padding:20px 28px;display:flex;align-items:center;gap:10px}
    .logo{font-size:18px;font-weight:800;color:#c9a227}
    .b{padding:28px}.title{font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:12px}
    .text{font-size:14px;line-height:1.7;color:#444}
    .btn{display:inline-block;margin-top:20px;padding:14px 28px;background:#c9a227;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:15px}
    .foot{padding:16px 28px;border-top:1px solid #e2e8f0;font-size:11px;color:#888}
  </style></head><body><div class="c">
    <div class="h"><div class="logo">⚡ GAM</div><div style="color:#888;font-size:12px;margin-left:8px">Gold Asset Management</div></div>
    <div class="b">${body}</div>
    <div class="foot">Gold Asset Management LLC · Arizona · This is an automated message.</div>
  </div></body></html>`
}

async function sendSigningRequest(signer: any, document: any, unit: any) {
  const signingUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/sign/${signer.token}`
  await sendEmail(signer.email, `Please sign: ${document.title}`,
    emailBase(`
      <div class="title">Document Ready for Your Signature</div>
      <div class="text">
        Hi ${signer.name},<br><br>
        <b>${document.landlord_name || 'Your landlord'}</b> has sent you a document to review and sign:<br><br>
        <b>${document.title}</b><br>
        Unit ${unit.unit_number} — ${unit.property_name}<br><br>
        Please review the document carefully before signing. This is a legally binding agreement under UETA and the federal E-SIGN Act.
      </div>
      <a href="${signingUrl}" class="btn">Review &amp; Sign Document →</a>
      <div class="text" style="margin-top:16px;font-size:12px;color:#888">
        This link is unique to you and expires in 30 days. Do not share it with others.
      </div>
    `)
  )
}

async function sendPortalInvite(signer: any, unit: any, landlordName: string) {
  // Check if user already exists
  const existing = await queryOne('SELECT id FROM users WHERE email=$1', [signer.email]).catch(() => null)
  if (existing) return // already has account, no invite needed

  // Generate invite token via the tenants invite system if unit exists
  let inviteUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/accept-invite`
  if (signer.unitId) {
    try {
      const crypto = require('crypto')
      const token = crypto.randomBytes(32).toString('hex')
      await query('UPDATE units SET invite_token=$1, invite_sent_at=NOW() WHERE id=$2', [token, signer.unitId])
      inviteUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/accept-invite?token=${token}`
    } catch(e) { /* fallback to basic invite */ }
  }
  await sendEmail(signer.email, `You're invited to GAM — Unit ${unit.unit_number}`,
    emailBase(`
      <div class="title">Welcome to Gold Asset Management</div>
      <div class="text">
        Hi ${signer.name},<br><br>
        <b>${landlordName}</b> has invited you to manage your tenancy through the GAM platform for Unit ${unit.unit_number} at ${unit.property_name}.<br><br>
        Through your tenant portal you can:
        <ul style="margin:12px 0;padding-left:20px">
          <li>View and sign your lease</li>
          <li>Track rent payments</li>
          <li>Submit maintenance requests</li>
          <li>Manage your account</li>
        </ul>
      </div>
      <a href="${inviteUrl}" class="btn">Create Your Account →</a>
    `)
  )
}

async function sendCompletionEmail(signer: any, document: any, unit: any, pdfUrl?: string) {
  await sendEmail(signer.email, `✅ Document fully signed: ${document.title}`,
    emailBase(`
      <div class="title">Document Fully Executed</div>
      <div class="text">
        Hi ${signer.name},<br><br>
        All parties have signed <b>${document.title}</b> for Unit ${unit.unit_number} at ${unit.property_name}.<br><br>
        ${pdfUrl ? `A copy of the fully executed document is available for download.` : 'A copy will be available in your portal shortly.'}<br><br>
        <b>Signed on:</b> ${new Date().toLocaleDateString()}<br>
        <b>Document status:</b> Fully Executed
      </div>
      ${pdfUrl ? `<a href="${pdfUrl}" class="btn">Download Signed Document →</a>` : ''}
    `)
  )
}

// ── TEMPLATES ─────────────────────────────────────────────────

esignRouter.get('/templates', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const templates = await query<any>(`
      SELECT t.*, COUNT(f.id)::int as field_count
      FROM lease_templates t
      LEFT JOIN lease_template_fields f ON f.template_id = t.id
      WHERE t.landlord_id = $1 AND t.is_active = TRUE
      GROUP BY t.id ORDER BY t.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: templates })
  } catch (e) { next(e) }
})

esignRouter.post('/templates', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount } = req.body
    if (!name) throw new AppError(400, 'Template name required')
    const t = await queryOne<any>(`
      INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.profileId, name, description||null, basePdfUrl||null, pageCount||1])
    res.status(201).json({ success: true, data: t })
  } catch (e) { next(e) }
})

esignRouter.get('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    const fields = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order, y', [template.id])
    res.json({ success: true, data: { ...template, fields } })
  } catch (e) { next(e) }
})

esignRouter.patch('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount, isActive } = req.body
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!t) throw new AppError(404, 'Template not found')
    const updated = await queryOne<any>(`
      UPDATE lease_templates SET name=$1, description=$2, base_pdf_url=$3, page_count=$4, is_active=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *`,
      [name??t.name, description??t.description, basePdfUrl??t.base_pdf_url, pageCount??t.page_count, isActive??t.is_active, t.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── TEMPLATE FIELDS ────────────────────────────────────────────

esignRouter.post('/templates/:id/fields', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { fieldType, signerRole, label, page, x, y, width, height, required, sortOrder } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    const field = await queryOne<any>(`
      INSERT INTO lease_template_fields (template_id, field_type, signer_role, label, page, x, y, width, height, required, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [template.id, fieldType, signerRole, label||null, page||1, x, y, width||200, height||50, required??true, sortOrder||0])
    res.status(201).json({ success: true, data: field })
  } catch (e) { next(e) }
})

esignRouter.put('/templates/:id/fields', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    // Bulk replace all fields
    const { fields } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    await query('DELETE FROM lease_template_fields WHERE template_id=$1', [template.id])
    for (const f of fields) {
      await query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, label, page, x, y, width, height, required, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [template.id, f.fieldType, f.signerRole, f.label||null, f.page||1, f.x, f.y, f.width||200, f.height||50, f.required??true, f.sortOrder||0])
    }
    const updated = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order', [template.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id/fields/:fieldId', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    await query('DELETE FROM lease_template_fields WHERE id=$1 AND template_id=$2', [req.params.fieldId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── DOCUMENTS ─────────────────────────────────────────────────

esignRouter.get('/documents', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const docs = await query<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        COUNT(DISTINCT s.id)::int as signer_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status='signed')::int as signed_count
      FROM lease_documents d
      JOIN units u ON u.id = d.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_document_signers s ON s.document_id = d.id
      WHERE d.landlord_id = $1
      GROUP BY d.id, u.unit_number, p.name
      ORDER BY d.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})

esignRouter.post('/documents', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { templateId, unitId, title, signers, basePdfUrl } = req.body
    // signers: [{role, name, email, phone, orderIndex}]
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    const unit = unitId ? await queryOne<any>('SELECT u.*, p.name as property_name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [unitId]) : null

    // Copy fields from template if provided
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1', [templateId])
      if (tmpl) pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    const doc = await queryOne<any>(`
      INSERT INTO lease_documents (template_id, landlord_id, unit_id, title, base_pdf_url)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [templateId||null, req.user!.profileId, unitId||null, title, pdfUrl||null])

    // Create signers with tokens
    for (const s of signers) {
      const token = crypto.randomBytes(32).toString('hex')
      await query(`INSERT INTO lease_document_signers (document_id, user_id, role, name, email, phone, order_index, token)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [doc!.id, s.userId||null, s.role, s.name, s.email, s.phone||null, s.orderIndex||1, token])
    }

    // Copy fields from template
    if (templateId) {
      const tmplFields = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1', [templateId])
      const docSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc!.id])
      for (const f of tmplFields) {
        const signer = (docSigners as any[]).find(s => s.role === f.signer_role)
        await query(`INSERT INTO lease_document_fields (document_id, template_field_id, signer_id, field_type, signer_role, label, page, x, y, width, height, required)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [doc!.id, f.id, signer?.id||null, f.field_type, f.signer_role, f.label, f.page, f.x, f.y, f.width, f.height, f.required])
      }
    }

    res.status(201).json({ success: true, data: { ...doc, unit } })
  } catch (e) { next(e) }
})

esignRouter.get('/documents/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      JOIN units u ON u.id = d.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
      WHERE d.id = $1`, [req.params.id])
    if (!doc) throw new AppError(404, 'Document not found')
    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])
    const fields  = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1 ORDER BY page, y', [doc.id])
    res.json({ success: true, data: { ...doc, signers, fields } })
  } catch (e) { next(e) }
})

// ── SEND DOCUMENT ─────────────────────────────────────────────

esignRouter.post('/documents/:id/send', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1 AND d.landlord_id=$2`, [req.params.id, req.user!.profileId])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(400, 'Document already completed')

    // Get first signer in order
    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])
    const firstSigner = (signers as any[]).find(s => s.order_index === 1)
    if (!firstSigner) throw new AppError(400, 'No signers configured')

    // Send signing request + portal invite to first signer
    await sendSigningRequest(firstSigner, doc, doc)
    await sendPortalInvite(firstSigner, doc, doc.landlord_name)

    // Update statuses
    await query("UPDATE lease_documents SET status='sent', sent_at=NOW() WHERE id=$1", [doc.id])
    await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE WHERE id=$1", [firstSigner.id])

    res.json({ success: true, data: { sentTo: firstSigner.email } })
  } catch (e) { next(e) }
})

// ── SIGNING VIEW (public — token-based) ───────────────────────

esignRouter.get('/sign/:token', async (req, res, next) => {
  try {
    const signer = await queryOne<any>('SELECT * FROM lease_document_signers WHERE token=$1', [req.params.token])
    if (!signer) throw new AppError(404, 'Invalid or expired signing link')
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    if (!doc) throw new AppError(404, 'Document not found')

    const fields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1 AND signer_role=$2 ORDER BY page, y', [doc.id, signer.role])

    // Mark as viewed
    if (signer.status === 'sent') {
      await query("UPDATE lease_document_signers SET status='viewed', viewed_at=NOW() WHERE id=$1", [signer.id])
    }

    res.json({ success: true, data: { signer, document: doc, fields } })
  } catch (e) { next(e) }
})

// ── SUBMIT SIGNATURES (public — token-based) ──────────────────

esignRouter.post('/sign/:token', async (req, res, next) => {
  try {
    const { fieldValues } = req.body
    // fieldValues: [{fieldId, value}]

    const signer = await queryOne<any>('SELECT * FROM lease_document_signers WHERE token=$1', [req.params.token])
    if (!signer) throw new AppError(404, 'Invalid signing link')
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, lu.first_name || ' ' || lu.last_name as landlord_name, lu.email as landlord_email
      FROM lease_documents d JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
    const ua = req.headers['user-agent']

    // Store field values
    for (const fv of (fieldValues || [])) {
      await query('UPDATE lease_document_fields SET value=$1, signed_at=NOW(), signer_id=$2 WHERE id=$3 AND document_id=$4',
        [fv.value, signer.id, fv.fieldId, doc!.id])
    }

    // Mark signer as signed
    await query("UPDATE lease_document_signers SET status='signed', signed_at=NOW(), ip_address=$1, user_agent=$2 WHERE id=$3",
      [ip, ua, signer.id])

    // Update document status
    await query("UPDATE lease_documents SET status='in_progress', updated_at=NOW() WHERE id=$1", [doc!.id])

    // Check if all signed
    const remaining = await queryOne<any>(
      "SELECT COUNT(*)::int as count FROM lease_document_signers WHERE document_id=$1 AND status != 'signed'",
      [doc!.id])

    if (remaining?.count === 0) {
      // All signed — mark complete
      await query("UPDATE lease_documents SET status='completed', completed_at=NOW() WHERE id=$1", [doc!.id])
      // Stamp PDF with all signatures
      try {
        const allFields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1', [doc!.id])
        const allSigners2 = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc!.id])
        const sourcePdfPath = doc!.base_pdf_url.split('/').pop()
        const sourcePath = path.join(uploadDir, sourcePdfPath)
        if (fs.existsSync(sourcePath)) {
          const executedFilename = 'executed-' + doc!.id + '.pdf'
          const outputPath = path.join(uploadDir, executedFilename)
          const signerInfo = allSigners2.map((s:any) => ({ name:s.name, email:s.email, role:s.role, signed_at:s.signed_at }))
          await stampPdf(sourcePath, allFields.map((f:any) => ({
            page: parseInt(f.page)||1, x: parseFloat(f.x)||0, y: parseFloat(f.y)||0, width: parseFloat(f.width)||100, height: parseFloat(f.height)||30,
            field_type: f.field_type, value: f.value, font_css: f.font_css
          })), signerInfo, outputPath)
          const executedUrl = '/api/esign/files/' + executedFilename
          await query('UPDATE lease_documents SET executed_pdf_url=$1 WHERE id=$2', [executedUrl, doc!.id])
          if (doc!.unit_id) {
            await query('UPDATE leases SET document_url=$1, signed_by_tenant=TRUE, signed_by_landlord=TRUE WHERE unit_id=$2',
              [executedUrl, doc!.unit_id]).catch(()=>{})
          }
          console.log('[ESIGN] PDF stamped:', executedFilename)
        } else {
          console.warn('[ESIGN] Source PDF not found:', sourcePath)
        }
      } catch(e) { console.error('[ESIGN] PDF stamp failed:', e) }

      // Send completion email to ALL signers
      const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc!.id])
      for (const s of allSigners as any[]) {
        await sendCompletionEmail(s, doc!, doc!, doc!.completed_pdf_url)
      }
      // Also notify landlord
      await sendCompletionEmail({ name: 'Landlord', email: doc!.landlord_email }, doc!, doc!, doc!.completed_pdf_url)

      res.json({ success: true, data: { completed: true } })
    } else {
      // Notify next signer in order
      const nextSigner = await queryOne<any>(`
        SELECT * FROM lease_document_signers
        WHERE document_id=$1 AND status='pending'
        ORDER BY order_index LIMIT 1`, [doc!.id])
      if (nextSigner) {
        await sendSigningRequest(nextSigner, doc!, doc!)
        await sendPortalInvite(nextSigner, doc!, doc!.landlord_name)
        await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE WHERE id=$1", [(nextSigner as any).id])
      }
      res.json({ success: true, data: { completed: false, nextSigner: (nextSigner as any)?.email } })
    }
  } catch (e) { next(e) }
})

// ── VOID DOCUMENT ─────────────────────────────────────────────

esignRouter.post('/documents/:id/void', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { reason } = req.body
    const doc = await queryOne<any>('SELECT * FROM lease_documents WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(400, 'Cannot void a completed document')
    await query("UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1 WHERE id=$2", [reason||null, doc.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── FILE UPLOAD ───────────────────────────────────────────────
import multer from 'multer'
import path from 'path'
import fs from 'fs'

const uploadDir = path.join(process.cwd(), 'uploads', 'leases')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req: any, file: any, cb: any) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
    cb(null, unique + path.extname(file.originalname))
  }
})

const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (req: any, file: any, cb: any) => { if (file.mimetype === 'application/pdf') cb(null, true); else cb(new Error('PDF only')) } })

esignRouter.post('/upload', requireAuth, requireLandlord, upload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const fileUrl = '/api/esign/files/' + req.file.filename
    // Detect page count by counting /Type /Page entries in PDF
    let pageCount = 1
    try {
      const fileBuffer = fs.readFileSync(req.file.path).toString('binary')
      const matches = fileBuffer.match(/\/Type\s*\/Page[^s]/g)
      if (matches) pageCount = matches.length
    } catch(e) { /* fallback to 1 */ }
    res.json({ success: true, data: { url: fileUrl, filename: req.file.originalname, size: req.file.size, pageCount } })
  } catch (e) { next(e) }
})

esignRouter.get('/files/:filename', async (req: any, res: any, next: any) => {
  try {
    const filePath = path.join(uploadDir, req.params.filename)
    if (!fs.existsSync(filePath)) throw new AppError(404, 'File not found')
    res.sendFile(filePath)
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    await query('UPDATE lease_templates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// Tenant gets their pending signing documents
esignRouter.get('/pending', requireAuth, async (req, res, next) => {
  try {
    const pending = await query<any>(`
      SELECT s.token, s.role, s.status, d.title, d.base_pdf_url,
        u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      JOIN units u ON u.id = d.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = d.landlord_id
      JOIN users lu ON lu.id = l.user_id
      WHERE s.email = (SELECT email FROM users WHERE id = $1)
        AND s.status IN ('sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [req.user!.userId])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})

// Landlord gets documents pending their signature
esignRouter.get('/landlord-pending', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const pending = await query<any>(`
      SELECT s.token, s.status, s.name, d.id as document_id, d.title, d.status as doc_status,
        u.unit_number, p.name as property_name, d.base_pdf_url,
        (SELECT name FROM lease_document_signers WHERE document_id=d.id AND order_index=1 LIMIT 1) as tenant_name,
        (SELECT status FROM lease_document_signers WHERE document_id=d.id AND order_index=1 LIMIT 1) as tenant_status
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      JOIN units u ON u.id = d.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE d.landlord_id = $1
        AND s.email = (SELECT email FROM users WHERE id = (SELECT user_id FROM landlords WHERE id=$1))
        AND s.status IN ('sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})
