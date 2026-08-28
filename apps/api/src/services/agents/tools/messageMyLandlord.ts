/**
 * Tool: message_my_landlord (tenant ACTION, confirm-first). S626.
 *
 * Nic's example, verbatim: "send a landlord a message saying, hey, I wanna
 * upgrade to a three bedroom apartment when you have one available."
 *
 * The landlord has had message_tenant since S552. The tenant had no way back —
 * everything they could send was a structured thing (maintenance, a complaint, a
 * renewal request), and a plain request to a human fitted none of them. A tenant
 * asking for a bigger unit was either mis-filed as a complaint or told to
 * contact their landlord some other way, which is precisely the "go and find it
 * yourself" the assistant exists to remove.
 *
 * SCOPED HARD, because a free-text channel is the easiest thing on the platform
 * to abuse by accident. Everything with a real home keeps it: a repair is a
 * maintenance request, a neighbour is a complaint, wanting to renew is
 * request_lease_renewal. This is for what is genuinely left over — asking about
 * a different unit, flagging that they will be away, a question only the
 * landlord can answer.
 *
 * One-way, exactly like message_tenant. There is no reply thread on the
 * platform, so the tool says so rather than letting the agent imply a
 * conversation the tenant will sit waiting for.
 */
import { queryOne } from '../../../db'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

/** Things that have a proper tool. Sending these as prose loses the workflow. */
const BELONGS_ELSEWHERE: { re: RegExp; use: string; why: string }[] = [
  {
    re: /\b(leak\w*|broken|not working|won'?t (work|turn|open|close|flush)|no (hot water|heat|power)|clogged|blocked|repair|fix)\b/i,
    use: 'file_maintenance_request',
    why: 'a repair goes on the maintenance board where it gets tracked and assigned — a message just sits in a notification',
  },
  {
    re: /\b(neighbou?r|next door|upstairs|downstairs)\b[^.?!]{0,50}\b(loud|noise|noisy|music|smoking|parking|barking|trash)\b/i,
    use: 'log_complaint',
    why: 'a complaint is recorded with a category and a status the landlord works through',
  },
  {
    re: /\b(renew|renewal|another year|extend my lease|stay(ing)? on)\b/i,
    use: 'request_lease_renewal',
    why: 'a renewal request is a tracked request, not a note',
  },
]

export const messageMyLandlord: AgentTool = {
  name: 'message_my_landlord',
  description:
    'Send a plain message from the tenant to their own landlord. It arrives as a notification on the ' +
    'landlord’s account. Use for the things that have no other home: asking about moving to a bigger ' +
    'or different unit, telling them they will be away, asking a question only the landlord can ' +
    'answer.\\n' +
    'DO NOT use it for anything that has its own tool. A repair is file_maintenance_request. A ' +
    'neighbour, noise, parking or trash is log_complaint. Wanting to renew is request_lease_renewal. ' +
    'Those are tracked; a message is not, and sending one instead quietly drops the tenant out of a ' +
    'workflow they should be in.\\n' +
    'CONFIRM FIRST — read the wording back and get an explicit yes. It goes out in their name and ' +
    'cannot be recalled.\\n' +
    'It is ONE-WAY. There is no reply thread here, so tell them their landlord will follow up ' +
    'directly; never imply they can carry on the conversation in this chat.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'What the tenant wants to say, in their own words. Tidy the grammar; do not change the meaning or add requests they did not make.',
      },
    },
    required: ['message'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const message = String(args.message ?? '').trim().slice(0, 2000)
    if (message.length < 3) {
      return { ok: false, error: 'Nothing to send — ask them what they want to say first.' }
    }

    const misrouted = BELONGS_ELSEWHERE.find((b) => b.re.test(message))
    if (misrouted) {
      return {
        ok: false,
        wrongTool: true,
        useInstead: misrouted.use,
        error: `That belongs in ${misrouted.use}, not a message — ${misrouted.why}.`,
        tellThem: 'Do it properly with that tool instead. Do not tell them a message was sent.',
      }
    }

    // WHO comes from the signed-in tenant, never from the model.
    const lease = await queryOne<any>(
      `SELECT l.landlord_id, lu.id AS landlord_user_id,
              u.unit_number, p.name AS property_name,
              tu.first_name || ' ' || tu.last_name AS tenant_name
         FROM leases l
         JOIN landlords ll ON ll.id = l.landlord_id
         JOIN users lu     ON lu.id = ll.user_id
         JOIN tenants tt   ON tt.id = $1
         JOIN users tu     ON tu.id = tt.user_id
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
         JOIN units u          ON u.id = l.unit_id
         JOIN properties p     ON p.id = u.property_id
        WHERE lt.tenant_id = $1 AND l.status = 'active'
        ORDER BY l.start_date DESC LIMIT 1`,
      [actor.profileId],
    )
    if (!lease) {
      return {
        ok: false,
        error: 'No active lease on record, so there is no landlord to send this to. Do NOT tell them it was sent.',
      }
    }

    const who = String(lease.tenant_name ?? '').trim() || 'Your tenant'
    const where = [lease.property_name, lease.unit_number].filter(Boolean).join(' ')
    await createNotification({
      userId: lease.landlord_user_id,
      landlordId: lease.landlord_id,
      type: 'tenant_message',
      title: where ? `Message from ${who} (${where})` : `Message from ${who}`,
      body: message,
    })

    return {
      ok: true,
      sent: true,
      to: 'their landlord',
      note:
        'Delivered to their landlord’s notifications. Tell them it is sent and that their landlord ' +
        'will get back to them directly — there is no reply thread here, so do not suggest they wait ' +
        'in this chat for an answer.',
    }
  },
}
