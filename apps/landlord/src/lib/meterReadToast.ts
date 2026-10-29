/**
 * 10/20 — WHAT THE DESK IS TOLD AFTER IT PUNCHES IN A READING.
 *
 * The special-read answer has always carried a `billingNote` saying why a read
 * did not bill — the cycle was already billed off the monthly run, the meter is
 * attached to no unit, or the figure is one the landlord has to look at before a
 * final bill goes out. Nothing anywhere read that field. Both screens that take
 * a reading (the utilities page's blind entry form, and the check-in prompt on
 * the schedule) threw it away and said "Reading recorded" for every case, so a
 * dropped digit at a pull-out looked to the clerk exactly like a clean read: the
 * reason the S639 note was added in the first place.
 *
 * One sentence, in one place, so the two screens cannot drift apart on it.
 *
 * Blind staff entry (S559) still holds. The note comes from the server already
 * written for a reader who may not see figures: it never says what the meter
 * read before, what this read was, or which direction the number was off — only
 * that nothing was billed and who has it now. The hold sentence is deliberately
 * identical for a read that came in too high and one that came in too low,
 * because anything that distinguishes them is the previous read, a guess at a
 * time.
 */

/** A fragment from the server, capitalized to start its own sentence. */
export function sentence(note: string): string {
  const t = note.trim()
  if (!t) return ''
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.')
}

/** The whole line for one reading, from the route's answer. */
export function readToast(res: any): string {
  const note: string | undefined = res?.data?.billingNote
  if (res?.data?.billed) return 'Read recorded — final bill created'
  return note ? `Reading recorded. ${sentence(note)}` : 'Reading recorded'
}
