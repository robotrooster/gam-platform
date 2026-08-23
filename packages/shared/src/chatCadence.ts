/**
 * How long an agent takes to read a message and type a reply.
 *
 * S617 (Nic): "it was still showing reply bubble text box one second after the
 * message was sent. No matter how long it was, the agent was trying to reply
 * immediately, and a real person can never read that fast and comprehend that
 * fast."
 *
 * He was right, and the cause was the CAPS rather than the missing beats — all
 * four chat surfaces already paced themselves, but the read beat topped out at
 * 4.5s and the typing beat at 9s. Past those, every message is the same length
 * as far as the pacing is concerned. Measured against the old numbers:
 *
 *     150 chars →  4.5s read  =   400 wpm
 *     400 chars →  4.5s read  = 1,067 wpm
 *   1,600 chars →  4.5s read  = 4,267 wpm
 *
 * Nobody reads like that, and the tell is worse the more the agent has to say —
 * exactly the messages where a person would visibly pause.
 *
 * The rates below sit in a human band (roughly 180-260 wpm reading, and typing
 * fast but not impossibly so) with ceilings high enough that length is still
 * felt at the long end. The ceilings do still exist: past a point a real wait
 * stops reading as thoughtful and starts reading as broken.
 *
 * Note what a ceiling necessarily costs. READ_CAP_MS binds at about 260
 * characters, and above that the implied reading speed climbs again — a very
 * long message is still "skimmed". That is a deliberate trade, not an
 * oversight: the alternative is a genuinely proportional wait, which for a
 * 1,600-character message is over a minute of staring at a typing indicator.
 * The tests assert the human band below the knee, and monotonicity above it.
 *
 * ONE definition, because this used to live in four copies — landlord, tenant,
 * storefront and marketing — and a tuning pass would have had to find all four.
 * apps/marketing is a static index.html with no bundler, so it cannot import
 * this; its copy carries a pointer back here and MUST be changed with it.
 */

/** Milliseconds the agent spends "reading" an incoming message of `len` chars. */
export function readBeatMs(len: number): number {
  return Math.min(13_000, 1_300 + len * 45)
}

/** Beat between the read receipt landing and the typing indicator starting. */
export const PAUSE_BEFORE_TYPING_MS = 900

/** Milliseconds the agent spends "typing" a reply bubble of `len` chars. */
export function typeBeatMs(len: number): number {
  return Math.min(18_000, Math.max(2_200, len * 70))
}

/**
 * Pause after a bubble lands before the next one starts typing — time for the
 * person to read what just arrived, so a long bubble is not followed instantly
 * by another.
 */
export function readGapMs(len: number): number {
  return Math.min(8_000, Math.max(1_900, len * 30))
}

// ── The pause before the message is even NOTICED ──────────────────────────
//
// S617 (Nic): "I wanna have a delay in the actual having the message be seen...
// Just randomly ten to twenty seconds somewhere in between there where it shows
// as sent. And then after that initial time, I wanted to pop on with a
// notification, oh, that message has been seen. From that time, I wanna start
// the length of the read time and then generating the response. Because the
// instant seen and replying is the suspicious part. Everybody knows that no
// agents are just gonna be sitting there at the ready at the computer screen
// waiting for somebody to message."
//
// So the full sequence is now: Sent → (nobody has looked yet) → Seen → (now
// they are reading it, sized by length) → typing → the reply. The read beat
// above was always meant to be the READING; it was doing double duty as the
// noticing, which is why an instant "Seen" was the tell.
//
// ENGAGED vs IDLE. A person who has just replied to you IS at the screen — the
// second message in a live back-and-forth does not sit unseen for fifteen
// seconds, and pretending it does would be its own tell, on top of making every
// exchange unusable. So the full delay applies when the agent has not been
// heard from recently (the first message, or after the conversation has gone
// quiet); once they are engaged, they notice quickly. ENGAGED_WINDOW_MS is how
// long "recently" lasts.

export const NOTICE_MIN_MS = 10_000
export const NOTICE_MAX_MS = 20_000

/**
 * While the agent is already in the conversation.
 *
 * S617: started at 1.2-4s and Nic raised it to 3-7s — being in a conversation
 * is not the same as staring at it. "They could have been on a different tab or
 * whatever. Who knows?" Even someone right there has to come back to the
 * window, and a sub-second-feeling receipt reads as a machine registering the
 * message rather than a person glancing at it. Deliberately erring slow:
 * "we can always speed it up later on."
 */
export const NOTICE_ENGAGED_MIN_MS = 3_000
export const NOTICE_ENGAGED_MAX_MS = 7_000

/** How long after their last reply the agent still counts as at the screen. */
export const ENGAGED_WINDOW_MS = 90_000

/**
 * Milliseconds before the "Seen" receipt appears.
 *
 * @param msSinceAgentLastSpoke  null when the agent has not replied yet.
 * @param rand                   injectable for tests; defaults to Math.random.
 */
export function noticeDelayMs(
  msSinceAgentLastSpoke: number | null,
  rand: () => number = Math.random,
): number {
  const engaged =
    msSinceAgentLastSpoke !== null && msSinceAgentLastSpoke < ENGAGED_WINDOW_MS
  const [lo, hi] = engaged
    ? [NOTICE_ENGAGED_MIN_MS, NOTICE_ENGAGED_MAX_MS]
    : [NOTICE_MIN_MS, NOTICE_MAX_MS]
  return Math.round(lo + rand() * (hi - lo))
}
