/**
 * S582: async auto-field placement jobs.
 *
 * The upload kicks off a job (createAutoFieldJob) and returns immediately; the
 * route fires runAutoFieldJob WITHOUT awaiting, so no HTTP request is held open
 * while the AI model works (Cloudflare's ~100s edge timeout can never bite). The
 * editor polls getAutoFieldJob until status leaves 'processing', then loads the
 * placed fields. runAutoFieldJob is self-contained + catches all errors (it runs
 * detached from any request), recording them on the job row rather than crashing.
 */
import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { autoPlaceFields } from './autoFieldPlacement'
import { extractUploadFilename } from '../lib/uploadPaths'

const uploadDir = path.join(process.cwd(), 'uploads', 'leases')

export interface AutoFieldJob {
  id:          string
  template_id: string
  landlord_id: string
  status:      'processing' | 'done' | 'error'
  result:      any | null
  error:       string | null
  created_at:  string
  updated_at:  string
}

/** Create a 'processing' job for a template. Ownership is checked by the caller. */
export async function createAutoFieldJob(templateId: string, landlordId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO auto_field_jobs (template_id, landlord_id, status)
     VALUES ($1, $2, 'processing') RETURNING id`,
    [templateId, landlordId])
  return row!.id
}

/** Fetch a job scoped to its owning landlord (null if not found / not theirs). */
export async function getAutoFieldJob(jobId: string, landlordId: string): Promise<AutoFieldJob | null> {
  return queryOne<AutoFieldJob>(
    `SELECT * FROM auto_field_jobs WHERE id = $1 AND landlord_id = $2`,
    [jobId, landlordId])
}

/**
 * Run the placement for a job and record the outcome. Detached (fire-and-forget)
 * — never throws to the caller; every failure lands on the job row as 'error' so
 * the poller can surface it. The template's PDF is re-read here (the route only
 * validated it exists at enqueue time).
 */
export async function runAutoFieldJob(jobId: string): Promise<void> {
  try {
    const job = await queryOne<{ template_id: string }>(
      `SELECT template_id FROM auto_field_jobs WHERE id = $1`, [jobId])
    if (!job) return

    const tmpl = await queryOne<{ base_pdf_url: string | null }>(
      `SELECT base_pdf_url FROM lease_templates WHERE id = $1`, [job.template_id])
    const filename = tmpl?.base_pdf_url ? extractUploadFilename(tmpl.base_pdf_url) : null
    const pdfPath = filename ? path.join(uploadDir, filename) : null
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      await query(
        `UPDATE auto_field_jobs SET status='error', error=$2, updated_at=now() WHERE id=$1`,
        [jobId, 'Template PDF not found on disk'])
      return
    }

    const result = await autoPlaceFields(fs.readFileSync(pdfPath))
    await query(
      `UPDATE auto_field_jobs SET status='done', result=$2, updated_at=now() WHERE id=$1`,
      [jobId, JSON.stringify(result)])
  } catch (e: any) {
    logger.error({ err: e, jobId }, '[auto-field-job] failed')
    await query(
      `UPDATE auto_field_jobs SET status='error', error=$2, updated_at=now() WHERE id=$1`,
      [jobId, e?.message || 'Auto-placement failed']).catch(() => {})
  }
}
