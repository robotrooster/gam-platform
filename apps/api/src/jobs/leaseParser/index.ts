// apps/api/src/jobs/leaseParser/index.ts
//
// parseLease(pdfBuffer) -- the parser entry point.
//
// Pure function: takes a PDF, returns a ParseResult containing the
// ParserOutput, status decision, and flags. NO database access. NO
// landlord-typed identity comparison (that's runParserJob's job, in
// the orchestration layer that has intent context).
//
// Per S29c-2-C architecture: parser is advisory. Auto-resolve is gone.
// Every intent passes through landlord confirmation regardless of
// status. Status is a HINT to the UI about how much work the landlord
// has to do, not a permission to skip them.

import type {
  ParserOutput, ParserStatus, ParserFlag,
  ParserExtractedTenant, ParserExtractedUnit, ParserExtractedLease,
  ParserExtractedField,
} from '@gam/shared'
import { extractPositionedText } from '../../lib/pdfText'
import { extractAuditTrail, isAuditTrailPage, type AuditTrailExtraction } from './auditTrail'
import {
  extractTenantNameSplit, extractTenantPhone, extractTenantDateOfBirth, extractTenantMailingAddress,
  extractDriversLicense, extractEmergencyContact, extractLiabilityInsurance,
  extractMobileHome, extractUnitNumber, detectUnitType,
  extractFixedTerm, extractLeaseStart, extractLeaseEnd,
  extractMonthlyRent, extractSecurityDeposit,
  detectAutoRenew, detectNoticeDays, detectLateFees, detectSubleasingPolicy,
  extractPropertyNameAndAddress, extractAdditionalOccupants,
} from './extractors'

const PARSER_VERSION = 'gam-parser-0.1.0'

// Confidence threshold below which a critical field flags as low-confidence
// and pushes status to 'mismatch'. 0.70 is the boundary between yellow
// and red tiers in the UI.
const CRITICAL_CONFIDENCE_FLOOR = 0.70

export type ParseResult = {
  status: ParserStatus
  output: ParserOutput
  flags:  ParserFlag[]
  auditTrail: AuditTrailExtraction
}

export async function parseLease(pdfBuffer: Buffer): Promise<ParseResult> {
  const extracted = await extractPositionedText(pdfBuffer)

  // 1. Audit trail extraction (across all detected pages)
  const auditTrail = extractAuditTrail(extracted.pages)

  // 2. Body pages = pages NOT in the audit trail
  const bodyPages = extracted.pages.filter(p => !isAuditTrailPage(p))
  if (bodyPages.length === 0) {
    return errorResult('Document contains only an audit trail with no lease body.', auditTrail)
  }

  const page1 = bodyPages[0]
  const page2 = bodyPages[1] ?? page1  // some leases may be 1-pagers

  // 3. Tenant identity (body) + email from audit trail (gold)
  const { firstName, lastName } = extractTenantNameSplit(page1)
  const phone        = extractTenantPhone(page1)
  const dateOfBirth  = extractTenantDateOfBirth(page1)
  const mailingAddr  = extractTenantMailingAddress(page1)

  // Email from audit trail: pick the signer whose name matches the
  // body-extracted tenant name. If exactly two signers and only one
  // matches, that's the tenant. If neither matches, low confidence.
  let email: ParserExtractedField<string> | null = null
  if (auditTrail.detected && auditTrail.signers.length > 0 && firstName && lastName) {
    const tenantNameNorm = `${firstName.value} ${lastName.value}`.toLowerCase().replace(/\s+/g, ' ').trim()
    const matchingSigners = auditTrail.signers.filter(s => {
      const sNorm = s.name.toLowerCase().replace(/\s+/g, ' ').trim()
      return sNorm === tenantNameNorm ||
             sNorm.includes(lastName.value.toLowerCase()) ||
             tenantNameNorm.includes(s.name.split(/\s+/).pop()?.toLowerCase() ?? '__nope__')
    })
    if (matchingSigners.length === 1) {
      email = {
        value:      matchingSigners[0].email,
        confidence: 0.95,
        rawText:    `audit trail Signed by ${matchingSigners[0].name}`,
      }
    } else if (auditTrail.signers.length === 2 && matchingSigners.length === 0) {
      // Couldn't disambiguate by name; if exactly 2 signers (assume
      // landlord + tenant), the tenant is whoever signed second by
      // timestamp. Lower confidence since this is heuristic.
      const sorted = [...auditTrail.signers].sort((a, b) =>
        (a.signedAt ?? '').localeCompare(b.signedAt ?? '')
      )
      const guess = sorted[1] ?? sorted[0]
      email = {
        value:      guess.email,
        confidence: 0.70,
        rawText:    `audit trail second signer ${guess.name}`,
      }
    }
  }

  // 4. Identifications + emergency contacts + liability insurance
  const dl = extractDriversLicense(page1)
  const emerg = extractEmergencyContact(page1)
  const liability = extractLiabilityInsurance(page1)

  // 5. Mobile home + property
  const mobileHome = extractMobileHome(page1)
  const propertyInfo = extractPropertyNameAndAddress(extracted.pages)

  // 6. Unit
  const unitNumber = extractUnitNumber(page1)
  const unitType = detectUnitType(extracted.pages)

  // 7. Lease terms
  const term  = extractFixedTerm(page2)
  const start = extractLeaseStart(page2)
  const end   = extractLeaseEnd(page2)
  const rent  = extractMonthlyRent(page2)
  const deposit = extractSecurityDeposit(page2)

  // 8. Lease behavior (from prose patterns)
  const { autoRenew, autoRenewMode } = detectAutoRenew(extracted.pages)
  const noticeDays = detectNoticeDays(extracted.pages)
  const { lateFeeAmount, lateFeeGraceDays } = detectLateFees(extracted.pages)
  const subleasingPolicy = detectSubleasingPolicy(extracted.pages)

  // 9. Lease type heuristic: fixed term + end date -> fixed_term;
  //    no end + monthly -> month_to_month
  const leaseType: ParserExtractedField<string> = (() => {
    if (term && term.value && end) {
      return { value: 'fixed_term', confidence: 0.90, rawText: 'has fixed term and end date' }
    }
    if (!end && rent) {
      return { value: 'month_to_month', confidence: 0.75, rawText: 'no end date, monthly rent' }
    }
    return { value: 'fixed_term', confidence: 0.50, rawText: '(default)' }
  })()

  // 10. Additional occupants (excluding primary tenant)
  const primaryTenantFull = `${firstName?.value ?? ''} ${lastName?.value ?? ''}`.trim()
  const additionalOccupants = extractAdditionalOccupants(page1, primaryTenantFull)

  // ---------------------------------------------------------------------
  // Assemble ParserOutput
  // ---------------------------------------------------------------------

  const tenant: ParserExtractedTenant = {
    firstName:        firstName  ?? missing<string>('firstName not extracted'),
    lastName:         lastName   ?? missing<string>('lastName not extracted'),
    email:            email      ?? missing<string>('email not extracted'),
    phone:            phone      ?? missing<string>('phone not extracted'),
    dateOfBirth:      dateOfBirth ?? undefined,
    mailingAddress:   mailingAddr ?? undefined,
    identifications:  dl ? [dl] : undefined,
    emergencyContacts: emerg ? [emerg] : undefined,
  }

  const unit: ParserExtractedUnit = {
    propertyName:    propertyInfo.propertyName ?? missing<string>('propertyName not extracted'),
    unitNumber:      unitNumber ?? missing<string>('unitNumber not extracted'),
    propertyAddress: propertyInfo.propertyAddress,
    unitType: {
      value:      unitType.value,
      confidence: unitType.confidence,
      rawText:    `detected via keyword count`,
    },
  }

  const lease: ParserExtractedLease = {
    leaseType:           leaseType,
    leaseStart:          start ?? missing<string>('leaseStart not extracted'),
    leaseEnd:            end   ?? missing<string>('leaseEnd not extracted'),
    monthlyRent:         rent  ?? missing<number>('monthlyRent not extracted'),
    securityDeposit:     deposit ?? { value: 0, confidence: 0.95, rawText: 'no deposit (N/A in document)' },
    lateFeeAmount:       lateFeeAmount    ?? missing<number>('lateFeeAmount not detected'),
    lateFeeGraceDays:    lateFeeGraceDays ?? missing<number>('lateFeeGraceDays not detected'),
    autoRenew,
    autoRenewMode:       autoRenewMode ?? { value: '', confidence: 0.40, rawText: '(none)' },
    noticeDaysRequired:  noticeDays ?? missing<number>('noticeDaysRequired not detected'),
    subleasingAllowed:   subleasingPolicy ?? undefined,
  }

  const output: ParserOutput = {
    tenants: [tenant],
    unit,
    lease,
    mobileHome:          mobileHome ?? undefined,
    additionalOccupants: additionalOccupants.length > 0 ? additionalOccupants : undefined,
    liabilityInsurance:  liability  ?? undefined,
    parserVersion:       PARSER_VERSION,
    parsedAt:            new Date().toISOString(),
  }

  // ---------------------------------------------------------------------
  // Flag generation + status decision
  // ---------------------------------------------------------------------

  const flags: ParserFlag[] = []

  // Critical fields: anything block-severity here flips status to 'mismatch'
  type CriticalCheck = {
    path:  string
    field: ParserExtractedField<unknown> | null | undefined
    label: string
  }
  const criticalChecks: CriticalCheck[] = [
    { path: 'tenants.0.firstName',   field: tenant.firstName,    label: 'tenant first name' },
    { path: 'tenants.0.lastName',    field: tenant.lastName,     label: 'tenant last name' },
    { path: 'tenants.0.email',       field: tenant.email,        label: 'tenant email' },
    { path: 'unit.unitNumber',       field: unit.unitNumber,     label: 'unit number' },
    { path: 'lease.leaseStart',      field: lease.leaseStart,    label: 'lease start date' },
    { path: 'lease.leaseEnd',        field: lease.leaseEnd,      label: 'lease end date' },
    { path: 'lease.monthlyRent',     field: lease.monthlyRent,   label: 'monthly rent' },
  ]

  for (const c of criticalChecks) {
    if (!c.field || c.field.confidence < 0.30) {
      flags.push({
        category: 'field_missing',
        severity: 'block',
        field:    c.path,
        message:  `Could not extract ${c.label} from the document.`,
      })
    } else if (c.field.confidence < CRITICAL_CONFIDENCE_FLOOR) {
      flags.push({
        category: 'field_low_confidence',
        severity: 'block',
        field:    c.path,
        message:  `Low confidence extracting ${c.label}. Please verify.`,
        found:    String((c.field as ParserExtractedField<unknown>).value),
      })
    }
  }

  // Non-critical low-confidence -> confirm-severity flags (advisory)
  type NonCritCheck = { path: string; field?: ParserExtractedField<unknown>; label: string }
  const nonCriticalChecks: NonCritCheck[] = [
    { path: 'tenants.0.phone',           field: tenant.phone,            label: 'tenant phone' },
    { path: 'tenants.0.dateOfBirth',     field: tenant.dateOfBirth,      label: 'tenant date of birth' },
    { path: 'lease.securityDeposit',     field: lease.securityDeposit,   label: 'security deposit' },
    { path: 'lease.lateFeeAmount',       field: lease.lateFeeAmount,     label: 'late fee amount' },
    { path: 'lease.lateFeeGraceDays',    field: lease.lateFeeGraceDays,  label: 'late fee grace days' },
    { path: 'lease.noticeDaysRequired',  field: lease.noticeDaysRequired, label: 'notice days required' },
  ]
  for (const c of nonCriticalChecks) {
    if (c.field && c.field.confidence < CRITICAL_CONFIDENCE_FLOOR) {
      flags.push({
        category: 'field_low_confidence',
        severity: 'confirm',
        field:    c.path,
        message:  `Low confidence on ${c.label}. Confirm or correct.`,
        found:    String(c.field.value),
      })
    }
  }

  // Status decision: any block-severity flag -> mismatch, else parsed.
  // (Identity-mismatch checks are added later by runParserJob.)
  const hasBlocker = flags.some(f => f.severity === 'block')
  const status: ParserStatus = hasBlocker ? 'mismatch' : 'parsed'

  return { status, output, flags, auditTrail }
}

// Helper for fields that didn't extract -- emits a placeholder
// ParserExtractedField with confidence 0 and rawText explanation.
// The status decision treats these as missing-block flags.
function missing<T>(reason: string): ParserExtractedField<T> {
  return {
    value:      undefined as unknown as T,
    confidence: 0,
    rawText:    reason,
  }
}

function errorResult(reason: string, audit: AuditTrailExtraction): ParseResult {
  return {
    status: 'error',
    output: {
      tenants: [],
      unit:    { propertyName: missing('error'), unitNumber: missing('error') },
      lease: {
        leaseType: missing('error'),
        leaseStart: missing('error'),
        leaseEnd: missing('error'),
        monthlyRent: missing('error'),
        securityDeposit: missing('error'),
        lateFeeAmount: missing('error'),
        lateFeeGraceDays: missing('error'),
        autoRenew: { value: false, confidence: 0, rawText: 'error' },
        autoRenewMode: missing('error'),
        noticeDaysRequired: missing('error'),
      },
      parserVersion: PARSER_VERSION,
      parsedAt: new Date().toISOString(),
    },
    flags: [{ category: 'field_missing', severity: 'block', message: reason }],
    auditTrail: audit,
  }
}

// Re-export the public surface
export type { ParserOutput, ParserStatus, ParserFlag } from '@gam/shared'
