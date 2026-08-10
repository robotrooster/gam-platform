/**
 * Money formatters for the landlord portal.
 *
 * - fmtCompact — narrow KPI tiles (property cards, the Properties top-summary row).
 *   Keeps every tile the same width no matter how big the number gets:
 *   $18,400 · $248.6K · $1.24M. (S60x, Nic.)
 * - fmtWhole — roomy dashboard KPI cards: full dollars, no cents ($248,600).
 *
 * Tables and detail pages keep their own exact (with-cents) formatter — precise
 * figures belong there, not on glance cards.
 */

/** Full dollars with thousands separators, no cents — e.g. $248,600. */
export const fmtWhole = (n: any): string =>
  n != null && isFinite(Number(n)) ? `$${Math.round(Number(n)).toLocaleString('en-US')}` : '—'

/** Compact currency for narrow tiles — $18,400 / $248.6K / $1.24M. */
export const fmtCompact = (n: any): string => {
  if (n == null || !isFinite(Number(n))) return '—'
  const v = Number(n)
  const a = Math.abs(v)
  let out: string
  if (a >= 1_000_000)   out = `$${(a / 1_000_000).toFixed(2)}M`
  else if (a >= 100_000) out = `$${(a / 1_000).toFixed(1)}K`
  else                   out = `$${Math.round(a).toLocaleString('en-US')}`
  return v < 0 ? `-${out}` : out
}
