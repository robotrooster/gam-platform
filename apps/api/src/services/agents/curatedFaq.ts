/**
 * Curated FAQ fast-path (Nic-approved).
 *
 * Hand-written, approved answers to the highest-volume GENERAL questions
 * (rent due, how to pay, late fees, payouts…). When a user's question
 * matches a curated entry with high confidence, we serve the approved
 * answer INSTANTLY — no model call, no gate slot — which both controls the
 * exact wording on the busiest traffic and removes that load from the model
 * fleet on the 1st-of-month crest.
 *
 * Matching is semantic: the user's question is embedded (cached) and
 * compared (cosine, via dot product on the L2-normalized bge vectors) to
 * each curated question's embedding. A HIGH threshold (default 0.85) means
 * only a clear match is served — anything ambiguous falls through to the
 * full grounded model path, so we never answer a different question with a
 * canned reply.
 *
 * Entries cover only GENERAL, non-personalized questions (the answer is the
 * same for everyone). Anything needing the user's own data ("what is MY
 * rent") won't match closely and goes to the tools path. Copy is reviewed by
 * Nic — same posture as the knowledge-base content; edit freely here.
 */

import { embed } from './embeddings'
import { normalizeQuestion } from './cache'
import type { AgentAudience } from './types'

interface FaqEntry {
  /** which audience this answer is for ('shared' = both) */
  audience: AgentAudience | 'shared'
  /** the canonical phrasing of the question (what we embed + match against) */
  question: string
  /** the approved answer, in a warm, human voice */
  answer: string
}

export const CURATED_FAQ: FaqEntry[] = [
  {
    audience: 'tenant',
    question: 'When is my rent due?',
    answer:
      "Your rent due date is set by your landlord in your lease — you can see the exact date, " +
      'plus any grace period, in your portal under Documents. If you let me know what you need, ' +
      'I can help you find it.',
  },
  {
    audience: 'tenant',
    question: 'How do I pay my rent?',
    answer:
      'You can pay your rent right in your portal, either from a bank account (ACH) or by card — ' +
      "everything's handled electronically here, so there's no cash or check option. A small " +
      'processing fee may apply depending on how you pay, and you’ll always see the total before you confirm.',
  },
  {
    audience: 'tenant',
    question: 'What is the late fee if I pay rent late?',
    answer:
      'Late fees and any grace period are set by your landlord in your lease, so the exact amount ' +
      'and timing depend on your agreement — you can find those details in your lease under ' +
      'Documents. Happy to help you locate it.',
  },
  {
    audience: 'tenant',
    question: 'How do I file a maintenance request?',
    answer:
      'For anything in your home that needs attention — a repair, an appliance, plumbing, heat or ' +
      'cooling, a lock — you can file a maintenance request in your portal and it goes straight to ' +
      'your landlord. Just describe what’s wrong and where, and they’ll take it from there. Want me to help you start one?',
  },
  {
    audience: 'tenant',
    question: 'Where can I find my lease?',
    answer:
      'Your lease lives in your portal under Documents, where you can read or download it any time. ' +
      'Let me know if you’re having trouble finding it.',
  },
  {
    audience: 'landlord',
    question: 'When do I get paid and how do payouts work?',
    answer:
      'Your payouts are sent to your connected bank account on a regular schedule once your tenants’ ' +
      'payments clear. You can review your payouts in your portal — let me know if you’d like a hand finding them.',
  },
  {
    audience: 'landlord',
    question: 'What does GAM charge me?',
    answer:
      'The platform fee is a small per-occupied-unit monthly charge, with a per-property minimum — ' +
      'vacant units aren’t charged. I can walk you through how it applies to your portfolio if you’d like.',
  },
]

const MATCH_THRESHOLD = Number(process.env.AGENT_FAQ_THRESHOLD) || 0.85

let embedded: Array<{ entry: FaqEntry; vec: number[] }> | null = null

async function ensureEmbedded(): Promise<Array<{ entry: FaqEntry; vec: number[] }>> {
  if (embedded) return embedded
  const vecs = await Promise.all(CURATED_FAQ.map((e) => embed(e.question)))
  embedded = CURATED_FAQ.map((entry, i) => ({ entry, vec: vecs[i] }))
  return embedded
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Return the curated answer for `question` if it matches an entry for
 * `audience` (or 'shared') above the confidence threshold; else null.
 */
export async function matchCuratedFaq(audience: AgentAudience, question: string): Promise<string | null> {
  if (CURATED_FAQ.length === 0) return null
  const entries = await ensureEmbedded()
  const qvec = await embed(normalizeQuestion(question)) // cached
  let best: { answer: string; sim: number } | null = null
  for (const { entry, vec } of entries) {
    if (entry.audience !== audience && entry.audience !== 'shared') continue
    const sim = dot(qvec, vec)
    if (sim >= MATCH_THRESHOLD && (!best || sim > best.sim)) best = { answer: entry.answer, sim }
  }
  return best?.answer ?? null
}

/** Test seam — drop the memoized FAQ embeddings. */
export function __resetFaqForTest(): void {
  embedded = null
}
