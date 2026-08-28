/**
 * Tool: submit_renewal_intent (tenant ACTION, confirm-first). S626.
 *
 * NOT the anonymous property survey. This is the per-lease renewal questionnaire
 * — it is attached to one lease, it carries the tenant's name, and it exists
 * because both sides need to give each other legal notice on a clock.
 *
 * The gap it closes is the serious one. request_lease_renewal files a renewal
 * REQUEST and never touches leases.tenant_renewal_intent, so nothing the agent
 * could do recorded the formal answer — and a tenant saying "no, I'm moving out"
 * had no path at all. Per S562 a "no" here is BINDING WRITTEN NOTICE of
 * non-renewal: auto-renew is retired system-wide, so the lease WILL end on its
 * end date. A tenant who told the assistant they were leaving, and had that go
 * nowhere, would have given no notice at all while believing they had.
 *
 * Mirrors POST /api/leases/:id/renewal-intent exactly — same three values, same
 * active-lease requirement, same renewal-request creation on "yes" with no
 * duplicate, same landlord notification with the binding framing on "no".
 */
import { query, queryOne } from '../../../db'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

export const submitRenewalIntent: AgentTool = {
  name: 'submit_renewal_intent',
  description:
    'Record whether the tenant intends to renew their lease: "yes", "no", or "unsure". This is the ' +
    'formal answer on their lease — it is NOT anonymous, their landlord sees their name, and it is ' +
    'how the two sides give each other notice before the lease ends.\\n' +
    'SAYING "no" IS WRITTEN NOTICE THAT THEY ARE LEAVING. The lease ends on its end date and nothing ' +
    'renews automatically. Say that back to them in plain words and get an explicit yes before you ' +
    'call this with "no" — a tenant who thinks they are expressing a preference has just given notice.\\n' +
    '"unsure" is a real answer and is better than silence: it tells the landlord to start the ' +
    'conversation. Use it when they genuinely have not decided rather than pushing them to commit.\\n' +
    'Use this when they say anything about staying or going near the end of their lease. If they only ' +
    'want to ASK about renewing — what the rent would be, whether the landlord usually renews — that ' +
    'is get_my_lease and get_my_landlord_renewal_tendency, not this.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'Exactly one of: yes, no, unsure.' },
      notes: { type: 'string', description: 'Anything they want their landlord to know alongside it, in their words.' },
    },
    required: ['intent'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const intent = String(args.intent ?? '').trim().toLowerCase()
    if (!['yes', 'no', 'unsure'].includes(intent)) {
      return { ok: false, error: 'intent must be exactly "yes", "no" or "unsure".' }
    }
    const notes = args.notes != null ? String(args.notes).trim().slice(0, 2000) : null

    // WHO and WHICH LEASE come from the signed-in tenant, never the model.
    const lease = await queryOne<any>(
      `SELECT l.id, l.status, l.end_date, l.landlord_renewal_offered_at,
              l.tenant_renewal_intent AS existing_intent,
              lt.tenant_id, l.landlord_id,
              u.unit_number, p.name AS property_name,
              tu.id AS tenant_user_id
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
         JOIN tenants tt ON tt.id = lt.tenant_id
         JOIN users tu  ON tu.id = tt.user_id
         JOIN units u      ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE lt.tenant_id = $1 AND l.status = 'active'
        ORDER BY l.end_date NULLS LAST LIMIT 1`,
      [actor.profileId])
    if (!lease) {
      return { ok: false, error: 'No active lease on record, so there is nothing to answer about. Do NOT tell them it was recorded.' }
    }

    await query(
      `UPDATE leases SET tenant_renewal_intent=$1, tenant_renewal_intent_at=NOW(),
                         tenant_renewal_notes=$2, updated_at=NOW() WHERE id=$3`,
      [intent, notes, lease.id])

    // "Yes" opens the landlord's renewal workflow. Never a second open one.
    if (intent === 'yes') {
      const open = await queryOne<any>(
        `SELECT id FROM lease_renewal_requests WHERE lease_id=$1 AND status IN ('requested','approved')`,
        [lease.id])
      if (!open) {
        await query(
          `INSERT INTO lease_renewal_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, notes, status)
           VALUES ($1,$2,$3,$4,$5,'requested')`,
          [lease.id, lease.tenant_id, lease.landlord_id, lease.tenant_user_id, notes])
      }
    }

    const landlord = await queryOne<any>(
      `SELECT u.id AS user_id, u.email FROM landlords la JOIN users u ON u.id = la.user_id WHERE la.id=$1`,
      [lease.landlord_id])
    if (landlord) {
      const label = intent === 'yes'
        ? 'plans to renew'
        : intent === 'no'
          ? 'has given written notice they will NOT renew — the lease ends on its end date'
          : 'is unsure about renewing'
      try {
        await createNotification({
          userId: landlord.user_id,
          landlordId: lease.landlord_id,
          type: 'tenant_renewal_intent',
          title: intent === 'no' ? `Non-Renewal Notice — Unit ${lease.unit_number}` : `Renewal response — Unit ${lease.unit_number}`,
          body: `Your tenant at ${lease.property_name} (Unit ${lease.unit_number}) ${label}.${notes ? ` Note: "${notes}"` : ''}`,
          data: { leaseId: lease.id, intent },
          actionUrl: '/leases',
          sendEmail: true,
          emailTo: landlord.email,
          emailSubject: `Tenant renewal response — Unit ${lease.unit_number}`,
        })
      } catch { /* the intent is recorded above; a failed email must not lose it */ }
    }

    return {
      ok: true,
      recorded: true,
      intent,
      leaseEndDate: lease.end_date,
      // The landlord has not necessarily offered terms yet, and the tenant
      // should know which of them the ball is with.
      landlordHasOfferedTerms: !!lease.landlord_renewal_offered_at,
      changedFrom: lease.existing_intent && lease.existing_intent !== intent ? lease.existing_intent : undefined,
      note:
        intent === 'no'
          ? `Recorded as written notice of non-renewal. Tell them plainly: their landlord has been notified, and the lease ends on ${lease.end_date ?? 'its end date'} — nothing renews on its own.`
          : intent === 'yes'
            ? (lease.landlord_renewal_offered_at
                ? 'Recorded, and their landlord has already offered renewal terms — point them at the lease for the figures.'
                : 'Recorded and sent to their landlord, who sets the renewal terms. Do NOT quote a rent for the new term; that is theirs to offer.')
            : 'Recorded as undecided and sent to their landlord. Tell them they can change it any time before the lease ends.',
    }
  },
}
