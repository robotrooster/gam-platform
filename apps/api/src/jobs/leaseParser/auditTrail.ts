// apps/api/src/jobs/leaseParser/auditTrail.ts
//
// E-sign tools (Dropbox Sign, DocuSign, Adobe Sign, PandaDoc, HelloSign)
// append a tamper-evident audit trail page to the signed PDF. These pages
// are GOLD for onboarding because they contain:
//   - tenant email (which the lease body often does not)
//   - signing timestamps (more reliable than handwritten body dates)
//   - signer names paired with their emails
//   - landlord email (cross-reference to identify which landlord)
//   - document title (often contains property/unit reference)
//
// The audit trail extractor runs alongside the body extractor. Anything
// it pulls (especially email) feeds into the parser's tenant identity
// resolution.

import type { Page } from '../../lib/pdfText'

const AUDIT_TRAIL_SIGNALS = [
  'Audit trail',
  'Document History',
  'Sent for signature',
  'Signed by',
  'powered by Dropbox Sign',
  'DocuSign Envelope',
  'Adobe Sign',
] as const

export type SignerInfo = {
  name: string
  email: string
  signedAt?: string  // ISO datetime if extractable
  ipAddress?: string
}

export type AuditTrailExtraction = {
  detected: boolean
  documentTitle?: string
  signers: SignerInfo[]
  // First detected page index (1-based) where audit trail starts.
  // Used to skip these pages during body extraction.
  startPage?: number
}

export function isAuditTrailPage(page: Page): boolean {
  const all = page.items.map(i => i.text).join(' ')
  return AUDIT_TRAIL_SIGNALS.some(s => all.includes(s))
}

/**
 * Extract structured signer info from one or more audit trail pages.
 * Pages are passed pre-filtered (already known to be audit trail pages).
 *
 * Pattern matching is text-based, not positional, because audit trail
 * formats vary across vendors but consistently include "Signed by NAME
 * (EMAIL)" somewhere. Vendor-specific extras (timestamps, IPs) are
 * picked up via secondary regex passes.
 */
export function extractAuditTrail(pages: Page[]): AuditTrailExtraction {
  const auditPages = pages.filter(isAuditTrailPage)
  if (auditPages.length === 0) {
    return { detected: false, signers: [] }
  }

  const allText = auditPages
    .flatMap(p => p.items.map(i => i.text))
    .join(' ')

  // Title extraction. Two paths:
  //
  // (a) Labeled: vendors that print "Title <text>" as a labeled field.
  //     Try a few vendor patterns; first match wins.
  //
  // (b) Unlabeled: Dropbox Sign's tamper-evident merged PDF places the
  //     document title as the FIRST non-empty content item at the top
  //     of the audit trail page, with no "Title" label. Detect this by
  //     positional heuristic: top-most item on the first audit page,
  //     in a reasonable y range and not matching obvious metadata.
  let documentTitle: string | undefined
  const labeledPatterns = [
    /\bTitle\s+(.+?)\s+(?:File name|Document ID|Audit trail|Status\s)/i,
    /Subject:\s+(.+?)\s+(?:Envelope|Status)/i,
    /Agreement\s+(?:name|title):?\s+(.+?)\s+(?:Date|Status|Document)/i,
  ]
  for (const re of labeledPatterns) {
    const m = allText.match(re)
    if (m && m[1].trim().length > 0 && m[1].trim().length < 200) {
      documentTitle = m[1].trim()
      break
    }
  }

  if (!documentTitle && auditPages.length > 0) {
    // Positional fallback: first audit page, top-most item with text
    // that looks like a title (not a hash, not "Audit trail" header,
    // not a date/IP). Take the highest-y item that passes filters.
    const firstAudit = auditPages[0]
    const candidates = firstAudit.items
      .filter(it => {
        const t = it.text.trim()
        if (t.length < 5 || t.length > 200) return false
        if (/^[0-9a-f]{20,}$/i.test(t)) return false             // hashes
        if (/^Audit trail$|^Document History$/i.test(t)) return false
        if (/^\d{2}\s*\/\s*\d{2}\s*\/\s*\d{4}$/.test(t)) return false  // dates
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(t)) return false  // IPs
        if (/^IP:/i.test(t)) return false
        if (/^Powered by/i.test(t)) return false
        return true
      })
      .sort((a, b) => b.y - a.y)
    if (candidates.length > 0) {
      documentTitle = candidates[0].text.trim()
    }
  }

  // Signers — primary pattern: "Signed by NAME (EMAIL)"
  const signers: SignerInfo[] = []
  const signedRe = /Signed by ([^\(]+?)\(([\w\.\-]+@[\w\.\-]+)\)/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = signedRe.exec(allText)) !== null) {
    const name = m[1].trim()
    const email = m[2].trim().toLowerCase()
    const key = `${name}|${email}`
    if (seen.has(key)) continue  // dedupe — audit trails repeat the pair
    seen.add(key)
    signers.push({ name, email })
  }

  // Per-signer enrichment: timestamp + IP. To avoid bleeding into the
  // NEXT signer's metadata, we scope each signer's search to the slice
  // of text starting at "Signed by NAME" and ending at the next
  // "Signed by" mention (or end-of-string for the last signer).
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i]
    const escapedName = signer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const startRe = new RegExp(`Signed by ${escapedName}`, 'i')
    const startMatch = allText.match(startRe)
    if (!startMatch || startMatch.index === undefined) continue

    // Slice from this signer's "Signed by" forward to the next "Signed by"
    // mention, regardless of name. That window contains this signer's
    // timestamp + IP and excludes the next signer's metadata.
    const sliceStart = startMatch.index
    const restAfter = allText.slice(sliceStart + startMatch[0].length)
    const nextStart = restAfter.search(/Signed by /i)
    const sliceEnd = nextStart === -1
      ? allText.length
      : sliceStart + startMatch[0].length + nextStart
    const slice = allText.slice(sliceStart, sliceEnd)

    // Date + time WITHIN the slice. Audit trails put timestamp and
    // "Signed by NAME" close together, so we search both directions
    // around the slice -- but we already trimmed it, so any match in
    // the slice is this signer's.
    //
    // Also search a small lookbehind window before the slice start
    // because Dropbox Sign places the timestamp BEFORE "Signed by NAME"
    // on the same row.
    const lookbehindStart = Math.max(0, sliceStart - 80)
    const lookbehind = allText.slice(lookbehindStart, sliceStart)
    const searchText = lookbehind + slice

    const dateTimeRe = /(\d{2}\s*\/\s*\d{2}\s*\/\s*\d{4})\s+(\d{2}:\d{2}:\d{2}\s*UTC)/i
    const dtm = searchText.match(dateTimeRe)
    if (dtm) {
      const [mm, dd, yyyy] = dtm[1].replace(/\s+/g, '').split('/')
      const time = dtm[2].replace(/\s+/g, '').replace('UTC', 'Z')
      signer.signedAt = `${yyyy}-${mm}-${dd}T${time}`
    }

    // IP within the slice only (lookbehind not needed -- IPs follow names)
    const ipRe = /IP:\s*(\d{1,3}(?:\.\d{1,3}){3})/i
    const ipm = slice.match(ipRe)
    if (ipm) signer.ipAddress = ipm[1]
  }

  // startPage = lowest pageNumber that's an audit page
  const startPage = Math.min(...auditPages.map(p => p.pageNumber))

  return {
    detected: true,
    documentTitle,
    signers,
    startPage,
  }
}
