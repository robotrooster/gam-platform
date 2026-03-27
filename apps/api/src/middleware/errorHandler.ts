import { Request, Response, NextFunction } from 'express'

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status  = err.statusCode || 500
  const message = err.message || 'Internal server error'
  if (status === 500) console.error(err)
  res.status(status).json({ success: false, error: message })
}
