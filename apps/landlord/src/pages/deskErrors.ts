// The Front Desk's work screens (call list, who owes, move-outs, emergency
// contacts, the bank deposit) say a failure once, in plain words, with the step
// that works (decisions.md staff rule). One place, so every tab says it alike.
//
// A bare refusal (requirePerm's "Insufficient permissions", or a 403 with no
// words) is access, not a fault: the server reads a staffer's switches from
// their sign-in, so a switch the owner turned on a minute ago shows the tab (the
// page reads permissions fresh) while the server still refuses it until they
// sign in again. Refreshing does not fix that; signing out and back in does. If
// it is really off, the owner is who turns it on.
//
// Any other 403 carries its own reason ("Kim's $460.00 was taken at a property
// you are not assigned to.", "You are not a member of that entity") and that
// reason IS the next step, so it is said as the server said it — never turned
// into "ask the owner to turn on a switch" they already hold.

const withStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

const statusOf = (err: unknown): number | undefined => (err as any)?.response?.status

/** The server's own words on a refusal, or '' when it sent none. */
const serverReason = (err: unknown): string => {
  const data = (err as any)?.response?.data
  const said = data?.error ?? data?.message
  return typeof said === 'string' ? said.trim() : ''
}

/** A 403 that is the generic switch refusal rather than a refusal with its own reason. */
export function isSwitchRefusal(err: unknown): boolean {
  if (statusOf(err) !== 403) return false
  const said = serverReason(err)
  return said === '' || /^insufficient permissions\.?$/i.test(said)
}

/** The sentence for a request the server refused for access (403). */
export function accessSentence(what: string, switchName: string): string {
  return `${what} is not open to you right now. If the owner just changed your access, sign out and back in to pick it up. `
    + `If it still says this, ask the owner to turn on "${switchName}" for you.`
}

/**
 * A list the server would not give: its own reason, then the next step. Never
 * an empty list that reads as "nothing here". `lead` puts the list's name first
 * ("The slips already made could not be loaded: …") for a list shown beside
 * others that did load.
 */
export function loadFailedSentence(
  err: unknown, what: string, switchName: string, opts: { lead?: boolean } = {},
): string {
  if (isSwitchRefusal(err)) return accessSentence(what, switchName)
  if (statusOf(err) === 403) {
    // A refusal with its own reason: that reason, as said. Trying again will
    // not change it, so no "refresh".
    const said = serverReason(err)
    return withStop(opts.lead ? `${what} could not be loaded: ${said}` : said)
  }
  const said = String((err as any)?.message ?? '').trim()
  const reason = opts.lead
    ? `${what} could not be loaded${said ? `: ${said}` : ''}`
    : (said || `${what} could not be loaded`)
  return `${withStop(reason)} Refresh the page; if it keeps happening, tell GAM support.`
}

/** An action the server refused: its own sentence, or the access step for a bare 403. */
export function actionFailedSentence(err: unknown, fallback: string, what: string, switchName: string): string {
  if (isSwitchRefusal(err)) return accessSentence(what, switchName)
  const said = serverReason(err) || String((err as any)?.message ?? '').trim()
  return withStop(said || fallback)
}

/**
 * Every list on these screens is read again whenever it is looked at. The
 * portal's QueryClient keeps answers 5 minutes and never refetches on mount, so
 * without this a tab opened again shows the list from before (a payment taken
 * on another page meanwhile, a resident who just paid).
 */
export const FRESH_LIST = { refetchOnWindowFocus: true, refetchOnMount: 'always' as const, staleTime: 0 }
