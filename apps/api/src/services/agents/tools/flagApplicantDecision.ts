/**
 * Tool: flag_applicant_decision (landlord ACTION — record-intent only).
 *
 * The landlord's approve/decline of an applicant is recorded against a
 * SCREENING CHECK, not the lightweight unit_applications lead (that table
 * has no decision lifecycle). The real decision route is
 * PATCH /api/background/:id/decision, which — on a decline — auto-sends
 * the FCRA §615(a) adverse-action notice and carries fair-housing
 * exposure.
 *
 * Per Nic (2026-06-17): the agent must NOT execute that decision. This
 * tool is record-intent-only — it resolves the landlord's matching check
 * (scoped to actor.profileId), confirms it is in a decidable state, then
 * captures the landlord's stated intent as a durable notification and
 * routes them to the Screening page to record the OFFICIAL decision
 * themselves. It never writes to background_checks and never fires the
 * adverse-action notice. The id comes from get_background_check_status.
 */

import { query, queryOne } from '../../../db'
import { createNotification } from '../../notifications'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

// Mirrors the decidable-state gate in routes/background.ts (PATCH
// /:id/decision, ~L481). A check that is pending fraud-screening,
// failed, cancelled, or expired cannot be decided yet — so there is
// nothing to flag. Kept in parity with that route; if the route's
// allowed set changes, update both (single-source extraction is a
// minor future follow-up).
const DECIDABLE_STATUSES = ['complete', 'submitted', 'processing'] as const

interface CheckRow {
  id: string
  first_name: string | null
  last_name: string | null
  status: string
  created_at: string
}

function normalizeDecision(raw: string): 'approve' | 'decline' | null {
  const v = raw.trim().toLowerCase()
  if (['approve', 'approved', 'accept', 'accepted'].includes(v)) return 'approve'
  if (['decline', 'declined', 'deny', 'denied', 'reject', 'rejected'].includes(v)) return 'decline'
  return null
}

function fullName(r: CheckRow): string {
  return `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '(unnamed applicant)'
}

export const flagApplicantDecision: AgentTool = {
  name: 'flag_applicant_decision',
  description:
    'Record the landlord’s intent to APPROVE or DECLINE an applicant and tee it up for them to finalize — ' +
    'use when the landlord says something like "approve Jane Doe" or "decline the applicant for unit 4". ' +
    'You do NOT make the decision yourself: the official approve/decline (and, on a decline, the required ' +
    'applicant notice) is the landlord’s to record on the Screening page. This tool flags their intent, ' +
    'logs it, and points them there. Get the applicant from get_background_check_status first. Confirm the ' +
    'applicant and which way they want to go before calling.',
  parameters: {
    type: 'object',
    properties: {
      applicant: { type: 'string', description: 'The applicant’s name (from get_background_check_status). Used to find their screening check.' },
      checkId: { type: 'string', description: 'The screening-check id, if you already have it. Preferred over name when known.' },
      decision: { type: 'string', description: 'Which way the landlord wants to go: "approve" or "decline".' },
      notes: { type: 'string', description: 'Optional note from the landlord about the decision (kept with the flag).' },
    },
    required: ['decision'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const decision = normalizeDecision(String(args.decision ?? ''))
    if (!decision) return { ok: false, error: 'Tell me whether the landlord wants to approve or decline the applicant.' }

    const checkId = String(args.checkId ?? '').trim()
    const applicant = String(args.applicant ?? '').trim()
    if (!checkId && !applicant) return { ok: false, error: 'I need the applicant’s name (or the screening-check id) to flag this.' }

    // Resolve the check, hard-scoped to THIS landlord.
    let matches: CheckRow[]
    if (checkId) {
      const row = await queryOne<CheckRow>(
        `SELECT id, first_name, last_name, status, created_at
           FROM background_checks WHERE id = $1 AND landlord_id = $2`,
        [checkId, actor.profileId]
      )
      matches = row ? [row] : []
    } else {
      matches = await query<CheckRow>(
        `SELECT id, first_name, last_name, status, created_at
           FROM background_checks
          WHERE landlord_id = $1
            AND lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) LIKE '%' || lower($2) || '%'
          ORDER BY created_at DESC LIMIT 5`,
        [actor.profileId, applicant]
      )
    }

    if (matches.length === 0) {
      return {
        ok: false,
        error: `No screening check on file for ${applicant || 'that applicant'} under your account. The approve/decline ` +
          `decision in GAM is recorded against a screening check — if you haven’t ordered one yet, that comes first. ` +
          `You can review applicants on the Screening page.`,
        portalPath: '/screening',
      }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        needsDisambiguation: true,
        message: `More than one screening check matches "${applicant}". Which one?`,
        candidates: matches.map((m) => ({ checkId: m.id, applicant: fullName(m), status: m.status, orderedAt: m.created_at })),
      }
    }

    const check = matches[0]
    if (!(DECIDABLE_STATUSES as readonly string[]).includes(check.status)) {
      return {
        ok: false,
        error: `${fullName(check)}'s screening check is "${check.status}", which can’t be decided yet. A decision can be ` +
          `recorded once the check is back (complete) — or while it’s still processing/submitted. Pending fraud-screening, ` +
          `failed, cancelled, or expired checks have to resolve first.`,
      }
    }

    const name = fullName(check)
    const notes = String(args.notes ?? '').trim() || undefined
    const declineRider = decision === 'decline' ? ' and send the required applicant notice' : ''

    // Durable, append-only record of the intent (data-capture posture).
    // In-app only — the landlord is live in chat, so the agent relays the
    // link inline; this row is the record + a feed entry to finalize.
    try {
      await createNotification({
        userId: actor.userId,
        landlordId: actor.profileId,
        type: 'applicant_decision',
        title: 'Applicant decision to finalize',
        body: `You asked me to ${decision} ${name}’s application. I’ve flagged it for you — open the Screening page to ` +
          `record the official decision${declineRider}.${notes ? ` Note: ${notes}` : ''}`,
        data: { checkId: check.id, applicant: name, decision, notes, source: 'agent' },
      })
    } catch (e) {
      logger.error({ err: e }, '[agent] flag applicant decision notify')
    }

    return {
      ok: true,
      recorded: true,
      applicant: name,
      decision,
      portalPath: '/screening',
      message:
        `Flagged your intent to ${decision} ${name} and saved it to your notifications. I can’t record the official ` +
        `decision myself — the actual ${decision === 'decline' ? 'decline (which also sends the legally required applicant notice)' : 'approval'} ` +
        `is recorded by you on the Screening page. Want me to walk you to it?`,
    }
  },
}
