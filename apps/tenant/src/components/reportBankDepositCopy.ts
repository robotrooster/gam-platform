/**
 * S655 review — what the "I paid at the bank" screens may promise.
 *
 * Whether GAM can do anything with a reported deposit depends on one thing:
 * whether it is reading the landlord's bank (an active link that has synced —
 * GET /api/declared-deposits/feed/:leaseId and each report's bankFeedLinked).
 *
 *  • Reading it: GAM watches for the deposit, applies it when it shows up,
 *    dates it to the day the tenant paid, and writes an unmatched report off
 *    after a week.
 *  • Not reading it (Country Acres and TruBlu today, or a link in error):
 *    nothing can match the report and nothing expires it. The landlord checks
 *    their own bank and marks the bill paid by hand, and nothing tells them a
 *    report was made — so the tenant has to.
 *
 * The screens used to make the first promise to everyone. These are the words
 * for each case, kept apart from the screens so they can be tested.
 */

/** Whether GAM is watching the landlord's bank for this deposit. */
export type BankWatch = 'watching' | 'not_watching' | 'checking' | 'unknown'

export function bankWatch(o: {
  bankFeedLinked?: boolean | null
  loading?: boolean
  failed?: boolean
}): BankWatch {
  if (o.loading) return 'checking'
  if (o.failed || o.bankFeedLinked == null) return 'unknown'
  return o.bankFeedLinked ? 'watching' : 'not_watching'
}

export interface ReportDepositCopy {
  /** The paragraph under the title, before the form. */
  intro: string
  /** The warning box, after its bold "Only after you've actually paid." */
  warning: string
  /** The box the tenant ticks before they can report. */
  confirm: string
  /** False while GAM is still finding out which promise it can make. */
  canReport: boolean
}

export const ONLY_AFTER_YOU_PAID = 'Only after you’ve actually paid.'

export function reportDepositCopy(w: BankWatch, expiresInDays?: number | null): ReportDepositCopy {
  switch (w) {
    case 'watching':
      return {
        intro: 'You deposited rent straight into your landlord’s account? Tell us and we’ll watch '
          + 'their bank for it. When it shows up we’ll apply it for you, dated the day you paid '
          + 'when the bank shows it that day or the next business day. If it shows up later than '
          + 'that, the bank’s date is used.',
        warning: 'Give the bank a few hours to show the deposit. If you report it before you’ve been, '
          + 'there will be nothing for us to find, and the report ends after '
          + `${expiresInDays && expiresInDays > 0 ? `${expiresInDays} days` : 'a week'}.`,
        confirm: 'I’ve already made this deposit, and I understand my balance stays the same '
          + 'until it shows up in the bank.',
        canReport: true,
      }
    case 'not_watching':
      return {
        intro: 'Your landlord’s bank isn’t connected to GAM right now, so we can’t watch for this '
          + 'deposit. Your landlord checks their own bank and marks your bill paid. After you report '
          + 'it, let them know you paid and keep your deposit slip.',
        warning: 'Report it once the deposit is made, so your landlord can find it when they check '
          + 'their bank.',
        confirm: 'I’ve already made this deposit, and I understand my balance stays the same '
          + 'until my landlord marks it paid.',
        canReport: true,
      }
    case 'checking':
      return {
        intro: 'Checking whether we can watch your landlord’s bank for this deposit…',
        warning: 'Report it once the deposit is made.',
        confirm: 'I’ve already made this deposit, and I understand my balance stays the same '
          + 'until it is marked paid.',
        canReport: false,
      }
    case 'unknown':
    default:
      return {
        intro: 'We couldn’t check whether your landlord’s bank is connected to GAM. You can still '
          + 'report this deposit, and we’ll tell you what happens next. Keep your deposit slip.',
        warning: 'Report it once the deposit is made.',
        confirm: 'I’ve already made this deposit, and I understand my balance stays the same '
          + 'until it is marked paid.',
        canReport: true,
      }
  }
}

/** The line under a report that is still waiting. */
export function pendingReportStatus(bankFeedLinked: boolean | null | undefined): string {
  if (bankFeedLinked === true) {
    return 'Waiting for it to show up in your landlord’s bank. Your balance stays the same until it does.'
  }
  if (bankFeedLinked === false) {
    return 'Your landlord checks their own bank and marks your bill paid. Let them know you paid, '
      + 'and keep your deposit slip. Your balance stays the same until they do.'
  }
  return 'Your balance stays the same until it is marked paid. Keep your deposit slip.'
}

/** 10/5 (Nic): the report was made but its optional photo of the bank's receipt did not go up. */
export const PHOTO_NOT_SENT = 'The photo of the bank’s receipt did not upload — your report is made without it.'

/** Said when the same deposit was already reported (a double tap). */
export function alreadyReportedMessage(w: BankWatch): string {
  return 'You already reported this deposit. '
    + pendingReportStatus(w === 'watching' ? true : w === 'not_watching' ? false : null)
}

/** A report as GET /api/declared-deposits lists it (camelized). */
export interface ReportedDepositRow {
  id: string
  status?: string | null
  confirmedOn?: string | null
  resolutionNote?: string | null
}

const shortDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Where a report stands now, said under "I hadn't paid" when the server would
 * not take it back. That is almost always because it was matched or closed in
 * the meantime, and then it has left the list of open reports: without this
 * the row just vanished, and the tenant could not tell a report taken back
 * from one applied to their bill. Null while the report is still waiting (the
 * server's own sentence says what to do) or the list has not reloaded yet.
 */
export function reportStandsNow(report: ReportedDepositRow | null | undefined): string | null {
  switch (report?.status) {
    case 'confirmed':
      return 'This deposit already showed up in your landlord’s bank and was applied to your bill'
        + (report.confirmedOn ? ` on ${shortDate(report.confirmedOn)}` : '')
        + ', so it can’t be taken back. If you didn’t make this deposit, contact your landlord.'
    case 'withdrawn':
      return 'This report was already taken back. There’s nothing else to do.'
    case 'unconfirmed':
      return 'This report was already closed because no matching deposit showed up. '
        + 'Your balance didn’t change. There’s nothing else to do.'
    default:
      return null
  }
}
