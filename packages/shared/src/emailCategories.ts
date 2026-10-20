/**
 * THE OTHER ROAD OUT. ONE DECLARATION PER EMAIL GAM CAN SEND.
 *
 * 10/20 (Nic): "I don't want you to switch off three remaining email settings
 * when you said there's five critical things and 22 other ones that weren't even
 * on the list. Like, you're thinking too narrow. I want you to fix the root, not
 * just one off because one landlord wants a setting a certain way. We're fixing
 * root problems here."
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The notification catalog closed one road: `createNotification` takes a type
 * from the catalog, the settings pages render from the catalog, so a type with
 * no switch does not compile. That road is now airtight.
 *
 * There are TWO roads. Every email in GAM goes through one function,
 * `send()` in services/email.ts, and about fifty of its callers never touch
 * `createNotification` at all — they are senders in their own right, each
 * stamping a `category` on the log row. Those categories were invisible to the
 * catalog, the settings pages, the compiler and the completeness test. Blu Haws
 * answered every box on his page (90 rows, 0 emailing, read out of `gam`) and
 * the 7am overdue digest, the monthly bill, the payment receipt, the signing
 * request, the three signing reminders and the monthly property report all kept
 * arriving, because not one of them asked.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Every category is declared here, exactly once, as one of two things:
 *
 *   gate:   this email IS a notification. `send()` reads the recipient's
 *           notification_preferences row for that type and does not send when
 *           they have switched it off. The type is in NOTIFICATION_CATALOG, so
 *           it has a row on their settings page and they were asked.
 *
 *   always: this email is the answer to something the person just did, or it
 *           goes to somebody with no GAM settings page at all — a sign-in code,
 *           an invitation, a receipt handed to a walk-up customer, a legally
 *           required notice. `why` is the reason, in plain words, and it is
 *           read by a person reviewing this list, not by code.
 *
 * A category that is in neither is DRIFT: `emailCategoryRule` returns
 * undefined, `send()` logs it loudly, and notificationCatalog.test.ts fails
 * naming it. That is the failure a future session gets for writing a sender
 * without deciding whether the recipient may decline it.
 *
 * `label` is what a person reads instead of the stored category string
 * (memory: gam-no-raw-enums-in-ui). The landlord's Email Delivery Issues table
 * printed the raw string — "late_payment_notice" — directly under eighty rows
 * of careful English. Categories and notification types are two different
 * namespaces; this is where they are reconciled.
 */
import { notificationLabel, type NotificationType } from './notificationCatalog'

/** An email the recipient can switch off, and the notification type that does it. */
export interface GatedEmailCategory {
  readonly label: string
  readonly gate: NotificationType
  readonly always?: undefined
}

/** An email that goes whatever the settings say, and the reason why. */
export interface AlwaysEmailCategory {
  readonly label: string
  readonly always: string
  readonly gate?: undefined
}

export type EmailCategoryRule = GatedEmailCategory | AlwaysEmailCategory

/**
 * EVERY category stamped on an email_send_log row, with its decision.
 *
 * Grouped the way the file reads, not alphabetically: what a person asked for,
 * then identity, then invitations, then the notifications, then the ones that
 * reach somebody who is not a GAM user.
 */
export const EMAIL_CATEGORY_RULES: Readonly<Record<string, EmailCategoryRule>> = {
  // ── Signing in and proving who you are ────────────────────────────────────
  login_2fa_code: { label: 'Sign-in code', always:
    'It is the second factor of a sign-in they are in the middle of. A setting cannot stand between somebody and their own account.' },
  password_reset: { label: 'Password reset', always:
    'They pressed "forgot password" seconds ago; the link is the whole answer.' },
  email_verification: { label: 'Email verification', always:
    'It proves the address belongs to them, which is what makes every later setting meaningful.' },
  email_change_confirm: { label: 'Confirm your new email address', always:
    'It confirms a change they just asked for, at the new address, before GAM moves their mail.' },
  email_change_notice: { label: 'Notice that your email address changed', always:
    'It goes to the OLD address so somebody who did not ask for the change finds out. Suppressing it is how an account is taken over quietly.' },

  // ── Invitations: nobody has a settings page before they have an account ───
  invitation: { label: 'Team invitation', always:
    'It is the invitation itself — the recipient has no account yet, so no settings page and no answer to read.' },
  admin_invitation: { label: 'Admin invitation', always:
    'The invitation that creates a GAM staff account.' },
  landlord_coowner_invitation: { label: 'Co-owner invitation', always:
    'The invitation that adds them to an account.' },
  pm_invitation: { label: 'Management-company staff invitation', always:
    'The invitation that creates their management-company login.' },
  pm_property_invitation: { label: 'Management-company property invitation', always:
    'An offer between an owner and a management company, which one side is waiting on.' },
  business_invitation: { label: 'Business invitation', always:
    'The invitation that creates their business login.' },
  tenant_invite: { label: 'Invitation to your resident portal', always:
    'It carries the link that sets their password. Without it there is no account and nothing to switch off.' },
  tenant_invite_reminder: { label: 'Reminder of your portal invitation', always:
    'The same invitation, still unaccepted. They have no portal yet, so they have never been asked anything.' },
  tenant_onboarded: { label: 'Your landlord added you to GAM', always:
    'It carries the activation link for an account that does not exist until they use it.' },
  utility_service_invite: { label: 'Invitation to a utility service account', always:
    'The invitation that creates the service account.' },
  sublease_invite: { label: 'Sublease invitation', always:
    'The invitation itself, to somebody with no account.' },
  pos_customer_onboarding: { label: 'Register customer invitation', always:
    'The invitation that creates their customer record at a business.' },

  // ── Something they asked for, moments ago ─────────────────────────────────
  customer_portal: { label: 'Your customer portal link', always:
    'They asked for the link on the page they were looking at.' },
  business_customer_portal_link: { label: 'Your business portal link', always:
    'They asked for the link on the page they were looking at.' },
  screening_apply_link: { label: 'Your application link', always:
    'They asked GAM to email them the link.' },
  background_screening_request: { label: 'Background check needed', always:
    'It is the screening they have to complete to go on; declining the email would only strand them.' },
  background_decision: { label: 'Your application decision', always:
    'The decision on their own application. A person waiting on an answer gets the answer.' },
  adverse_action: { label: 'Adverse action notice', always:
    'A notice the law requires GAM to deliver. It is not a preference.' },
  tenant_ach_setup: { label: 'Set up your bank payments', always:
    'It carries the setup link for the bank account they are going to pay rent from.' },
  landlord_banking_setup: { label: 'Set up your bank account', always:
    'The bank link is required of every landlord (it is both the payout and the debit), so the setup link is not optional either.' },
  bank_verification_sent: { label: 'Finish verifying your bank account', always:
    'It carries the two small deposits for a bank link THEY started. Until it is finished no money can move.' },
  bank_verification_reminder: { label: 'Reminder to finish verifying your bank', always:
    'The same half-finished bank link. Rent cannot be paid until it is done, so going quiet about it costs them a late fee.' },
  flexsuite_flexpay_enrollment_confirmation: { label: 'Your FlexPay terms', always:
    'It carries the agreement they just signed, as a PDF. A copy of your own signed agreement is not a notification.' },
  flexsuite_flexdeposit_enrollment_confirmation: { label: 'Your FlexDeposit agreement', always:
    'It carries the agreement they just signed, as a PDF.' },
  property_transfer_approval: { label: 'Property transfer approval', always:
    'A transfer of a property between accounts, which the other side is waiting on.' },
  property_transfer_offer: { label: 'Property transfer offer', always:
    'A transfer of a property between accounts, which the other side is waiting on.' },
  support_message: { label: 'Message from GAM support', always:
    'A person at GAM typed it and pressed send to this address.' },

  // ── Guests and walk-up customers: no GAM account, no settings page ────────
  guest_stay_link: { label: 'Your stay details', always:
    'A guest with no GAM login. It is how they reach the stay they booked.' },
  booking_confirmation: { label: 'Your reservation', always:
    'A guest with no GAM login, being told they have a reservation on these dates and what it costs. '
    + 'Nobody sends it but a person at the property, one guest at a time, and it is the only place the '
    + 'deposit is offered to them — a setting standing in front of it would leave them never told.' },
  booking_site_reveal: { label: 'Your site assignment', always:
    'A guest with no GAM login, being told which site is theirs.' },
  booking_site_changed: { label: 'Your site changed', always:
    'A guest with no GAM login, being told the site they are arriving at is not the one they booked. Silence here means they drive to the wrong space.' },
  booking_guest_access: { label: 'Your access details', always:
    'A guest with no GAM login, being told how to get in.' },
  pos_receipt: { label: 'Register receipt', always:
    'A receipt for a sale at a counter, to whoever just paid. They have no GAM account and asked for it at the register.' },
  pos_pay_link: { label: 'Payment link', always:
    'A bill somebody is waiting to be paid. The link is the bill.' },
  business_invoice_sent: { label: 'Invoice from a business', always:
    'A business invoicing its own customer, who has no GAM settings page.' },
  business_quote_sent: { label: 'Quote from a business', always:
    'A business quoting its own customer, who asked for it.' },
  business_appointment_confirmed: { label: 'Appointment confirmed', always:
    'A business confirming its own customer’s appointment.' },
  business_appointment_reminder: { label: 'Appointment reminder', always:
    'A business reminding its own customer of an appointment. The business portal is its own product with its own customers (memory: gam-pos-business-isolation) — they have no GAM notification settings.' },
  business_card_update_request: { label: 'Card update needed', always:
    'A business asking its own customer to fix a card that is failing.' },

  // ── Sales and GAM's own staff ─────────────────────────────────────────────
  sales_call_reminder: { label: 'Sales call reminder', always:
    'A prospect who booked a call, not a GAM user with a settings page.' },
  demo_booking_confirmation: { label: 'Demo booking confirmation', always:
    'A prospect confirming the demo they just booked.' },
  demo_booking_headsup: { label: 'Demo booking heads-up', always:
    'GAM’s own staff, about their own calendar.' },
  landlord_signup: { label: 'New landlord signup', always:
    'GAM’s own staff, about a signup.' },
  landlord_welcome_outreach: { label: 'Welcome to GAM', always:
    'The onboarding-call offer that goes out about ninety minutes after an organic signup (memory: gam-landlord-welcome-outreach). It reaches somebody who has not opened the portal yet.' },

  // ── The notifications: every one of these has a row on a settings page ────
  late_payment_notice: { label: 'Overdue balances each morning', gate: 'late_balance_digest' },
  invoice_ready: { label: 'Your bill is ready', gate: 'invoice_ready' },
  payment_receipt: { label: 'Receipt for a payment', gate: 'payment_receipt' },
  balance_due_reminder: { label: 'Reminder of what you owe', gate: 'balance_due_reminder' },
  monthly_property_report: { label: 'Monthly property report', gate: 'monthly_property_report' },
  esign_signing_request: { label: 'Something is waiting for your signature', gate: 'esign_request' },
  esign_signing_reminder: { label: 'Reminder: something is waiting for your signature', gate: 'esign_request' },
  esign_signing_completed: { label: 'A document is fully signed', gate: 'esign_completed' },
  esign_document_auto_voided: { label: 'A document was withdrawn', gate: 'esign_voided' },
  esign_new_lease_unsigned: { label: 'A resident has not signed yet', gate: 'esign_unsigned_reminder' },
  background_new: { label: 'A background check came back', gate: 'background_check_new' },
  pool_match_interest: { label: 'A landlord is interested in you', gate: 'match_interest' },
  pool_tenant_interested: { label: 'Someone in the renter pool is interested', gate: 'pool_tenant_interested' },
  birthday: { label: 'Birthday greeting', gate: 'birthday' },
}

/**
 * The prefix `sendNotificationEmail` stamps on the notification road. The
 * preference was already read by `createNotification` before the email was
 * handed over, so `send()` does not ask twice.
 */
export const NOTIFICATION_EMAIL_CATEGORY_PREFIX = 'notif_'

/**
 * Types that ride the `notif_` prefix WITHOUT having come from
 * `createNotification`, so nothing upstream read a preference and there is no
 * catalog entry to read one from. Both are deliberate.
 *
 * `admin_` is matched as a prefix: services/adminNotifications stamps
 * `admin_<category>` for GAM's own operational alerts to super_admins.
 */
export const UNGATED_NOTIFICATION_EMAIL_TYPES: Readonly<Record<string, string>> = {
  waitlist_claim_link: 'A guest’s one-hour window to claim a stay that just opened. They have no GAM login, and the window closes whether or not they read it.',
}
export const UNGATED_NOTIFICATION_EMAIL_PREFIXES: readonly string[] = ['admin_']

/** What `send()` should do with a category. */
export type EmailGate =
  /** Send it. `why` is the declared reason. */
  | { readonly kind: 'always'; readonly why: string }
  /** Read this notification type's preference row for the recipient first. */
  | { readonly kind: 'preference'; readonly type: NotificationType }
  /** createNotification already asked. Nothing to do here. */
  | { readonly kind: 'decided_upstream' }
  /** Nobody decided. Send, shout about it, and fail the test. */
  | { readonly kind: 'undeclared' }

const isUngatedNotificationType = (t: string): boolean =>
  t in UNGATED_NOTIFICATION_EMAIL_TYPES
  || UNGATED_NOTIFICATION_EMAIL_PREFIXES.some(p => t.startsWith(p))

/** The declaration for a category, or undefined when it is on neither list. */
export function emailCategoryRule(category: string | null | undefined): EmailCategoryRule | undefined {
  if (!category) return undefined
  return EMAIL_CATEGORY_RULES[category]
}

/**
 * What to do with one category. The whole decision, in one place, so the gate
 * in services/email.ts, the test that proves it is complete, and the page that
 * names these categories to a landlord all read the same answer.
 */
export function emailGateFor(category: string | null | undefined): EmailGate {
  if (!category) return { kind: 'undeclared' }
  if (category.startsWith(NOTIFICATION_EMAIL_CATEGORY_PREFIX)) {
    const type = category.slice(NOTIFICATION_EMAIL_CATEGORY_PREFIX.length)
    if (isUngatedNotificationType(type)) {
      return { kind: 'always', why: UNGATED_NOTIFICATION_EMAIL_TYPES[type] ?? 'GAM’s own operational alert to its staff.' }
    }
    return { kind: 'decided_upstream' }
  }
  const rule = EMAIL_CATEGORY_RULES[category]
  if (!rule) return { kind: 'undeclared' }
  return rule.gate ? { kind: 'preference', type: rule.gate } : { kind: 'always', why: rule.always! }
}

/**
 * What a person reads instead of the stored category. A `notif_` category reads
 * as its notification's own label, which is how the two namespaces line up on
 * screen. An undeclared one still never prints as an enum.
 */
export function emailCategoryLabel(category: string | null | undefined): string {
  if (!category) return 'Unlabeled'
  if (category.startsWith(NOTIFICATION_EMAIL_CATEGORY_PREFIX)) {
    return notificationLabel(category.slice(NOTIFICATION_EMAIL_CATEGORY_PREFIX.length))
  }
  const rule = EMAIL_CATEGORY_RULES[category]
  if (rule) return rule.label
  return category.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

/**
 * Every notification type that some direct sender emails. The catalog's
 * `inAppOnly` flag is checked against this, so a row cannot offer an Email box
 * for mail that only this road can deliver.
 */
export const NOTIFICATION_TYPES_EMAILED_BY_CATEGORY: readonly NotificationType[] =
  Object.values(EMAIL_CATEGORY_RULES)
    .map(r => r.gate)
    .filter((t): t is NotificationType => !!t)

/** The sentence written on the log row of an email somebody switched off. */
export const EMAIL_DECLINED_BY_PREFERENCE =
  'Not sent — the recipient switched this one off in their notification settings'
