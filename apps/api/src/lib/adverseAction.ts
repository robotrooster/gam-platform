import { CraDisclosure } from '../services/backgroundProvider'

// S87: federal FCRA §615(a) adverse action notice text builder.
//
// This produces the plain-text body that gets stored verbatim in
// adverse_action_notices.notice_text and rendered into the email sent
// to the applicant. State add-ons (CA Civil Code §1786.40 etc) are
// not handled here — per the GAM "no state-specific legal logic" rule,
// state-required additional fields are landlord-configurable extensions
// that compose with this federal baseline.
//
// CFPB "Summary of Consumer Rights under FCRA" is a 4-page document
// the consumer is entitled to. We link to the official CFPB-hosted
// PDF rather than embedding the full text — the link is canonical and
// always current; embedding would freeze a snapshot that decays.

const CFPB_RIGHTS_SUMMARY_URL =
  'https://files.consumerfinance.gov/f/documents/cfpb_consumer-rights-summary_2018-09.pdf'

export interface AdverseActionNoticeInput {
  applicantFirstName: string
  applicantLastName:  string
  landlordName:       string  // business name or owner name
  cra:                CraDisclosure
  decisionBasis?:     string  // landlord's plain-language summary
  disputeWindowDays:  number  // typically 60
  decisionDate:       Date
}

export function buildAdverseActionNoticeText(input: AdverseActionNoticeInput): string {
  const fullName = `${input.applicantFirstName} ${input.applicantLastName}`.trim()
  const date = input.decisionDate.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const lines: string[] = []
  lines.push(`NOTICE OF ADVERSE ACTION`)
  lines.push(``)
  lines.push(`Date: ${date}`)
  lines.push(`To: ${fullName}`)
  lines.push(``)
  lines.push(
    `Your application for residency has been declined in whole or in part ` +
    `based on information contained in a consumer report obtained from the ` +
    `consumer reporting agency identified below. The consumer reporting ` +
    `agency did not make the decision to take this adverse action and is ` +
    `unable to provide you with the specific reasons why the decision was made.`
  )
  lines.push(``)

  if (input.decisionBasis && input.decisionBasis.trim()) {
    lines.push(`Decision summary from ${input.landlordName}:`)
    lines.push(input.decisionBasis.trim())
    lines.push(``)
  }

  lines.push(`Consumer Reporting Agency:`)
  lines.push(`  Name:    ${input.cra.name}`)
  lines.push(`  Address: ${input.cra.address}`)
  lines.push(`  Phone:   ${input.cra.phone}`)
  if (input.cra.website) lines.push(`  Website: ${input.cra.website}`)
  lines.push(``)

  lines.push(`Your Rights Under the Fair Credit Reporting Act`)
  lines.push(``)
  lines.push(
    `You have the right to obtain a free copy of the consumer report from ` +
    `the consumer reporting agency named above by requesting it within ` +
    `${input.disputeWindowDays} days of receiving this notice.`
  )
  lines.push(``)
  lines.push(
    `You have the right to dispute, directly with the consumer reporting ` +
    `agency, the accuracy or completeness of any information furnished by ` +
    `that agency.`
  )
  lines.push(``)
  lines.push(
    `For a full Summary of Consumer Rights under the Fair Credit Reporting ` +
    `Act, see: ${CFPB_RIGHTS_SUMMARY_URL}`
  )
  lines.push(``)
  lines.push(
    `If you believe the adverse action was taken in error or you would like ` +
    `to discuss it further, please contact ${input.landlordName} directly.`
  )

  return lines.join('\n')
}
