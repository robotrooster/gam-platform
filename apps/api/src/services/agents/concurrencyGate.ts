/**
 * S628 — A QUEUE, NOT A CRASH.
 *
 * Nic: "I was under the impression that too many people trying to have
 * conversations with the agent at the same time would just slow them all down,
 * not crash the computer. It should queue things up... that may also help with
 * the feeling of being a reality where it's like, hey, a GAM representative
 * will be with you soon, they're assisting other people."
 *
 * He was describing how it ought to work, and it did not. Every conversation
 * that arrives allocates a KV cache on the GPU, and when the allocation fails
 * mlx_lm does not queue or degrade — it raises
 *
 *   [METAL] Command buffer execution failed: Insufficient Memory
 *
 * out of a C++ destructor, aborts the whole server, and launchd restarts it.
 * Every conversation in flight dies mid-sentence, and what the person sees is
 * "I'm having trouble pulling that up." It happened four times in an hour on
 * 2026-08-28.
 *
 * The arithmetic, measured that day on a 96 GB machine:
 *
 *   model resident                     27.7 GB
 *   GPU wired limit (Apple default)   ~72   GB
 *   usable for conversation caches     44.3 GB
 *   per conversation, before S628      18.05 GB  → 2 at once
 *   per conversation, after S628        4.23 GB  → about 10 at once
 *
 * RE-MEASURED under two-pass, which is what actually ships — a second
 * generation per turn against a longer message array, so the first figure could
 * not simply be assumed to hold. Over 40 samples: median 3.45 GB, p90 4.35 GB,
 * worst 4.51 GB. Nine fit at the worst case, so the limit below is not the
 * ceiling — it is the ceiling with room left for WindowServer and the desktop
 * app, both of which draw on the same unified memory and were live
 * contributors to the aborts.
 *
 * So the gate holds a modest number of conversations in flight and makes the
 * rest WAIT rather than pushing the box past the wired limit. Waiting is a
 * product state and a truthful one — somebody is genuinely ahead of you — and
 * it is the difference between an agent that feels busy and an agent that dies.
 *
 * Deliberately NOT a hard rejection. A tenant told "try again later" is a
 * tenant who does not pay their rent tonight.
 */
import { logger } from '../../lib/logger'

/**
 * How many generations may be in flight at once.
 *
 * Sized from the measurement above with real headroom: ~10 fit, 6 leaves room
 * for the desktop app and WindowServer, which also draw on the same unified
 * memory and were live contributors to the aborts.
 */
const DEFAULT_LIMIT = 6

function limit(): number {
  const n = Number(process.env.AGENT_MAX_CONCURRENT)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT
}

let active = 0
interface Waiter { release: () => void; key?: string }
const waiting: Waiter[] = []

export interface GateStats {
  active: number
  waiting: number
  limit: number
}

export function gateStats(): GateStats {
  return { active, waiting: waiting.length, limit: limit() }
}

/**
 * Where a particular conversation sits in the queue right now, 1-based, or 0
 * if it is not waiting (running, or finished).
 *
 * S651: the queue has worked since S628, and nobody waiting in it was ever
 * told. The reply arrives late with a typing indicator that has been going for
 * ninety seconds and no explanation, which reads as a broken page rather than
 * as somebody being busy. This is what a status poll reads to say something
 * true instead.
 *
 * Positions shift as people ahead finish, so this is deliberately computed on
 * each call rather than handed out once at enqueue time — a number that said
 * "3 ahead of you" for two minutes after they had gone would be worse than
 * saying nothing.
 */
export function queuePositionOf(key: string): number {
  const i = waiting.findIndex(w => w.key === key)
  return i < 0 ? 0 : i + 1
}

/**
 * How long somebody has been told they will wait, in words a person can use.
 *
 * Returned so the caller can say something true while they hold — "a GAM
 * representative will be with you shortly" is only worth saying if it is.
 */
export function queuePositionMessage(position: number): string | null {
  if (position <= 0) return null
  if (position <= 2) return 'One moment — just finishing up with someone else.'
  return 'Thanks for your patience — a couple of people are ahead of you. I will be right with you.'
}

/**
 * Run `fn` when there is room. Everything else waits its turn.
 *
 * FIFO, so nobody is starved by a busy period, and the release runs in a
 * `finally` so a thrown generation frees its slot rather than wedging the queue
 * shut — which would turn one bad turn into an outage for everybody.
 */
export async function withConcurrencySlot<T>(
  fn: () => Promise<T>,
  onQueued?: (position: number) => void,
  key?: string,
): Promise<T> {
  const max = limit()
  if (active >= max) {
    const position = waiting.length + 1
    onQueued?.(position)
    logger.info({ active, waiting: waiting.length, limit: max, key },
      'agent: conversation queued — at capacity')
    await new Promise<void>((resolve) => waiting.push({ release: resolve, key }))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiting.shift()
    if (next) next.release()
  }
}

/** Test seam — the module holds process-wide state by design. */
export function __resetGate(): void {
  active = 0
  waiting.length = 0
}
