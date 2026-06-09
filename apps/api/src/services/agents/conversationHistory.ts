/**
 * Server-side conversation history (Step: scale P5).
 *
 * Reconstructs the recent turns of a conversation from agent_interaction_logs
 * so the SERVER — not the client — is the source of truth for history. This
 * (a) bounds prompt size to a fixed recent-N window regardless of how long
 * the conversation runs, and (b) closes a trust hole: a client can no longer
 * inject or forge prior turns. The lookup is OWNERSHIP-CHECKED — it only
 * returns turns for a conversation belonging to the requesting user.
 *
 * Note: turn logging is fire-and-forget, so in a rapid back-to-back exchange
 * the very latest turn may occasionally not be persisted yet — an acceptable,
 * rare one-turn context gap (never a correctness or security issue).
 */

import { query } from '../../db'
import type { ChatMessage } from './types'

function historyTurns(): number {
  const n = Number(process.env.AGENT_HISTORY_TURNS)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 6
}

/**
 * Load the last N turns of `conversationId` for `actorUserId`, oldest first,
 * as alternating user/assistant messages. Returns [] for an unknown or
 * not-owned conversation (the actor filter is the ownership guard).
 */
export async function loadConversationHistory(
  conversationId: string,
  actorUserId: string,
  limit = historyTurns()
): Promise<ChatMessage[]> {
  const rows = await query<{ user_message: string; agent_reply: string }>(
    `SELECT user_message, agent_reply
       FROM agent_interaction_logs
      WHERE conversation_id = $1 AND actor_user_id = $2
      ORDER BY turn_index DESC
      LIMIT $3`,
    [conversationId, actorUserId, limit]
  )

  const history: ChatMessage[] = []
  // rows are newest-first; walk oldest-first to build the transcript order
  for (const r of rows.reverse()) {
    history.push({ role: 'user', content: r.user_message })
    if (r.agent_reply) history.push({ role: 'assistant', content: r.agent_reply })
  }
  return history
}

function userContextItems(): number {
  const n = Number(process.env.AGENT_USER_CONTEXT_ITEMS)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 5
}

/**
 * Cross-session memory: a compact note of what this user recently contacted
 * support about, ACROSS prior conversations (excluding the current one), so
 * the agent feels like a rep who remembers them rather than a stranger each
 * time. Ownership-scoped to actorUserId. Returns null if no prior history.
 * Intentionally lightweight (recent gist, not full transcripts).
 */
export async function loadUserContext(
  actorUserId: string,
  currentConversationId?: string,
  limit = userContextItems()
): Promise<string | null> {
  const rows = await query<{ user_message: string; outcome: string; created_at: string }>(
    `SELECT user_message, outcome, created_at
       FROM agent_interaction_logs
      WHERE actor_user_id = $1 ${currentConversationId ? 'AND conversation_id <> $3' : ''}
      ORDER BY created_at DESC
      LIMIT $2`,
    currentConversationId ? [actorUserId, limit, currentConversationId] : [actorUserId, limit]
  )
  if (rows.length === 0) return null
  const lines = rows.map((r) => {
    const day = String(r.created_at).slice(0, 10)
    const msg = r.user_message.replace(/\s+/g, ' ').slice(0, 90)
    return `- ${day}: "${msg}" (${r.outcome})`
  })
  return (
    'RETURNING CUSTOMER — recent things this person has contacted support about (most recent ' +
    'first). Use this for continuity so they don\'t repeat themselves; do NOT bring these up ' +
    'unless relevant to what they\'re asking now:\n' +
    lines.join('\n')
  )
}
