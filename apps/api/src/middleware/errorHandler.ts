import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger } from '../lib/logger'

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
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
  if (status >= 500) {
    // Prefer the per-request child logger (carries request id) when
    // available; fall back to the process logger if pino-http
    // hasn't attached one (e.g. error thrown before middleware ran).
    const log = ((req as any).log ?? logger) as typeof logger
    log.error({ err, status }, 'request failed (5xx)')
  }
  res.status(status).json({ success: false, error: message })
}
