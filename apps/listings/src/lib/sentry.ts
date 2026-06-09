// Sentry browser-side error tracking. Mirrors the api-side instrument.ts
// posture (S273): inits only when VITE_SENTRY_DSN is set, so dev + local
// builds stay noise-free. 4xx errors are filtered out via beforeSend;
// 5xx and uncaught render exceptions land in Sentry.
//
// Vite injects import.meta.env.VITE_* values at build time. To enable in
// production, set VITE_SENTRY_DSN in the deploy environment before
// running `vite build`.

import * as Sentry from '@sentry/react'

// Each app's tsconfig differs on whether Vite's import.meta.env typings
// are included. Cast to any to stay compatible across all 9 apps.
const env = (import.meta as any).env || {}
const dsn = env.VITE_SENTRY_DSN as string | undefined

if (dsn) {
  Sentry.init({
    dsn,
    environment: env.MODE || 'development',
    release: env.VITE_SENTRY_RELEASE as string | undefined,
    // Tracing off by default — flip on by adding browserTracingIntegration()
    // once the launch volume justifies the quota cost.
    tracesSampleRate: 0,
    // Don't auto-attach PII (user emails, IPs, request headers). GAM ferries
    // tenant + landlord PII; opt in per-capture if it's actually useful.
    sendDefaultPii: false,
    beforeSend(_event, hint) {
      // Filter expected 4xx (axios HTTP errors) — only 5xx + uncaught
      // exceptions are interesting for ops. axios stores status under
      // err.response.status; raw Error may have statusCode.
      const err = hint.originalException as
        | { statusCode?: number; response?: { status?: number } }
        | undefined
      const status = err?.response?.status ?? err?.statusCode
      if (typeof status === 'number' && status < 500) return null
      return _event
    },
  })
}

export { Sentry }
export const SentryErrorBoundary = Sentry.ErrorBoundary
