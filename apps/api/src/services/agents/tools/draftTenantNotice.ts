/**
 * Tool: draft_tenant_notice (landlord ACTION — draft-with-approval).
 *
 * A formal one-way notice from the landlord to one of their OWN tenants
 * (rent increase, lease violation, entry notice, general notice, etc.).
 * The agent DRAFTS the wording; the landlord must APPROVE it before it
 * goes out — so this is two-phase, mirroring send_bulk_message:
 *
 *   Phase 1 (no `confirmed`): resolve the tenant (scoped to the landlord),
 *     echo the rendered draft back for the landlord to approve. NOTHING
 *     is sent.
 *   Phase 2 (`confirmed: true`): deliver the notice to the tenant as a
 *     notification (GAM's real tenant channel — same as message_tenant)
 *     and return. The notification row is the durable, append-only record.
 *
 * It is INFORMATIONAL only: it delivers text. It does NOT change the lease,
 * rent, or any GAM record, and must never be used to accept/handle a
 * notice-to-vacate or to alter lease terms (those are excluded from the
 * agent entirely — see AGENT_REVENUE_CAPABILITIES note in shared). Not
 * revenue-affecting, so not gated by property_agent_permissions.
 */

import { query } from '../../../db'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

interface TenantMatch { user_id: string; first_name: string | null; last_name: string | null; email: string | null }

const DEFAULT_SUBJECT = 'Notice from your landlord'

export const draftTenantNotice: AgentTool = {
  name: 'draft_tenant_notice',
  description:
    'Draft a formal one-way notice to one of the landlord’s own tenants (e.g. a rent-increase notice, ' +
    'lease-violation notice, entry notice, or general notice) and send it ONLY after the landlord approves. ' +
    'Use when the landlord asks you to "send a notice to…", "draft a rent-increase notice", "notify my tenant ' +
    'that…", etc. YOU compose the notice wording from what the landlord wants. Call it FIRST without ' +
    '`confirmed` to show the landlord the draft — nothing is sent. Show them the exact draft, get their ' +
    'explicit yes, THEN call again with `confirmed: true` to deliver it. The tenant receives it as a ' +
    'notification in their account. This only delivers text — it never changes the lease, rent, or any ' +
    'record, and must never be used to change lease terms or to handle a notice to vacate.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or email.' },
      subject: { type: 'string', description: 'Short title/kind of the notice, e.g. "Rent Increase", "Lease Violation", "Entry Notice". Defaults to a generic notice title.' },
      notice: { type: 'string', description: 'The full notice body you drafted, in formal but plain language.' },
      confirmed: { type: 'boolean', description: 'Leave false/absent to return the draft for the landlord to approve. Set true ONLY after the landlord has approved the exact wording.' },
    },
    required: ['tenant', 'notice'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = String(args.tenant ?? '').trim()
    const body = String(args.notice ?? '').trim()
    const subject = String(args.subject ?? '').trim() || DEFAULT_SUBJECT
    const confirmed = args.confirmed === true
    if (needle.length < 2) return { ok: false, error: 'Provide at least part of the tenant’s name or email.' }
    if (body.length < 2) return { ok: false, error: 'A notice body is required.' }

    // Tenants on THIS landlord's leases matching the name/email (same scope
    // as message_tenant — a landlord can only notice their own tenants).
    const matches = await query<TenantMatch>(
      `SELECT DISTINCT t.user_id, us.first_name, us.last_name, us.email
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE us.email ILIKE $2 OR (COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) ILIKE $2`,
      [actor.profileId, `%${needle}%`]
    )
    if (matches.length === 0) return { ok: false, error: `No tenant on your leases matches “${needle}”.` }
    if (matches.length > 1) {
      return {
        ok: false,
        needsDisambiguation: true,
        message: 'More than one of your tenants matches. Ask which one (by full name or email).',
        matches: matches.map((m) => ({ name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(), email: m.email })),
      }
    }

    const m = matches[0]
    const tenantName = `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim()

    // Phase 1: draft for approval — DO NOT send.
    if (!confirmed) {
      return {
        ok: true,
        needsApproval: true,
        draft: { to: tenantName, subject, body },
        message: `Here’s the draft notice for ${tenantName}. Read it back to the landlord and get their explicit approval — only then send it (call again with confirmed: true). Nothing has been sent yet.`,
      }
    }

    // Phase 2: approved — deliver to the tenant. The notification row is the
    // durable record (data carries the notice subject + that it was an
    // approved landlord notice).
    await createNotification({
      userId: m.user_id,
      landlordId: actor.profileId,
      type: 'landlord_notice',
      title: subject,
      body,
      data: { kind: 'landlord_notice', subject, source: 'agent' },
    })
    return { ok: true, sent: true, sentTo: tenantName, subject, message: `Notice “${subject}” delivered to ${tenantName}.` }
  },
}
