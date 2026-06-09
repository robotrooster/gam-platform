/**
 * Structured logging for apps/api.
 *
 * Two exports:
 *   - `logger`        — process-wide pino instance. Use for boot
 *                       messages, cron logs, anything outside an
 *                       HTTP request.
 *   - `httpLogger`    — pino-http middleware. Mounted in index.ts;
 *                       attaches `req.log` (a child logger tagged
 *                       with the request id) to every request and
 *                       emits a one-line summary per request when
 *                       the response finishes.
 *
 * Output format:
 *   - dev (`NODE_ENV !== 'production'`) → pino-pretty (colorized,
 *     human-readable single line per record).
 *   - prod → raw JSON. Each record is one line; pipe to a log
 *     aggregator (Datadog / Logtail / hosting platform's log
 *     viewer) for parsing.
 *
 * Level via `LOG_LEVEL` env var; defaults to `info` (or `debug` in
 * test so test-time captures are visible).
 *
 * Notes:
 *   - The legacy `console.log` / `console.error` calls scattered
 *     through the codebase (~330 sites) keep working — pino does
 *     not hijack `console`. Migration is incremental; this file
 *     unblocks new code and the call sites the launch-critical
 *     paths touch.
 *   - When SENTRY_DSN is set, errors land in Sentry independently
 *     of what logger.error does here. The two systems are
 *     complementary: logger gives a structured stream; Sentry
 *     gives alertable triage.
 */

import pino, { type LoggerOptions } from 'pino'
import pinoHttp, { type HttpLogger } from 'pino-http'
import { randomUUID } from 'crypto'

const isProd = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST_POOL_ID

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isTest ? 'warn' : 'info'),
  base: {
    // Each record gets these context fields. `app` is a constant; if
    // we ever ship multiple Node processes (e.g. a worker for cron),
    // distinguish them via APP_NAME so aggregator queries can filter.
    app: process.env.APP_NAME || 'gam-api',
  },
  // Standard timestamp + ISO format. Pino's default `Date.now()`
  // milliseconds is fine for prod (cheap, sortable) but ISO is
  // human-readable for log viewers that don't pretty-print.
  timestamp: pino.stdTimeFunctions.isoTime,
}

const transport = !isProd && !isTest
  ? {
      // pino-pretty for dev. Lazy-loaded by pino, only required when
      // it's actually needed. Disable in test to keep vitest output
      // clean — pretty's color codes pollute the snapshot.
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,app',
      },
    }
  : undefined

const pinoLogger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
})

// Widened call-signature so cold-path callers that pass printf-style
// args — `logger.error('[X]', err)` or `logger.error('[X] for', id, err)`
// — type-check without each one needing the strict
// `{ err, ...ctx }, 'msg'` structured form. Pino's runtime accepts
// both shapes; only the TS overloads are narrower than the runtime.
// Hot-path call sites (webhooks, scheduler, cron jobs) still pass the
// structured form by convention — this loosening is for cold paths.
type LooseLog = (...args: any[]) => void
type LooseLogger = {
  error: LooseLog
  warn:  LooseLog
  info:  LooseLog
  debug: LooseLog
  trace: LooseLog
  fatal: LooseLog
  child: (bindings: Record<string, unknown>) => LooseLogger
}

export const logger: LooseLogger = pinoLogger as unknown as LooseLogger

// pino-http: per-request child logger + auto-summary on response end.
// `genReqId` lets us either trust an upstream tracing header
// (X-Request-Id) or mint our own UUID; either way the same id rides
// the request through the handler so all log lines tagged with it
// stitch together.
export const httpLogger: HttpLogger = pinoHttp({
  logger: pinoLogger,
  genReqId: (req, res) => {
    const inbound = (req.headers['x-request-id']) as string | undefined
    const id = inbound || randomUUID()
    res.setHeader('X-Request-Id', id)
    return id
  },
  // Custom level mapping: 5xx → error, 4xx → warn (acks the client
  // hit a guard but the server's healthy), everything else → info.
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
  // Trim the auto-summary to fields ops actually scan for.
  serializers: {
    req: (req) => ({
      id:     req.id,
      method: req.method,
      url:    req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
})
