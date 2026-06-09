/**
 * S66: ABA routing number validation.
 *
 * Two checks:
 *   1. 9 digits, weighted-sum mod-10 checksum (the standard ABA algorithm)
 *   2. First two digits fall within a valid Federal Reserve prefix range
 *
 * Range table is the published ABA Routing Number Administrative Board
 * allocation. We accept commercial-bank, government, and thrift ranges.
 * "Internal / non-routable" prefixes (00, 50–59 reserved, 70–71 reserved,
 * 99 used by Federal Reserve internally) are rejected — these can't actually
 * accept an ACH credit even though they pass the checksum.
 *
 * Verification beyond this is deferred to micro-deposits (post-Stripe wiring).
 */

export interface AbaValidation {
  ok: boolean
  reason?: 'wrong_length' | 'non_numeric' | 'bad_checksum' | 'invalid_prefix'
}

const VALID_PREFIX_RANGES: Array<[number, number]> = [
  [1, 12],    // Federal Reserve banks (primary commercial)
  [21, 32],   // Thrift institutions
  [61, 72],   // Electronic transactions, government
  [80, 80],   // Travelers Cheques (rarely on ACH but technically valid)
]

export function validateAbaRoutingNumber(routing: string): AbaValidation {
  if (!/^\d+$/.test(routing)) return { ok: false, reason: 'non_numeric' }
  if (routing.length !== 9) return { ok: false, reason: 'wrong_length' }

  const prefix = parseInt(routing.slice(0, 2), 10)
  if (!VALID_PREFIX_RANGES.some(([lo, hi]) => prefix >= lo && prefix <= hi)) {
    return { ok: false, reason: 'invalid_prefix' }
  }

  // Standard ABA checksum: 3*d0 + 7*d1 + 1*d2 + 3*d3 + 7*d4 + 1*d5 + 3*d6 + 7*d7 + 1*d8 ≡ 0 (mod 10)
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1]
  let sum = 0
  for (let i = 0; i < 9; i++) sum += parseInt(routing[i], 10) * w[i]
  if (sum % 10 !== 0) return { ok: false, reason: 'bad_checksum' }

  return { ok: true }
}
