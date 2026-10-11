/**
 * S655 money plan, Step 13 — what a utility line on the tenant's bill is
 * called. Nic (10/3, decisions #17): bill lines name the utility — "Water",
 * "Electric", "Trash", "Sewer" — never a generic "Utilities".
 *
 * The server's own name for a line (services/invoiceNotice chargeLabel) comes
 * first whenever the row carries it (`label`, or the bill's `utilityType`).
 * Until every read sends one, the line is named from the words of its own note
 * ("Water — 1,240 gal …" is Water) and, failing that, by the note itself. A
 * note that is only about the payment ("Covered by…", "Recorded as…") never
 * names a line. The last resort is "Utility" — one charge, never "Utilities".
 */
import { UTILITY_TYPE_LABEL, type UtilityType } from '@gam/shared'

export interface UtilityLineRow {
  type?:        string | null
  /** The server's name for the line, when it sends one. */
  label?:       string | null
  /** The utility bill's type (water, electric, …), when it sends one. */
  utilityType?: string | null
  notes?:       string | null
}

// The same words the server reads a note by (services/invoiceNotice).
const UTILITY_WORDS: Array<[RegExp, UtilityType]> = [
  [/\belectric(ity)?\b/i, 'electric'],
  [/\bwater\b/i, 'water'],
  [/\bsewer\b/i, 'sewer'],
  [/\b(natural )?gas\b/i, 'gas'],
  [/\btrash\b/i, 'trash'],
  [/\bpropane\b/i, 'propane'],
]
/** A note segment about the PAYMENT, never the charge. */
const TAG = /^(recorded as|covered by|paid (with|on time|off-platform|in full)|work trade|suspended|waived|reopened|corrected|correction|settled|refunded|s\d{3,}:)/i

function describing(notes: string | null | undefined): string[] {
  return String(notes ?? '').split(' — ').map((x) => x.trim()).filter((x) => x && !TAG.test(x))
}

/** The line's name and, when its note says more, the detail under it. */
export function utilityLine(row: UtilityLineRow): { label: string; detail: string | null } {
  const notes = row.notes?.trim() || null
  if (row.type === 'late_fee') return { label: 'Late fee', detail: notes }
  const given = row.label?.trim()
  if (given && !/^utilities$/i.test(given)) return { label: given, detail: notes && notes !== given ? notes : null }
  const t = String(row.utilityType ?? '').toLowerCase()
  if (t && t in UTILITY_TYPE_LABEL) return { label: UTILITY_TYPE_LABEL[t as UtilityType], detail: notes }
  const segs = describing(notes)
  for (const seg of segs) {
    for (const [re, type] of UTILITY_WORDS) {
      if (re.test(seg)) return { label: UTILITY_TYPE_LABEL[type], detail: notes }
    }
  }
  if (segs[0]) {
    const first = segs[0].length > 60 ? `${segs[0].slice(0, 57)}…` : segs[0]
    return { label: first, detail: notes && notes !== first ? notes : null }
  }
  return { label: 'Utility', detail: notes }
}
