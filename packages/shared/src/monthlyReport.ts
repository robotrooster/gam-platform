// 10/12 (Nic): Charged / Received / Owed side by side on every report, and
// the monthly property report emailed at month close.

/**
 * 10/12 (Nic): "NO Money received / Money billed toggle anywhere — show
 * Charged, Received and Owed side by side as columns, with a short line
 * showing how they tie." The three columns every report shows, in Nic's
 * order: 10/12 (Nic, L2) "Received leads" — Received first, then Charged,
 * then Owed, and a report's net leads with Received less expenses. The
 * switch (INCOME_BASES) is retired from every screen; the API still reads
 * both kinds of facts underneath (services/incomeBasis).
 */
export const MONEY_COLUMNS = ['received', 'charged', 'owed'] as const
export type MoneyColumn = typeof MONEY_COLUMNS[number]
export const MONEY_COLUMN_LABEL: Record<MoneyColumn, string> = {
  received: 'Received',
  charged:  'Charged',
  owed:     'Owed',
}
/** What each column counts, in plain words (the reports print it under the table). */
export const MONEY_COLUMN_NOTE: Record<MoneyColumn, string> = {
  received: 'Money on the day it arrived. Money paid ahead counts the day it arrives, never again when it pays a later bill.',
  charged:  'Bills in the month they were due, paid or not, less credits you gave.',
  owed:     'What is still unpaid of those bills today.',
}
/**
 * 10/12 (Nic, ledger P8): the same notes once a company's reports read its
 * books (the ledger): Owed is what tenants still owed at the END of the
 * period — every bill, not only that period's — and a strip under the table
 * shows how it got there (owed at the start + billed − received … = owed at
 * the end). A report says which it read (view.source = 'ledger').
 */
export const MONEY_COLUMN_NOTE_LEDGER: Record<MoneyColumn, string> = {
  received: 'Money on the day it arrived. Money paid ahead counts the day it arrives. A refund or a payment taken back is a minus on its own day.',
  charged:  'Bills in the month they were due, paid or not, less credits you gave.',
  owed:     'What tenants still owed at the end of the period, every bill included.',
}

/**
 * 10/12 (Nic): who gets the monthly property report. The owner picks: their
 * own team (themselves, property managers, bookkeepers, anyone else on the
 * team) and any other address. Mirrors monthly_report_recipients_kind_check.
 */
export const MONTHLY_REPORT_RECIPIENT_KINDS = ['team_member', 'email'] as const
export type MonthlyReportRecipientKind = typeof MONTHLY_REPORT_RECIPIENT_KINDS[number]
export const MONTHLY_REPORT_RECIPIENT_KIND_LABEL: Record<MonthlyReportRecipientKind, string> = {
  team_member: 'Someone on your team',
  email:       'Another email address',
}

/**
 * One monthly report email to one address for one month. Mirrors
 * monthly_report_sends_status_check. `sending` is the claim taken before the
 * email goes out (so two runs never send it twice); `not_sent` is a send the
 * mail service did not accept (tried again on the next run, up to three
 * tries, while the month's sending window is open).
 */
export const MONTHLY_REPORT_SEND_STATUSES = ['sending', 'sent', 'not_sent'] as const
export type MonthlyReportSendStatus = typeof MONTHLY_REPORT_SEND_STATUSES[number]
export const MONTHLY_REPORT_SEND_STATUS_LABEL: Record<MonthlyReportSendStatus, string> = {
  sending:  'Sending',
  sent:     'Sent',
  not_sent: 'Could not send',
}

/** The day of the month the report goes out, and the earliest local hour (10/12: the 2nd, after the 1st's month-end runs). */
export const MONTHLY_REPORT_SEND_DAY = 2
export const MONTHLY_REPORT_SEND_HOUR = 8
/** The last day of the month a missed send is still made up (the server was down on the 2nd). */
export const MONTHLY_REPORT_LAST_CATCH_UP_DAY = 5
/** How many other addresses a company may add (beyond its own team). */
export const MONTHLY_REPORT_MAX_EXTRA_EMAILS = 20
