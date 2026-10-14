import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger, redactLoggedUrl } from '../lib/logger'

export class AppError extends Error {
  /**
   * 10/12 review: `details` — optional plain fields a client can act on
   * beside the sentence (e.g. { code: 'MATCH_FIRST', matches: [...] } when a
   * bank line going out fits a record GAM already has). Sent as top-level
   * keys of the error reply; never `success` or `error`.
   */
  constructor(public statusCode: number, message: string, public details?: Record<string, unknown>) {
    super(message)
  }
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // S279: ZodError → 400 with the parser's issue summary. Without
  // this branch, every route that uses zod's `.parse()` surfaced
  // bad input as a 500. The first ZodError-issue message is the
  // most useful for clients; the full list is included alongside
  // for callers that want field-level surfacing.
  if (err instanceof ZodError) {
    const summary = err.issues[0]
      ? `${err.issues[0].path.join('.') || 'request'}: ${err.issues[0].message}`
      : 'Invalid request'
    return res.status(400).json({
      success: false,
      error: summary,
      issues: err.issues,
    })
  }

  const status  = err.statusCode || 500
  const message = err.message || 'Internal server error'
  if (status >= 400 && status < 500 && req.method !== 'GET') {
    // S652: a rejected write used to log only its status code. When a landlord
    // reports "it just reloads", the reason has to be in the log.
    const log = ((req as any).log ?? logger) as typeof logger
    // 10/13: never a live invitation token (lib/logger redactLoggedUrl).
    log.warn({ status, reason: message, path: redactLoggedUrl(req.originalUrl) }, 'request rejected (4xx)')
  }
  if (status >= 500) {
    // Prefer the per-request child logger (carries request id) when
    // available; fall back to the process logger if pino-http
    // hasn't attached one (e.g. error thrown before middleware ran).
    const log = ((req as any).log ?? logger) as typeof logger
    log.error({ err, status }, 'request failed (5xx)')
  }
  const extra = err instanceof AppError && err.details && status < 500 ? err.details : {}
  res.status(status).json({ ...extra, success: false, error: message })
}
