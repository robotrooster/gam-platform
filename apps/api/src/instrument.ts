/**
 * Sentry instrumentation entry point.
 *
 * Must be imported BEFORE any other module that we want Sentry to
 * auto-instrument (express, pg, etc.). `src/index.ts` does this as
 * its very first import — order matters because Sentry v8 uses
 * OpenTelemetry under the hood and instruments modules at load time.
 *
 * If `SENTRY_DSN` is not set, init is skipped entirely and every
 * subsequent Sentry call is a quiet no-op. That keeps dev + test
 * environments noise-free (no captures, no network calls) without
 * sprinkling `if (process.env.SENTRY_DSN)` guards through the
 * codebase.
 */

import * as Sentry from '@sentry/node'

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Release tagging — populated by the deploy pipeline once we
    // wire one. Falls back to undefined (Sentry uses its default
    // grouping) until then.
    release: process.env.SENTRY_RELEASE,
    // Performance tracing sample rate: 10% in prod, 100% in
    // staging/preview to surface slow paths during pre-launch
    // smoke walks. Bump or drop after launch based on quota.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Don't capture request bodies / cookies / headers by default —
    // GAM ferries PII (tenant + landlord names, addresses, SSN-ish
    // background-check inputs) and we want explicit opt-in per
    // capture if any of it is actually useful for diagnosing. Same
    // posture as the data-stays-on-GAM rule in CLAUDE.md.
    sendDefaultPii: false,
    // Filter out 4xx errors from auto-capture; only 5xx + uncaught
    // exceptions are interesting for ops. Custom captures via
    // Sentry.captureException can still fire for specific cases.
    beforeSend(event, hint) {
      const err = hint.originalException as { statusCode?: number } | undefined
      if (err && typeof err.statusCode === 'number' && err.statusCode < 500) {
        return null
      }
      return event
    },
  })
}
