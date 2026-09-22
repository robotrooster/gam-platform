/**
 * S652 — A PACKET IS SIGNED AS ONE THING, AND HANDED ON AS ONE THING.
 *
 * Nic: "it needs to be bundled as a true package." Until now every document in
 * a packet ran its own relay: the moment Blu signed one, that one went to the
 * tenant. Shane Rueff got nine "please sign" emails for Lot 11 in a morning,
 * one per document, while Blu was still working through the packet.
 *
 * The rule now: a signer is invited to a packet ONCE, when everyone before
 * them in the signing order has finished EVERY document in it. One email, one
 * link (to the first document that needs them), and the page walks them
 * through the rest. Completion works the same way — one "fully executed" note
 * per signer when the last document in the packet completes, not nine.
 *
 * Standalone documents (no package_group_id) keep the per-document relay in
 * routes/esign.ts untouched.
 */
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { emailSigningRequest, emailSigningCompleted } from './email'
import { createNotification } from './notifications'

type Doc = { id: string; title: string; status: string; sort_order: number; landlord_id: string; unit_id: string | null }
type SignerRow = { id: string; document_id: string; user_id: string; role: string; name: string; email: string; token: string | null; order_index: number; status: string; invite_sent: boolean | null }

async function packetDocs(groupId: string): Promise<Doc[]> {
  return query<Doc>(
    `SELECT d.id, d.title, d.status, COALESCE(d.package_sort_order, 0) AS sort_order, d.landlord_id, d.unit_id
       FROM lease_documents d
      WHERE d.package_group_id = $1 AND d.voided_at IS NULL AND d.status <> 'voided'
      ORDER BY d.package_sort_order, d.created_at`, [groupId])
}

async function packetLabel(docs: Doc[]): Promise<{ unitLabel: string; landlordName: string; title: string }> {
  const lease = docs.find(d => /^Lease/.test(d.title)) ?? docs[0]
  const ctx = await queryOne<any>(
    `SELECT u.unit_number, p.name AS property_name,
            TRIM(COALESCE(NULLIF(p.lease_signing_name, ''), CONCAT_WS(' ', lu.first_name, lu.last_name))) AS landlord_name
       FROM lease_documents d
       LEFT JOIN units u ON u.id = d.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       JOIN landlords la ON la.id = d.landlord_id
       JOIN users lu ON lu.id = la.user_id
      WHERE d.id = $1`, [lease.id])
  const unitLabel = ctx?.unit_number ? `Unit ${ctx.unit_number} — ${ctx.property_name}` : lease.title
  return {
    unitLabel,
    landlordName: ctx?.landlord_name ?? '',
    title: `Lease packet — ${docs.length} document${docs.length === 1 ? '' : 's'}`,
  }
}

/**
 * After any signature on a packet document: if the next signer in order has
 * finished nothing yet and everyone before them is done with every document,
 * invite them — once — to the whole packet.
 */
export async function advancePacket(groupId: string): Promise<{ invited: string | null }> {
  const docs = await packetDocs(groupId)
  if (!docs.length) return { invited: null }
  const open = docs.filter(d => d.status !== 'completed')
  if (!open.length) return { invited: null }

  const signers = await query<SignerRow>(
    `SELECT s.id, s.document_id, s.user_id, s.role, s.name, s.email, s.token, s.order_index, s.status, s.invite_sent
       FROM lease_document_signers s
      WHERE s.document_id = ANY($1::uuid[])
      ORDER BY s.order_index, s.document_id`, [docs.map(d => d.id)])

  // Who still has something to sign, lowest order first.
  const unsigned = signers.filter(s => s.status !== 'signed' && s.status !== 'declined')
  if (!unsigned.length) return { invited: null }
  const nextOrder = Math.min(...unsigned.map(s => s.order_index))
  // Everyone ahead of them must be done with EVERY document.
  const blocked = signers.some(s => s.order_index < nextOrder && s.status !== 'signed')
  if (blocked) return { invited: null }

  const mine = unsigned.filter(s => s.order_index === nextOrder)
  // Invited already, or has signed something in it — either way, not again.
  const alreadyInvited = signers.some(s => s.order_index === nextOrder && (s.invite_sent || s.status === 'sent' || s.status === 'viewed' || s.status === 'signed'))
  if (alreadyInvited) return { invited: null }

  // The first document (in packet order) that needs them is the way in.
  const first = docs.map(d => mine.find(s => s.document_id === d.id)).find(Boolean)!
  const { unitLabel, landlordName, title } = await packetLabel(docs)
  const firstDoc = docs.find(d => d.id === first.document_id)!

  let url: string
  let needsSetup = false
  if (first.role === 'landlord' || first.role === 'witness') {
    const { signingUrlFor } = await import('../routes/esign')
    const u = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [first.user_id])
    url = signingUrlFor(first, firstDoc.id, u)
  } else {
    const { tenantLeaseLink } = await import('./tenantLeaseLink')
    const link = await tenantLeaseLink({ userId: first.user_id, documentId: firstDoc.id, signerToken: first.token ?? undefined })
    url = link.url
    needsSetup = link.needsSetup
  }

  await emailSigningRequest(first.email, first.name, `${title} (${docs.map(d => d.title.replace(/ — .*$/, '')).join(', ')})`,
    unitLabel, landlordName, url, { landlordId: firstDoc.landlord_id, documentId: firstDoc.id, needsSetup })
  await createNotification({
    userId: first.user_id,
    type: 'esign_request',
    title: 'Documents ready to sign',
    body: `Your ${docs.length}-document packet for ${unitLabel} is awaiting your signature.`,
    data: { documentId: firstDoc.id, packageGroupId: groupId },
    sendEmail: false,
  }).catch(e => logger.warn({ err: e }, '[packet] notification failed'))
  await query(
    `UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW()
      WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [mine.map(s => s.id)])
  logger.info({ groupId, signer: first.email, documents: docs.length }, '[packet] next signer invited once for the whole packet')
  return { invited: first.email }
}

/**
 * When a packet document completes: nothing is said until the LAST one does,
 * then every signer hears once. Returns true when this call sent the notes.
 */
export async function announcePacketIfComplete(groupId: string, portalHomeFor: (role: string) => string): Promise<boolean> {
  const docs = await packetDocs(groupId)
  if (!docs.length || docs.some(d => d.status !== 'completed')) return false
  const already = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM notifications
      WHERE type = 'esign_completed' AND data->>'packageGroupId' = $1`, [groupId])
  if (Number(already?.n ?? 0) > 0) return false
  const { unitLabel, title } = await packetLabel(docs)
  const signers = await query<SignerRow>(
    `SELECT DISTINCT ON (s.user_id) s.* FROM lease_document_signers s
      WHERE s.document_id = ANY($1::uuid[]) ORDER BY s.user_id, s.order_index`, [docs.map(d => d.id)])
  for (const s of signers) {
    await emailSigningCompleted(s.email, s.name, title, unitLabel, undefined, portalHomeFor(s.role),
      { landlordId: docs[0].landlord_id, documentId: docs[0].id })
    await createNotification({
      userId: s.user_id,
      type: 'esign_completed',
      title: 'Packet fully executed',
      body: `All ${docs.length} documents for ${unitLabel} have been signed by everyone.`,
      data: { documentId: docs[0].id, packageGroupId: groupId },
      sendEmail: false,
    }).catch(e => logger.warn({ err: e }, '[packet] completion notification failed'))
  }
  return true
}
