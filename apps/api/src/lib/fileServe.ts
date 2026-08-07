// Shared authed-file streaming (S594). The "resolve a stored /uploads/ url to
// disk, refuse path traversal, stream it" logic was copy-pasted per route
// (documents, resident-home-sale contracts, …). One security-sensitive copy is
// safer than N — a single place to get the traversal guard right.
//
// AUTHORIZATION IS THE CALLER'S JOB. This helper only owns path-safety +
// streaming; each route must authorize the row (per-landlord / per-tenant
// scope) BEFORE calling it. It never looks anything up and never trusts a
// filename.
import path from 'path'
import fs from 'fs'
import type { Response } from 'express'
import { AppError } from '../middleware/errorHandler'

const uploadsRoot = path.join(process.cwd(), 'uploads')

/**
 * Resolve a stored `/uploads/...` url to an absolute path, refusing anything
 * that would escape the uploads root (path traversal) even if the stored url
 * row is malformed. Throws AppError on a missing/foreign url.
 */
export function resolveUploadPath(url: string | null | undefined): string {
  if (!url || !url.startsWith('/uploads/')) throw new AppError(404, 'No stored file for this record')
  const abs = path.resolve(uploadsRoot, url.slice('/uploads/'.length))
  if (!abs.startsWith(uploadsRoot + path.sep)) throw new AppError(400, 'Bad file path')
  return abs
}

/**
 * Stream an already-authorized stored file to the response. Sets the mime type
 * when known. 404s (not 500s) when the row points at a file that was never
 * written. The caller MUST have authorized access to this row already.
 */
export function streamStoredFile(res: Response, url: string | null | undefined, mimeType?: string | null): void {
  const abs = resolveUploadPath(url)
  if (!fs.existsSync(abs)) throw new AppError(404, 'The file behind this record is missing')
  if (mimeType) res.type(mimeType)
  res.sendFile(abs)
}
