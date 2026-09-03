/**
 * S637 — the drafts behind the admin's Send Email screen.
 *
 * Nic: "we can have generic drafted ones that are preloaded, ready to go, but
 * just, you know, I can click for this person to get the email to fix their
 * ACH, or I can click for this person to do whatever. And then I can also just
 * compose an actual one if I need to."
 *
 * A template is a STARTING POINT, never a send. The admin picks one, the text
 * lands in an editable box, and what finally goes out is whatever is in that
 * box — so a draft can always be bent to the person it's going to, and nothing
 * is sent that a human did not read.
 *
 * House style, matching emailLandlordWelcomeOutreach: plain sentences, no
 * marketing, no feature tour, one clear thing to do. These go out from
 * support@ so a reply reaches a person.
 */

export interface SupportTemplate {
  id: string
  /** What the admin sees in the picker. */
  label: string
  /** One line under the label — when to reach for this one. */
  when: string
  /** Who it makes sense for; the picker greys out the rest. */
  audience: 'landlord' | 'tenant' | 'any'
  subject: string
  /** `{{firstName}}` is filled from the chosen recipient before it is shown. */
  paragraphs: string[]
}

export const SUPPORT_TEMPLATES: SupportTemplate[] = [
  {
    id: 'ach_failed',
    label: 'Bank details need fixing',
    when: 'A payment came back — wrong account, closed account, or a typo.',
    audience: 'any',
    subject: 'Your bank details need a quick fix',
    paragraphs: [
      'Hi {{firstName}},',
      "A payment on your account didn't go through, and it looks like the bank details we have on file need updating rather than anything being wrong on your end.",
      'You can update them from your account settings — it takes a minute, and once the new account is verified everything picks back up on its own.',
      "If you'd rather I walk you through it, reply here and I'll help.",
    ],
  },
  {
    id: 'landlord_stalled_setup',
    label: 'Stalled part-way through setup',
    when: 'Signed up, started adding things, and stopped.',
    audience: 'landlord',
    subject: 'Following up on your GAM account',
    paragraphs: [
      'Hi {{firstName}},',
      "I noticed you got part-way through setting up your account and haven't been back. No pressure at all — I mostly wanted to check whether something got in the way.",
      "If you got stuck somewhere, or it wasn't what you were expecting, I'd genuinely like to know. That's useful to me either way.",
      "And if you'd like a hand finishing it, I'm happy to help however is easiest — a video call, a phone call, or just over email. Whatever works best.",
      'Reply here and it comes straight to me.',
    ],
  },
  {
    id: 'landlord_never_started',
    label: 'Signed up, never started',
    when: 'Account created, nothing added at all.',
    audience: 'landlord',
    subject: 'Following up on your GAM account',
    paragraphs: [
      'Hi {{firstName}},',
      "You created an account with us and I noticed you haven't had a chance to set anything up yet. No pressure at all — I mostly wanted to check whether something got in the way.",
      "If you got stuck, or it just wasn't what you were expecting, I'd like to know. That kind of thing is useful to me either way.",
      "If you'd like a hand getting your properties in, I'm happy to help however is easiest for you — a video call, a phone call, or back and forth over email.",
      'Reply here and it comes straight to me.',
    ],
  },
  {
    id: 'landlord_bank_for_payouts',
    label: 'Bank needed before payouts',
    when: 'Collecting rent but no payout account connected yet.',
    audience: 'landlord',
    subject: 'One step left before we can pay you out',
    paragraphs: [
      'Hi {{firstName}},',
      "Rent is coming in on your properties, but we don't have a bank account connected yet to send it to — so it's sitting with us rather than reaching you.",
      'Connecting one is a short step in your account settings, and payouts start on the normal schedule once it clears.',
      "If anything about it is unclear, reply and I'll walk you through it.",
    ],
  },
  {
    id: 'tenant_lease_unsigned',
    label: 'Lease still unsigned',
    when: "Their landlord has signed and they haven't.",
    audience: 'tenant',
    subject: 'Your lease is waiting for your signature',
    paragraphs: [
      'Hi {{firstName}},',
      'Your landlord has signed your lease and it just needs your signature to be finished.',
      "The link came by email — if you can't find it, or it isn't working for you, reply here and I'll send you a fresh one.",
      "If something on the lease itself looks wrong, tell me before you sign and we'll get it sorted.",
    ],
  },
  {
    id: 'blank',
    label: 'Blank — write my own',
    when: 'Start from nothing.',
    audience: 'any',
    subject: '',
    paragraphs: ['Hi {{firstName}},', ''],
  },
]

/** Fill a template for one recipient. Unknown names fall back to "there". */
export function fillTemplate(t: SupportTemplate, firstName: string | null | undefined) {
  const name = (firstName || '').trim() || 'there'
  const sub = (s: string) => s.replace(/\{\{firstName\}\}/g, name)
  return { subject: sub(t.subject), paragraphs: t.paragraphs.map(sub) }
}
