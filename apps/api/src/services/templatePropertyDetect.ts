/**
 * S535 (Nic): detect which property a lease-template PDF belongs to.
 *
 * Lease forms carry the property's name and/or street address in their
 * static text. At template upload we read the PDF text and match it
 * against the landlord's properties so the template auto-locks to the
 * right one — preventing the classic mistake of sending Property A's
 * form for a unit at Property B.
 *
 * Match rules (conservative — a wrong lock is worse than no lock):
 *   - street address (street1, normalized) is the strongest signal
 *   - property NAME matches count only at 5+ characters
 *   - exactly ONE property may match; two-plus matches = ambiguous =
 *     no suggestion (a portfolio-wide form legitimately names several)
 */
import { query } from '../db'

const normalize = (s: string) =>
  s.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim()

export interface DetectedProperty {
  propertyId: string
  propertyName: string
  matchedOn: 'address' | 'name'
}

export function matchPropertiesInText(
  text: string,
  properties: Array<{ id: string; name: string | null; street1: string | null }>,
): DetectedProperty | null {
  const hay = normalize(text)
  const hits: DetectedProperty[] = []
  for (const p of properties) {
    const street = p.street1 ? normalize(p.street1) : ''
    if (street.length >= 6 && hay.includes(street)) {
      hits.push({ propertyId: p.id, propertyName: p.name || '', matchedOn: 'address' })
      continue
    }
    const name = p.name ? normalize(p.name) : ''
    if (name.length >= 5 && hay.includes(name)) {
      hits.push({ propertyId: p.id, propertyName: p.name || '', matchedOn: 'name' })
    }
  }
  if (hits.length !== 1) return null
  return hits[0]
}

export async function detectPropertyFromPdf(
  landlordId: string,
  pdfBuffer: Buffer,
): Promise<DetectedProperty | null> {
  try {
    const { extractPositionedText } = await import('../lib/pdfText')
    const extracted = await extractPositionedText(pdfBuffer)
    const text = extracted.pages.flatMap(pg => pg.items.map(i => i.text)).join(' ')
    if (!text.trim()) return null
    const properties = await query<{ id: string; name: string | null; street1: string | null }>(
      `SELECT id, name, street1 FROM properties WHERE landlord_id = $1`, [landlordId])
    return matchPropertiesInText(text, properties)
  } catch {
    // Detection is best-effort — never fail the upload over it.
    return null
  }
}
