/**
 * ONE LIST OF EVERY NOTIFICATION GAM CAN SEND.
 *
 * 10/20 (Nic): "I want you to build every notification category in the settings
 * page and turn off the ones that are non-critical... I would add everything to
 * the list, but the five critical ones make it not checkable so that they can
 * see that they will still get those emails. That way it's not like, I thought I
 * turned it off, blah, blah, blah."
 *
 * And, on why this file exists at all rather than a longer page: "I don't want
 * you to switch off three remaining email settings when you said there's five
 * critical things and 22 other ones that weren't even on the list. Like, you're
 * thinking too narrow. I want you to fix the root, not just one off because one
 * landlord wants a setting a certain way. We're fixing root problems here."
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────────
 * Notification types were added over months. The settings pages were THREE
 * hand-written subsets of them (landlord Settings, tenant Profile, a second
 * tenant page), so a type added in a later session had no switch anywhere, and
 * services/notifications treats "no stored answer" as email-on. A landlord who
 * unchecked every box he could see still got email from the types that were
 * never on the page — because he had never been asked.
 *
 * ── WHY IT CANNOT HAPPEN AGAIN ───────────────────────────────────────────────
 * `createNotification` takes `type: NotificationType`, the union derived from
 * this list. A notification whose type is not in this list DOES NOT COMPILE.
 * The settings pages render from this list, so every type that can be sent has
 * a row on the screen, and `notificationCatalog.test.ts` fails if a type string
 * reaches the notify path without an entry here.
 *
 * ── ADDING A NOTIFICATION ────────────────────────────────────────────────────
 * Add the entry here first: `type`, a human `label` (never the raw type string —
 * nothing on screen shows an enum), `when` as one plain sentence saying what
 * makes it fire, the `audience` whose settings page it belongs on, and a
 * `group`. Then write the sender.
 */

/** Which portal's settings page a type belongs on. */
export const NOTIFICATION_AUDIENCES = ['landlord', 'tenant', 'both'] as const
export type NotificationAudience = typeof NOTIFICATION_AUDIENCES[number]

/**
 * The headings a landlord or resident scans for. Order here is the order they
 * appear on the page.
 */
export const NOTIFICATION_GROUPS = [
  'money_in', 'money_out', 'leases', 'residents', 'maintenance',
  'utilities', 'bookings', 'documents', 'register', 'account',
] as const
export type NotificationGroup = typeof NOTIFICATION_GROUPS[number]

export const NOTIFICATION_GROUP_LABEL: Record<NotificationGroup, string> = {
  money_in:    'Money coming in',
  money_out:   'Money going out, payouts and GAM billing',
  leases:      'Leases and renewals',
  residents:   'Residents, applicants and messages',
  maintenance: 'Maintenance and inspections',
  utilities:   'Utilities and meters',
  bookings:    'Reservations and stays',
  documents:   'Documents and signatures',
  register:    'Register, pay links and stock',
  account:     'Your account, team and access',
}

export interface NotificationCatalogEntry {
  /** The stored type. Never shown on screen. */
  readonly type: string
  /** What a person reads on the settings page. */
  readonly label: string
  /** One plain sentence: what makes this one fire. */
  readonly when: string
  readonly group: NotificationGroup
  readonly audience: NotificationAudience
  /**
   * GAM sends this one whatever the setting says, because missing it does real
   * harm. Shown on the page with the box locked and `whyAlways` under it.
   */
  readonly critical?: true
  /** Why it cannot be turned off. Required on a critical entry, shown on screen. */
  readonly whyAlways?: string
  /**
   * Nothing is posted in the app for this one — a job emails it directly and
   * writes no notification row — so the in-app column reads "—" rather than
   * offering a switch that would do nothing.
   */
  readonly emailOnly?: true
  /**
   * The other half of the same honesty, and the one that was missing.
   *
   * 10/20: thirty rows showed an Email box for a notice nothing has ever
   * emailed — it is written in the app and nowhere else. Unticking one of those
   * boxes did nothing at all. Nic's own words retired three types for exactly
   * this: "a box for mail that cannot arrive is noise." So the Email column
   * reads "—" for these, and notificationCatalog.test.ts fails if a sender ever
   * starts emailing one without clearing the flag, or stops emailing one
   * without setting it.
   */
  readonly inAppOnly?: true
  /**
   * Only the account holder ever gets this one, so a team member is not shown a
   * switch that would do nothing. (A team member has no birthday on file.)
   */
  readonly ownerOnly?: true
}

/**
 * Every notification GAM can send, in page order.
 *
 * The five critical ones are Nic's call (S570, S609, S655) and are marked
 * `critical` here rather than in a second list, so the page, the delivery
 * decision and this catalog can never disagree.
 */
export const NOTIFICATION_CATALOG_SOURCE = [
  // ── Money coming in ────────────────────────────────────────────────────────
  { type: 'rent_collected', label: 'Rent collected', group: 'money_in', audience: 'landlord',
    when: 'A resident’s rent payment lands.' },
  { type: 'rent_reversed', label: 'Rent payment reversed', group: 'money_in', audience: 'landlord',
    when: 'Rent that already cleared is pulled back by the payer’s bank, and the bill reopens.' },
  { type: 'payment_recorded', label: 'A payment was recorded for you', group: 'money_in', audience: 'tenant',
    inAppOnly: true,
    when: 'Cash, a check, a money order or a bank deposit of yours is put on your account by hand or by the bank feed.' },
  { type: 'payment_failed', label: 'A payment of yours failed', group: 'money_in', audience: 'tenant',
    critical: true, whyAlways: 'A payment that failed quietly becomes a late fee, so GAM always emails this one.',
    when: 'A rent payment of yours does not go through.' },
  { type: 'autopay_failed', label: 'A scheduled payment failed', group: 'money_in', audience: 'both',
    critical: true, whyAlways: 'Nobody checks on a payment they believe is handled — silence here ends in a late fee nobody saw coming, so GAM always emails it.',
    when: 'A scheduled (autopay) rent pull fails. The resident and the landlord are both told.' },
  { type: 'autopay', label: 'Scheduled payment notices', group: 'money_in', audience: 'tenant',
    inAppOnly: true,
    when: 'Your scheduled rent payment is about to run, ran, or was switched off.' },
  { type: 'ach_retry_scheduled', label: 'Your bank payment will be tried again', group: 'money_in', audience: 'tenant',
    when: 'A bank payment of yours is returned for a reason worth retrying, and GAM sets the retry date.' },
  { type: 'ach_retry_scheduled_info', label: 'A resident’s bank payment will be tried again', group: 'money_in', audience: 'landlord',
    when: 'A resident’s returned bank payment is set to be tried again — your copy of the notice.' },
  { type: 'ach_retries_exhausted', label: 'Your bank payment can’t be tried again', group: 'money_in', audience: 'tenant',
    when: 'A bank payment of yours fails its last retry, so the rent is owed again.' },
  { type: 'ach_retries_exhausted_landlord', label: 'A resident’s bank payment can’t be tried again', group: 'money_in', audience: 'landlord',
    when: 'A resident’s bank payment fails its last retry and the balance reopens.' },
  { type: 'bank_returned_check', label: 'A check came back', group: 'money_in', audience: 'both',
    when: 'The bank returns a check or money order that was already recorded as paid.' },
  { type: 'flexdeposit_payment_failed', label: 'A FlexDeposit payment failed', group: 'money_in', audience: 'tenant',
    when: 'A scheduled FlexDeposit installment does not go through.' },
  { type: 'flexpay_bill_covered', label: 'FlexPay covered your bill', group: 'money_in', audience: 'tenant',
    critical: true, whyAlways: 'It says what FlexPay paid and what is still owed on that bill, so GAM always emails it.',
    when: 'FlexPay pays a bill of yours — with what, if anything, is still owed on it.' },
  { type: 'flexpay_bill_not_covered', label: 'FlexPay did not cover a bill', group: 'money_in', audience: 'tenant',
    when: 'A bill of yours falls outside what FlexPay covers, so it is yours to pay.' },
  { type: 'flexpay_pull_retry', label: 'FlexPay will try a collection again', group: 'money_in', audience: 'tenant',
    critical: true, whyAlways: 'It names the day the money has to be in the account, so GAM always emails it.',
    when: 'A FlexPay collection is tried again, and when.' },
  { type: 'flexpay_ended', label: 'FlexPay ended', group: 'money_in', audience: 'tenant',
    critical: true, whyAlways: 'The next bill is yours to pay in full — a surprise here is the worst kind, so GAM always emails it.',
    when: 'FlexPay stops covering your bills, so the next one is yours.' },
  { type: 'dispute_resolved', label: 'A dispute was settled', group: 'money_in', audience: 'both',
    when: 'A charge dispute is decided.' },
  { type: 'deposit_report_unconfirmed', label: 'A deposit you reported was not found', group: 'money_in', audience: 'tenant',
    inAppOnly: true,
    when: 'A deposit you reported making does not turn up in the bank within the window.' },
  { type: 'deposit_reports_unconfirmed', label: 'Reported deposits were not found', group: 'money_in', audience: 'landlord',
    inAppOnly: true,
    when: 'Deposits residents reported making do not turn up in your bank feed.' },
  // 10/20: the four below are among the highest-volume mail GAM sends, and not
  // one of them had a row here — they go out from their own senders in
  // services/email.ts rather than through createNotification, so this catalog
  // never saw them. The 7am digest alone reached a landlord every morning while
  // his page read "0 of 86 optional emails are on". See emailCategories.
  { type: 'late_balance_digest', label: 'Overdue balances each morning', group: 'money_in', audience: 'landlord',
    emailOnly: true,
    when: 'One email at 7am saying how many residents have a balance past its grace period, on any morning one of them does.' },
  { type: 'invoice_ready', label: 'Your bill is ready', group: 'money_in', audience: 'tenant',
    emailOnly: true,
    when: 'A bill of yours is written — rent, utilities and fees for the period, with what it still owes.' },
  { type: 'payment_receipt', label: 'A receipt for a payment', group: 'money_in', audience: 'tenant',
    emailOnly: true,
    when: 'A payment of yours is taken or recorded — online, at the counter, or by the bank feed.' },
  { type: 'balance_due_reminder', label: 'A reminder of what you owe', group: 'money_in', audience: 'tenant',
    emailOnly: true,
    when: 'Your landlord sends you a reminder of your open balance from their Outstanding list.' },

  // ── Money going out, payouts and GAM billing ───────────────────────────────
  { type: 'connect_payout_paid', label: 'A payout landed', group: 'money_out', audience: 'landlord',
    when: 'Money GAM collected reaches your bank account.' },
  { type: 'connect_payout_failed', label: 'A payout failed', group: 'money_out', audience: 'landlord',
    when: 'A payout to your bank account is rejected or returned.' },
  { type: 'deposit_refund_statement', label: 'Your deposit statement', group: 'money_out', audience: 'tenant',
    when: 'Your security deposit is settled, with the line-by-line statement of what was kept and why.' },
  { type: 'deposit_refund_failed', label: 'A deposit refund failed', group: 'money_out', audience: 'landlord',
    inAppOnly: true,
    when: 'A deposit refund to a former resident is rejected or comes back.' },
  { type: 'deposit_return_approval', label: 'A deposit return needs your approval', group: 'money_out', audience: 'landlord',
    inAppOnly: true,
    when: 'A deposit return is drawn up and waiting on you to approve it.' },
  { type: 'amenity_fee_refund_due', label: 'An amenity fee needs refunding', group: 'money_out', audience: 'landlord',
    when: 'A reserved common area is cancelled or closed after its fee was paid.' },
  { type: 'bank_deposit_voided', label: 'A bank deposit was voided', group: 'money_out', audience: 'landlord',
    inAppOnly: true,
    when: 'A recorded bank deposit is voided, so what it paid off reopens.' },
  { type: 'bank_line_voided', label: 'A money-out line was voided', group: 'money_out', audience: 'landlord',
    inAppOnly: true,
    when: 'A recorded payment out of your bank account is voided.' },
  { type: 'gam_balance_uncollectable', label: 'GAM could not collect its fees', group: 'money_out', audience: 'landlord',
    when: 'GAM’s fee debit cannot be collected from your bank account.' },
  { type: 'gam_portal_lock_warning', label: 'Your portal will lock', group: 'money_out', audience: 'landlord',
    when: 'Two billing cycles of GAM fees are uncollected, 48 hours before the portal locks.' },
  { type: 'gam_portal_locked', label: 'Your portal is locked', group: 'money_out', audience: 'landlord',
    when: 'The portal locks over uncollected GAM fees.' },
  // 10/12 (Nic): "Home payments", not "home sale" — the notice is about the
  // buyer's payments, which is what the landlord acts on.
  { type: 'home_sale_started', label: 'Home payments started', group: 'money_out', audience: 'landlord',
    when: 'A tenant-owned home sale begins on one of your spaces and its payments start.' },
  { type: 'home_sale_not_started', label: 'Home payments not started', group: 'money_out', audience: 'landlord',
    when: 'A home sale that was set up never started its payments.' },
  { type: 'books_month_close', label: 'The books were closed or reopened', group: 'money_out', audience: 'landlord',
    inAppOnly: true,
    when: 'Another owner of the company closes or reopens a month in the books.' },
  // 10/12 (Nic): "EMAILED at month close ... WITH A PDF attachment so they can
  // put it to their books." It had no row here, so a landlord with every box
  // off still got it on the 2nd. jobs/monthlyPropertyReportEmail.
  { type: 'monthly_property_report', label: 'Last month’s property report', group: 'money_out', audience: 'landlord',
    emailOnly: true,
    when: 'The 2nd of each month, with last month’s report for your properties attached as a PDF.' },
  { type: 'manager_direct_deposit_enabled', label: 'Direct deposit was turned on for you', group: 'account', audience: 'landlord',
    when: 'An owner turns on direct deposit for your staff pay.' },

  // ── Leases and renewals ────────────────────────────────────────────────────
  { type: 'lease_drafted', label: 'A lease was drafted for you', group: 'leases', audience: 'tenant',
    inAppOnly: true,
    when: 'A landlord draws up a lease for you on an account you already sign in to.' },
  { type: 'lease_drafted_from_booking', label: 'A reservation turned into a lease draft', group: 'leases', audience: 'landlord',
    inAppOnly: true,
    when: 'A guest staying 30 nights or more picks a lease, and the draft is ready on your Leases page.' },
  { type: 'long_stay_no_lease', label: 'A long stay with no lease', group: 'leases', audience: 'landlord',
    inAppOnly: true,
    when: 'A guest stays 30 nights or more and picks a stay rather than a lease.' },
  { type: 'lease_ready_to_sign', label: 'A lease is ready to send out', group: 'leases', audience: 'landlord',
    when: 'A lease you were drawing up is finished and ready for signatures.' },
  { type: 'lease_draft_blocked', label: 'A lease draft is stuck', group: 'leases', audience: 'landlord',
    when: 'GAM cannot finish a lease draft and needs something from you.' },
  { type: 'lease_expiring', label: 'A lease is ending soon', group: 'leases', audience: 'landlord',
    when: 'A lease approaches its end date.' },
  { type: 'lease_renewal_question', label: 'Are you staying?', group: 'leases', audience: 'tenant',
    when: 'Your lease is 60 days from its end and GAM asks whether you are staying.' },
  { type: 'tenant_renewal_intent', label: 'A resident answered about renewing', group: 'leases', audience: 'landlord',
    when: 'A resident says whether they are staying or leaving.' },
  { type: 'lease_renewal_request', label: 'A resident asked to renew', group: 'leases', audience: 'landlord',
    inAppOnly: true,
    when: 'A resident asks for a renewal outright.' },
  { type: 'lease_renewal_offered', label: 'A renewal was offered to you', group: 'leases', audience: 'tenant',
    when: 'Your landlord offers you a renewal.' },
  { type: 'lease_renewal_status', label: 'Where a renewal stands', group: 'leases', audience: 'landlord',
    when: 'A renewal moves along — offered, signed, expired or cancelled.' },
  { type: 'lease_non_renewal', label: 'Your lease will not be renewed', group: 'leases', audience: 'tenant',
    when: 'Your landlord records that your lease will not be renewed.' },
  { type: 'lease_move_out_notice', label: 'Your leaving date was written down', group: 'leases', audience: 'tenant',
    when: 'The office writes down the day you are leaving, so a misheard date gets caught.' },
  // 10/24: the one rule that keeps a handover from happening quietly — whoever
  // it affects finds out first. A replacement signing for the space is what
  // ends the sitting lease (services/spotSuccession), and the person being
  // released is told the date the same moment it is written down, so a wrong
  // one gets caught the way a misheard leaving date does above.
  { type: 'lease_handed_over', label: 'Your lease now ends — somebody signed for your space', group: 'leases',
    audience: 'tenant',
    // The email DOES go — always, and it is not theirs to switch off
    // (emailCategories lease_handed_over). So the Email box on this row would
    // control nothing, and it prints a dash instead of a tickbox that lies.
    inAppOnly: true,
    when: 'Your landlord signs a new lease for your space starting while yours is still running, and the new '
      + 'resident signs it too.' },
  { type: 'lease_move_out_notice_cancelled', label: 'Your leaving date was called off', group: 'leases', audience: 'tenant',
    when: 'A leaving date that was written down for you is called off.' },

  // ── Residents, applicants and messages ────────────────────────────────────
  { type: 'bulk_message', label: 'Messages from your landlord', group: 'residents', audience: 'tenant',
    when: 'Your landlord sends an announcement to residents.' },
  { type: 'landlord_message', label: 'A message from your landlord', group: 'residents', audience: 'tenant',
    inAppOnly: true,
    when: 'Your landlord sends you a message directly.' },
  { type: 'landlord_notice', label: 'A notice from your landlord', group: 'residents', audience: 'tenant',
    inAppOnly: true,
    when: 'Your landlord sends you a written notice.' },
  { type: 'tenant_message', label: 'A resident messaged you', group: 'residents', audience: 'landlord',
    inAppOnly: true,
    when: 'A resident sends you a message.' },
  { type: 'tenant_complaint', label: 'A resident raised a complaint', group: 'residents', audience: 'landlord',
    inAppOnly: true,
    when: 'A resident files a complaint.' },
  { type: 'invited_to_apply', label: 'You were invited to apply', group: 'residents', audience: 'tenant',
    inAppOnly: true,
    when: 'A landlord invites you to apply on an account you already sign in to.' },
  // 10/20: a landlord reaching into the renter pool, and the answer coming back.
  // 'match_interest' wrote its notice to a SECOND table (tenant_notifications)
  // which the completeness scanner never looked at, so it was in neither this
  // list nor the retired one — no switch on any page and no way to decline.
  { type: 'match_interest', label: 'A landlord is interested in you', group: 'residents', audience: 'tenant',
    when: 'A landlord with a vacancy that matches your renter-pool profile asks whether you are interested.' },
  { type: 'pool_tenant_interested', label: 'Someone in the renter pool is interested', group: 'residents', audience: 'landlord',
    emailOnly: true,
    when: 'Somebody you reached out to in the renter pool says they are interested in your vacancy.' },
  { type: 'background_check_new', label: 'A background check came back', group: 'residents', audience: 'landlord',
    emailOnly: true,
    when: 'A screening you are waiting on comes back, with its risk level.' },
  { type: 'tenant_invite_accepted', label: 'A resident accepted their invite', group: 'residents', audience: 'landlord',
    when: 'Someone you invited finishes setting up their account.' },
  { type: 'unit_application', label: 'A new application came in', group: 'residents', audience: 'landlord',
    when: 'Someone applies for one of your units.' },
  { type: 'applicant_decision', label: 'An applicant decision to finalize', group: 'residents', audience: 'landlord',
    inAppOnly: true,
    when: 'You asked GAM’s assistant to approve or decline an applicant, and it is flagged for you to finish.' },
  { type: 'property_inquiry', label: 'Someone asked about a property', group: 'residents', audience: 'landlord',
    when: 'A visitor sends an inquiry from one of your booking sites.' },
  { type: 'emergency_contact_refresh', label: 'Check your emergency contact', group: 'residents', audience: 'tenant',
    inAppOnly: true,
    when: 'Your emergency contact is missing, has no phone number, or nobody has confirmed it in a year.' },
  { type: 'survey_sent', label: 'A survey for you', group: 'residents', audience: 'tenant',
    when: 'Your landlord sends residents a survey.' },
  { type: 'birthday', label: 'Happy birthday from GAM', group: 'residents', audience: 'both',
    emailOnly: true, ownerOnly: true,
    when: 'Your birthday — a note from GAM. Email only: nothing is posted in the app.' },
  { type: 'sublease_requested', label: 'A sublease was requested', group: 'residents', audience: 'landlord',
    when: 'A resident asks to sublease.' },
  { type: 'sublease_approved', label: 'A sublease was approved', group: 'residents', audience: 'tenant',
    when: 'A sublease you asked for is approved.' },
  { type: 'sublease_denied', label: 'A sublease was declined', group: 'residents', audience: 'tenant',
    when: 'A sublease you asked for is declined.' },
  { type: 'sublease_terminated', label: 'A sublease ended', group: 'residents', audience: 'both',
    when: 'A sublease is ended.' },
  { type: 'landlord_member_removed', label: 'Someone left the team', group: 'account', audience: 'landlord',
    inAppOnly: true,
    when: 'A team member is taken off the company — they are told, and so are you.' },
  // S651 (memory: gam-no-raw-enums-in-ui): "Email undeliverable" is jargon for
  // the one notice that has to be read and acted on.
  { type: 'email_undeliverable', label: 'Email not arriving', group: 'account', audience: 'landlord',
    inAppOnly: true,
    when: 'Mail to a resident or staff address keeps bouncing, so GAM stops trying it.' },

  // ── Maintenance and inspections ───────────────────────────────────────────
  { type: 'maintenance_submitted', label: 'A new maintenance request', group: 'maintenance', audience: 'landlord',
    when: 'A resident files a maintenance request.' },
  { type: 'maintenance_emergency', label: 'An emergency maintenance request', group: 'maintenance', audience: 'landlord',
    when: 'A maintenance request comes in marked an emergency.' },
  { type: 'maintenance_approval_required', label: 'A maintenance request needs your approval', group: 'maintenance', audience: 'landlord',
    when: 'A request’s estimate is over the amount staff can approve on their own.' },
  { type: 'maintenance', label: 'Someone approved above their limit', group: 'maintenance', audience: 'landlord',
    inAppOnly: true,
    when: 'A team member tries to approve work above their own spending limit, so it still needs you.' },
  { type: 'maintenance_pm_alert', label: 'Maintenance alerts for managers', group: 'maintenance', audience: 'landlord',
    when: 'A request at a property you manage needs a manager — emergencies and ones over the approval limit.' },
  { type: 'maintenance_assigned', label: 'Work was assigned to you', group: 'maintenance', audience: 'landlord',
    when: 'A maintenance request is assigned to you.' },
  { type: 'maintenance_updated', label: 'Updates on your requests', group: 'maintenance', audience: 'tenant',
    when: 'A maintenance request of yours changes status or gets scheduled.' },
  { type: 'service_due', label: 'Scheduled service is due', group: 'maintenance', audience: 'landlord',
    when: 'Recurring service on a unit or piece of equipment comes due.' },
  { type: 'inspection_ready', label: 'An inspection is ready for you to sign', group: 'maintenance', audience: 'tenant',
    when: 'An inspection of your unit is ready for your signature.' },
  { type: 'inspection_tenant_signed', label: 'A resident signed an inspection', group: 'maintenance', audience: 'landlord',
    when: 'A resident signs an inspection.' },
  { type: 'inspection_submitted', label: 'An inspection was turned in', group: 'maintenance', audience: 'landlord',
    when: 'A resident or staff member turns in a completed inspection.' },
  { type: 'inspection_finalized', label: 'An inspection was finalized', group: 'maintenance', audience: 'both',
    when: 'An inspection is signed off and final.' },
  { type: 'inspection_scheduled', label: 'An inspection is scheduled', group: 'maintenance', audience: 'tenant',
    when: 'An in-person inspection of your unit is put on the calendar.' },
  { type: 'inspection_scheduled_reminder', label: 'Inspection reminder', group: 'maintenance', audience: 'both',
    when: 'A scheduled inspection is coming up.' },
  { type: 'inspection_flagged_suspicious', label: 'An inspection needs doing in person', group: 'maintenance', audience: 'landlord',
    when: 'A resident-submitted inspection is flagged, so an in-person one is scheduled.' },
  { type: 'moveout_inspection_due', label: 'A move-out inspection is due', group: 'maintenance', audience: 'landlord',
    when: 'A household is leaving and the move-out inspection has not been done.' },
  { type: 'entry_request_new', label: 'A request to enter your unit', group: 'maintenance', audience: 'tenant',
    when: 'Your landlord asks to enter your unit.' },
  { type: 'entry_request_responded', label: 'A resident answered an entry request', group: 'maintenance', audience: 'landlord',
    when: 'A resident answers a request to enter.' },
  { type: 'entry_recorded', label: 'An entry was recorded', group: 'maintenance', audience: 'tenant',
    when: 'Your landlord records that they entered your unit.' },

  // ── Utilities and meters ──────────────────────────────────────────────────
  { type: 'utility_reading_run_opened', label: 'Meter readings are open', group: 'utilities', audience: 'landlord',
    when: 'A property’s meter-reading round opens for the cycle.' },
  { type: 'utility_reads_need_review', label: 'Meter readings need a look', group: 'utilities', audience: 'landlord',
    when: 'A reading round finishes with numbers worth checking before billing.' },
  { type: 'utility_bills_ready_to_review', label: 'Utility bills are ready to review', group: 'utilities', audience: 'landlord',
    when: 'A cycle’s utility bills are calculated and waiting on your review.' },
  { type: 'utility_meter_broken', label: 'A meter is not reading', group: 'utilities', audience: 'landlord',
    inAppOnly: true,
    when: 'A meter reads the same number twice while the space was occupied.' },
  { type: 'utility_usage_unbilled', label: 'Usage that was never billed', group: 'utilities', audience: 'landlord',
    inAppOnly: true,
    when: 'Metered usage goes unbilled for a cycle.' },
  { type: 'held_utility_prior_occupant', label: 'A held utility charge belongs to whoever was there before', group: 'utilities', audience: 'landlord',
    inAppOnly: true,
    when: 'A utility charge is held because the usage belongs to the previous occupant.' },
  { type: 'moveout_meter_reads_due', label: 'Move-out meter readings are due', group: 'utilities', audience: 'landlord',
    when: 'A household is leaving and their final meter readings have not been taken.' },
  { type: 'tenant_date_meter_reads_due', label: 'Meter readings are due on your date', group: 'utilities', audience: 'both',
    when: 'A reading date set with a resident (a work-trade duty, for example) comes due.' },
  { type: 'final_utility_invoice', label: 'A final utility bill', group: 'utilities', audience: 'both',
    inAppOnly: true,
    when: 'A household’s last utility bill is issued after they leave.' },
  { type: 'service_interruption', label: 'Utility outage or service interruption', group: 'utilities', audience: 'tenant',
    when: 'Service to your unit is out or will be interrupted.' },
  { type: 'service_moveout_notice', label: 'A utility agreement is ending', group: 'utilities', audience: 'landlord',
    inAppOnly: true,
    when: 'A resident gives notice on a utility service agreement.' },
  { type: 'utility_bill_owed_again', label: 'A refund put a utility bill back on the books', group: 'utilities', audience: 'landlord',
    // In the bell, like every other register money notice (a held payment, a
    // link paid twice): the refund was just taken at the desk, and what the
    // account holder needs is the bill back in front of them, not mail.
    inAppOnly: true,
    when: 'A pay link that had paid somebody’s utility bill is refunded in full, so the bill is owed again.' },
  { type: 'utility_part_refund_kept', label: 'A part refund on a sale that had paid a utility bill', group: 'utilities', audience: 'landlord',
    // 10/20 (fix): a part refund re-billing the whole bill asks the payer for
    // money the landlord is still holding, so GAM leaves the bill closed out
    // and puts the decision in front of a person instead.
    inAppOnly: true,
    when: 'Part of a sale that had closed out somebody’s utility bill is refunded, so somebody has to say whether that bill is owed again.' },
  { type: 'stay_utilities_not_billed', label: 'A stay’s utilities are not being billed', group: 'utilities', audience: 'landlord',
    inAppOnly: true,
    when: 'A 30-plus-night stay cannot be billed for utilities because the reservation’s email is a staff login.' },

  // ── Reservations and stays ────────────────────────────────────────────────
  { type: 'reservation_requested', label: 'A common-area reservation request', group: 'bookings', audience: 'landlord',
    when: 'A resident asks to reserve a common area or amenity.' },
  { type: 'reservation_decision', label: 'Your reservation was approved or declined', group: 'bookings', audience: 'tenant',
    when: 'A reservation you asked for is decided.' },
  { type: 'amenity_unavailable', label: 'An amenity is closed or reserved', group: 'bookings', audience: 'tenant',
    when: 'A shared space is closed, booked for a private event, or open again.' },
  { type: 'booking_change_request', label: 'A guest asked to change a stay', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A guest asks to change their dates or site — or the change fits and was confirmed on the spot.' },
  { type: 'booking_moved', label: 'A reservation was moved to another site', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A reservation has to move sites.' },
  { type: 'booking_displaced', label: 'A reservation has nowhere to go', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A reservation is pushed off its site and nothing else fits.' },
  { type: 'booking_lease_sync', label: 'A reservation and its lease disagree', group: 'bookings', audience: 'landlord',
    when: 'A reservation’s dates and its lease stop lining up.' },
  { type: 'hold_lease_left_open', label: 'A hold’s lease was left open', group: 'bookings', audience: 'landlord',
    when: 'A site is held for a lease that was never finished.' },
  { type: 'site_out_of_order_stay', label: 'A stay sits on an out-of-order site', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A site with a stay on it is marked out of order.' },
  { type: 'stay_lengthened_rent_billed', label: 'Your stay got longer and was billed', group: 'bookings', audience: 'tenant',
    when: 'Your stay is extended, so the extra nights are billed.' },
  { type: 'stay_shortened_retry_canceled', label: 'Your stay got shorter', group: 'bookings', audience: 'tenant',
    when: 'Your stay is cut short, so a scheduled collection is called off.' },
  { type: 'stay_lease_not_ended', label: 'A checked-out stay still has a live lease', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A guest checks out early but their lease was never ended.' },
  { type: 'stay_refund_failed', label: 'A guest refund failed', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A refund to a guest is rejected or comes back.' },
  { type: 'stay_money_decision', label: 'A checked-out guest’s money needs a decision', group: 'bookings', audience: 'landlord',
    inAppOnly: true,
    when: 'A guest who paid ahead is checked out by someone who cannot refund, so the money waits on you.' },

  // ── Documents and signatures ──────────────────────────────────────────────
  { type: 'esign_request', label: 'Something is waiting for your signature', group: 'documents', audience: 'both',
    when: 'A document reaches you in the signing order.' },
  { type: 'esign_completed', label: 'A document is fully signed', group: 'documents', audience: 'both',
    when: 'Everyone on a document has signed it.' },
  // 10/20: both of these are emailed from services/email.ts and were written on
  // no page. A withdrawn document reaches whoever was asked to sign it; the
  // unsigned-resident digest reaches the landlord who is waiting.
  { type: 'esign_voided', label: 'A document was withdrawn', group: 'documents', audience: 'both',
    emailOnly: true,
    when: 'A document you were asked to sign is withdrawn or lapses before it is signed.' },
  { type: 'esign_unsigned_reminder', label: 'A resident has not signed yet', group: 'documents', audience: 'landlord',
    emailOnly: true,
    when: 'A lease you sent is still unsigned after its reminder window — one email listing them.' },

  // ── Register, pay links and stock ─────────────────────────────────────────
  { type: 'pos_low_stock', label: 'Register stock is low', group: 'register', audience: 'landlord',
    when: 'An item in the register falls below its reorder point.' },
  { type: 'low_stock', label: 'Stock is low', group: 'register', audience: 'landlord',
    when: 'An item you keep on hand falls below its reorder point.' },
  { type: 'pay_link_left_owed', label: 'A pay link was paid but money is still owed', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'A pay link is paid short and nothing is set to ask for the rest.' },
  { type: 'pay_link_paid_twice', label: 'A pay link was paid twice', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'The same pay link is paid more than once.' },
  { type: 'pay_link_over_owed', label: 'A pay link was overpaid', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'A pay link is paid for more than was owed.' },
  { type: 'pay_link_deposit_part', label: 'A pay link covered part of a deposit', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'A pay link payment lands against part of a reservation deposit.' },
  { type: 'pay_link_amount_mismatch', label: 'A pay link was paid at the wrong amount', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'A pay link is changed after the payer opened it, so what they paid is not what it asks.' },
  { type: 'pay_link_paid_after_close', label: 'A pay link was paid after it closed', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'Money arrives on a pay link that was already closed out.' },
  { type: 'pay_link_reservation_gone', label: 'A paid link’s reservation is gone', group: 'register', audience: 'landlord',
    inAppOnly: true,
    when: 'A pay link is paid for a reservation that no longer exists.' },
] as const

/**
 * THE COMPILER IS THE GUARD.
 *
 * `NotificationType` is the union of every `type` above, and
 * `createNotification` takes it rather than `string`. A notification whose type
 * is not in the catalog does not compile, which is why a type can no longer be
 * added over a weekend and go years without a switch on the settings page.
 */
export type NotificationType = typeof NOTIFICATION_CATALOG_SOURCE[number]['type']

/**
 * The same list, shape-checked against the interface (which `as const` above
 * does not do on its own) and widened so a reader can get at fields only some
 * entries carry. EVERY read goes through this one; the source above exists only
 * so the type union can be derived from it.
 */
export const NOTIFICATION_CATALOG: readonly NotificationCatalogEntry[] = NOTIFICATION_CATALOG_SOURCE

export const NOTIFICATION_TYPES: readonly NotificationType[] =
  NOTIFICATION_CATALOG_SOURCE.map(e => e.type)

const BY_TYPE = new Map(NOTIFICATION_CATALOG.map(e => [e.type, e]))

/** The catalog entry for a type, or undefined for one that is retired. */
export const notificationEntry = (t: string): NotificationCatalogEntry | undefined => BY_TYPE.get(t)

/**
 * What a person reads instead of the stored type. Falls back to the type with
 * its underscores opened up, so even a retired row never shows a raw enum.
 */
export const notificationLabel = (t: string): string =>
  BY_TYPE.get(t)?.label ?? t.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

/**
 * S570 / S609 / S655 (Nic): the notices too important to silence. Email is
 * FORCED on for these whatever the stored answer says, because missing one does
 * real harm — a failed rent payment slipping into a late fee or an eviction
 * clock. They are derived from the catalog so the page that locks the box, the
 * delivery decision and this list cannot drift apart.
 */
export const CRITICAL_NOTIFICATION_TYPES: readonly NotificationType[] =
  NOTIFICATION_CATALOG.filter(e => e.critical).map(e => e.type as NotificationType)
export type CriticalNotificationType = NotificationType
export const isCriticalNotificationType = (t: string): boolean =>
  (CRITICAL_NOTIFICATION_TYPES as readonly string[]).includes(t)

/**
 * Types that exist in old rows but nothing sends any more. They keep their
 * place here so a report or a notification feed can still name them in plain
 * words, and so the catalog test can tell a retired type from one that was
 * forgotten.
 *
 * `rent_failed`, `disbursement_sent` and `work_trade_reminder` are the other
 * half of the same drift: they sat on the settings pages for months with no
 * sender behind them, so a landlord was unchecking boxes for email that never
 * existed while real types had no box at all.
 */
export const RETIRED_NOTIFICATION_TYPES: readonly string[] = [
  'disbursement_sent',
  'lease_renewal_action_required',
  'maintenance_building_notice',
  'esign_document_declined',
  'landlord_member_added',
  'lease_drafted_from_application',
  'move_meter_reads_due',
  'rent_failed',
  'work_trade_reminder',
]

/** A type GAM still knows about at all — on the page, or only in old rows. */
export const isKnownNotificationType = (t: string): boolean =>
  BY_TYPE.has(t) || RETIRED_NOTIFICATION_TYPES.includes(t)

/** The entries that belong on one audience's settings page, in page order. */
export function notificationCatalogFor(
  audience: 'landlord' | 'tenant',
  opts: { isAccountHolder?: boolean } = {},
): NotificationCatalogEntry[] {
  const owner = opts.isAccountHolder !== false
  return NOTIFICATION_CATALOG.filter(e =>
    (e.audience === audience || e.audience === 'both') && (owner || !e.ownerOnly))
}

/** The same entries, bundled under their group headings in page order. */
export function notificationGroupsFor(
  audience: 'landlord' | 'tenant',
  opts: { isAccountHolder?: boolean } = {},
): Array<{
  group: NotificationGroup; label: string; entries: NotificationCatalogEntry[]
}> {
  const mine = notificationCatalogFor(audience, opts)
  return NOTIFICATION_GROUPS
    .map(g => ({ group: g, label: NOTIFICATION_GROUP_LABEL[g], entries: mine.filter(e => e.group === g) }))
    .filter(s => s.entries.length > 0)
}
