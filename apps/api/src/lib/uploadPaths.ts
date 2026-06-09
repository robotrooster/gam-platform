import path from 'path'

const UPLOAD_BASENAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Extract a safe filename from an upload URL or path.
 * Rejects empty/dot/dotdot results, path traversal, and any char outside
 * [A-Za-z0-9_.-]. Returns null on invalid input.
 *
 * Examples:
 *   '/api/esign/files/abc-123.pdf' -> 'abc-123.pdf'
 *   '../etc/passwd'                -> null
 *   ''                             -> null
 */
export function extractUploadFilename(url: string | null | undefined): string | null {
  if (!url) return null
  const base = path.basename(url)
  if (!base || base === '.' || base === '..') return null
  if (!UPLOAD_BASENAME_RE.test(base)) return null
  return base
}

/**
 * Resolve a filename to a path inside the configured upload directory.
 * Returns null if extraction fails or the result escapes uploadDir.
 * Belt + suspenders: extractUploadFilename strips path components, and
 * path.relative confirms the join did not escape.
 */
export function resolveUploadPath(uploadDir: string, url: string | null | undefined): string | null {
  const filename = extractUploadFilename(url)
  if (!filename) return null
  const resolved = path.join(uploadDir, filename)
  const rel = path.relative(uploadDir, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}
