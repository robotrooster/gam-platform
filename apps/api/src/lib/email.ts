/**
 * S417: shared email-validation helpers extracted from the S411 inline
 * implementation in routes/tenants.ts.
 *
 * Originally inline because S411 had a single caller; S417 fans the
 * pattern out to /tenants/invite, /books/vendors, /books/contractors,
 * /books/employees, and /auth/register-prospect so all email-accepting
 * routes share the same disposable-domain block list.
 *
 * The list is intentionally a small hand-curated Set instead of the
 * `disposable-email-domains` npm package. The dependency cost
 * outweighs the curated-list value for launch posture; future hygiene
 * can swap if domain drift becomes painful.
 */

export const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'maildrop.cc',
  'getnada.com',
  'dispostable.com',
  'fakeinbox.com',
  'mintemail.com',
])

/**
 * Returns true when the email's domain is in the disposable block list.
 * Case-insensitive and trim-tolerant. Caller is responsible for format
 * validation (use zod's `.email()` first); this only checks the domain.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase().trim()
  return DISPOSABLE_EMAIL_DOMAINS.has(domain)
}
