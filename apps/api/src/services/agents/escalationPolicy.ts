/**
 * When may the agent involve a real person? Only for real money.
 *
 * S618 (Nic): "any sort of bringing an outside person into the conversation
 * should only be done if it's real money. If somebody has a problem with
 * switching bank accounts, switching, getting charged the wrong amount, that
 * sort of thing, that needs to be escalated to a real person to look into.
 * Other than that, no promises of talking to a real person or talking to
 * anybody else."
 *
 * The harm being prevented is a promise nobody receives: the customer stops
 * looking for help and waits for a callback that was never booked. S617
 * measured the same harm from the other direction — a tenant asked their
 * balance, got a correct answer, and had it REPLACED with "I've escalated
 * this, someone will email you within 24 hours."
 *
 * Lives in its own module because agentSession needs it too, and
 * agentSession.test.ts replaces the whole agentRunner module with a mock —
 * importing it from there made these undefined in every one of those tests.
 */

/** A demand to move money — refund, double charge, missing payout. */
export const MONEY_DISPUTE_INTENT =
  /\brefund\b|double.?charged|charged (me )?twice|overcharged|charge.?back|didn.?t authori[sz]e|(payout|transfer|my money).{0,30}(never|didn'?t|hasn'?t|not) (arrived?|show(ed|n)? up|hit|come)|where('?s| is) my money\b|disput(e|ing|ed).{0,30}(charge|payment|transaction|bank)|(want|get|getting) my money back/i

/** Nic named this one specifically: trouble switching or fixing a bank account. */
export const BANK_CHANGE_PROBLEM =
  /\b(bank|account|routing|card)\b[^.?!]{0,40}\b(switch\w*|chang\w+|updat\w+|remov\w+|replac\w+|wrong|incorrect|closed)\b|\b(switch\w*|chang\w+|updat\w+)\b[^.?!]{0,25}\b(bank|bank account|payment method|card|routing)\b/i

/**
 * Account takeover. Kept deliberately: someone else inside the account is money
 * at risk, which is the same category. Threats of LEGAL action are not kept —
 * under this rule the agent answers what it can and promises nobody.
 */
export const ACCOUNT_SECURITY_INTENT =
  /\bhacked\b|hacker|someone (else )?(logged|signed|got) in(to)?|unauthori[sz]ed (access|login)|account (was |got |is )?(compromised|stolen|taken over)|login (alert|attempt).{0,25}(don'?t|did ?n'?t|do not) recognize/i

const HANDOFF_VERB =
  /\b(transfer(?:ring)?\s+you|connect(?:ing)?\s+you\s+with|put\s+you\s+through|hand(?:ing)?\s+(?:this|you|it)\s+(?:off|up|over)|pass(?:ing)?\s+(?:this|you|it)\s+(?:on|up|along)|bring(?:ing)?\s+in|loop(?:ing)?\s+(?:you\s+)?in)\b/i
const SUPPORT_TARGET =
  /\b(senior|supervisor|specialist|strategist|a\s+human|(?:real|live)\s+person|gam\s+support|support\s+(?:team|specialist|strategist|agent|representative)|(?:right|appropriate)\s+(?:team|department|person)|someone\s+(?:who|that)\s+can)\b/i

/**
 * A threat of legal action. NOT a reason to promise a callback — but not a
 * reason to say nothing either.
 *
 * S618 (Nic): "if there's some sort of legal action mentioned, just have it say
 * — for assistance, please message support@goldassetmanagement.com to have
 * someone contact you. That way they have to reach out, not us promising we're
 * gonna reach out. Anybody that's just blowing smoke isn't gonna bother
 * reaching out. Anybody that is a little more serious will make the reach out,
 * and it kind of prefilters some people for us."
 *
 * So the agent hands over an address and the customer decides. GAM commits to
 * nothing it has not scheduled, and the ones who actually matter self-select.
 */
export const LEGAL_ACTION_INTENT =
  /take legal action|legal action against|(talk|speak|spoke) to (a |my )?(lawyer|attorney)|(my|a|an|the) (lawyer|attorney)\b|\bsue\b|\bsuing\b|small claims|press charges|\bcourt\b|\beviction notice\b/i

/** The line to add when someone raises legal action. */
export const LEGAL_CONTACT_LINE =
  'For assistance with this, please message support@goldassetmanagement.com and someone will contact you.'

export function mentionsLegalAction(message: string): boolean {
  return !!message && LEGAL_ACTION_INTENT.test(message)
}

/**
 * ANNOUNCING legal action, as opposed to merely mentioning the law.
 *
 * Deliberately NARROWER than LEGAL_ACTION_INTENT. That pattern also matches bare
 * topic words — "court", "eviction notice" — which is right for appending a
 * support contact line, and wrong for forcing a handoff: "how do I serve an
 * eviction notice?" is a routine landlord question with a routine answer, and
 * sending it to a human every time would make the agent useless to the people
 * who use it most.
 *
 * What belongs here is INTENT: someone saying they are going to act against the
 * other party. That is a hard stop no lookup can serve.
 */
export const LEGAL_DISPUTE_INTENT =
  /take legal action|legal action against|taking (them|him|her|this|my landlord|my tenant) to court|(talk|speak|spoke|talking) to (a |my )?(lawyer|attorney)|(get|hire|hiring|getting) (a |an )?(lawyer|attorney)|\bmy (lawyer|attorney)\b|\bsue\b|\bsuing\b|small claims|press charges/i

export function needsARealPerson(message: string): boolean {
  if (!message) return false
  return MONEY_DISPUTE_INTENT.test(message)
    || BANK_CHANGE_PROBLEM.test(message)
    || ACCOUNT_SECURITY_INTENT.test(message)
    // S624: A LEGAL DISPUTE IS A HARD STOP AND WAS MISSING FROM THIS LIST.
    //
    // The profile prompts have always called it one, using this literal example
    // ("my landlord is illegally withholding my deposit and I want to act on
    // it"). But the anti-over-escalation guard in agentRunner asks THIS function
    // whether a message needs a person, and legal intent was not in it — so the
    // guard saw "deposit", decided a tool could answer it, CANCELLED the
    // agent's correct escalation, and looked the deposit up instead.
    //
    // A tenant announcing legal action got a balance figure rather than a human.
    // That is the single worst turn in the suite to get wrong: it is where GAM
    // has legal exposure and where the person is most distressed, and it failed
    // in a way that looked like helpfulness.
    || LEGAL_DISPUTE_INTENT.test(message)
}

/**
 * Remove a promise of a person from a reply not entitled to make one.
 *
 * Keeps every other sentence — the useful part of the answer usually sits in
 * them, and discarding those is the S617 mistake repeated.
 */
export function stripPromiseOfAPerson(reply: string): string {
  if (!reply) return reply
  // S624 — KEEP THE WHITESPACE. The pattern excluded \n from every match and the
  // pieces were rejoined with '', so EVERY newline in the reply was destroyed —
  // a rate list ran straight into the sentence after it ("$48 per nightRemember,
  // the weekly rate..."). It read as a cosmetic quirk of one booking reply and
  // was actually happening to every reply this function touched, which is any
  // reply that promised a person without being entitled to.
  //
  // Trailing whitespace now rides along with its sentence, so join('') puts the
  // structure back exactly as the model wrote it, and a REMOVED sentence takes
  // its own separator with it rather than leaving a hole.
  const kept = (reply.match(/[^.!?\n]+[.!?]*\s*/g) ?? [reply]).filter((sentence) => {
    const promises =
      /\bescalat\w+/i.test(sentence) ||
      (HANDOFF_VERB.test(sentence) && SUPPORT_TARGET.test(sentence)) ||
      /\b(someone|somebody|a (?:team )?member|the team|a rep\w*)\b[^.!?]{0,40}\b(will|to)\b[^.!?]{0,25}\b(get back|reach out|contact|email|call|follow up)\b/i.test(sentence) ||
      /\b(get back to you|reach out to you|follow up with you)\b/i.test(sentence)
    return !promises
  })
  const out = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return out || reply
}
