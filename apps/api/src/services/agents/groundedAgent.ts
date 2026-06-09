/**
 * Agent engine — grounded answering (Step 3.5).
 *
 * Connects the knowledge layer (Step 3) to the engine (Step 1): given a
 * user message and a profile, retrieve the most relevant chunks WITHIN
 * the profile's knowledge scopes, format them as an authoritative
 * context block, and have the engine answer from THAT — not from the
 * model's invention. This is where the handoff's #1 guardrail ("facts
 * come from tools/retrieval, never invented") becomes operational.
 *
 * When nothing relevant is retrieved, the model is explicitly told so
 * and instructed not to guess — it should say it will check / escalate
 * per its profile rules. The retrieved chunks (and whether anything
 * cleared the relevance floor) are returned too, so later steps can use
 * "low retrieval confidence" as an escalation signal.
 */

import { runAgent } from './engine'
import { retrieve, type RetrievedChunk } from './knowledge'
import type { AgentProfile, ChatMessage, RunAgentResult } from './types'

export interface GroundedAnswerInput {
  profile: AgentProfile
  message: string
  history?: ChatMessage[]
  /** how many chunks to retrieve before filtering. Default 5. */
  k?: number
  /** drop chunks below this cosine similarity as noise. Default 0.3. */
  minSimilarity?: number
}

export interface GroundedAnswerResult extends RunAgentResult {
  /** chunks that cleared the relevance floor and were given to the model */
  retrieved: RetrievedChunk[]
  /** true when at least one chunk was retrieved; false => model was told
   *  it has no knowledge (a low-confidence / escalation signal) */
  grounded: boolean
}

/** Format retrieved chunks (or their absence) into the system context block. */
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return (
      'GAM KNOWLEDGE: no relevant knowledge article was found for this question. ' +
      'Do NOT invent facts. You may still act using your available tools when one ' +
      'applies — and if the situation calls for escalation, CALL your escalation ' +
      'tool (do not merely say you will escalate).'
    )
  }
  const facts = chunks
    .map((c, i) => `[${i + 1}]${c.title ? ` (${c.title})` : ''} ${c.content}`)
    .join('\n')
  return (
    'GAM KNOWLEDGE — answer using ONLY the facts below. Treat them as the ' +
    'source of truth. If they do not cover what the user needs, do not ' +
    'guess — say you will check, and escalate per your rules.\n\n' +
    facts
  )
}

export async function groundedAnswer(
  input: GroundedAnswerInput
): Promise<GroundedAnswerResult> {
  const { profile, message, history, k = 5, minSimilarity = 0.3 } = input

  const all = await retrieve(profile.knowledgeScopes, message, k)
  const retrieved = all.filter((c) => c.similarity >= minSimilarity)

  const result = await runAgent({
    profile,
    message,
    history,
    contextBlock: buildContextBlock(retrieved),
  })

  return { ...result, retrieved, grounded: retrieved.length > 0 }
}
