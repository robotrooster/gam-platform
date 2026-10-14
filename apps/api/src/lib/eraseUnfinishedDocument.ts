/**
 * 10/13 (Nic) — A DOCUMENT THAT NEVER COMPLETED, AND THAT NO MONEY TOUCHED, IS
 * ERASED. NOT VOIDED, NOT ARCHIVED.
 *
 *   "I don't want voided forms archived. I want them completely erased from
 *    existence. If I draft a hundred leases that never get fulfilled, I don't
 *    want to void them. They need to be deleted ... If it never completed, it
 *    doesn't exist. We don't need an archive for things that never came to be."
 *
 * The scope he chose: erase any unfinished document UNLESS money already
 * touched it. A lease the landlord signed that issued a lease and billed
 * somebody stays on record as today's void (lib/voidDocument). This is the one
 * carve-out from keep-everything; anything else a document did keeps its
 * record.
 *
 * WHAT KEEPS A DOCUMENT (keptReasonSql — one test, read by the void route, the
 * GoldSign list's Delete/Void label and the one-time cleanup script):
 *   - It COMPLETED, or every signer signed and only the lease build failed
 *     (execution_failed): it came to be.
 *   - The landlord's signature ISSUED it (issued_at, S647): a lease row, its
 *     move-in bill and charges, a deposit, held utility released onto it, a
 *     work-trade agreement. Or it was APPLIED (finalized_at): a lease built,
 *     a tenant added or removed, terms changed, a sublease started.
 *   - A RESIDENT has signed it. A document a tenant signed is never thrown
 *     away (S558) — the void refuses it too, and a superseding document is
 *     the way forward.
 *   - A money change from it (scheduled_lease_changes) reached billing.
 *   - The home sale it papers ever started: active, paid off, activated once,
 *     or any home payment billed from it (paid, owed or voided — a voided one
 *     is still the record that somebody was billed).
 *   - It moved someone onto or off a lease, delivered a notice to a tenant,
 *     or recorded who owns a home.
 *   - A tenant's sublease request is tied to it (the request row names its
 *     agreement from the moment it is drafted, with no delete rule of its own;
 *     what erasing the agreement should do to the request is Nic's call —
 *     subleasing is switched off platform-wide meanwhile).
 *   - An OPEN invite is waiting on it (pending_tenant_intents.draft_document_id,
 *     neither resolved nor canceled). The invite's pointer is what stops the
 *     hourly re-draft (householdLeaseDraft.draftAllPendingLeases drafts every
 *     open invite with no draft): erased, a fresh lease would be drafted and
 *     emailed to the landlord within the hour — the opposite of a delete.
 *     Whether deleting such a lease should also close the invite is Nic's
 *     call; until he makes it, it keeps today's void.
 *   - It is a packet's lease and another document still open in that packet
 *     is kept for one of the reasons above (a home sale billing, say): the
 *     lease is voided as today and the packet stays whole.
 *
 * WHAT GOES WITH AN ERASED DOCUMENT, in one transaction: its boxes and signers
 * (ON DELETE CASCADE); the never-joined person an add-tenant addendum put on
 * the lease (pending_add, or void after an earlier void); the person a
 * remove-tenant addendum was taking off goes back to active (the void's own
 * cascade); its money changes that never reached billing; the home sale it
 * papered that never started, with its installment schedule; a closed
 * invite's pointer to it; the bell notifications that only point at it ("Lease
 * drafted — ready for your signature" for a lease that no longer exists — his
 * "I don't want to search through a long ass list of stuff that maybe
 * happened"). A packet's lease takes every other unfinished document of its
 * packet with it — the packet is one thing (S652), and its forms have no lease
 * to belong to without it. A form erased on its own leaves the rest of its
 * packet alone. Files only it used are removed after COMMIT
 * (removeOrphanedDocumentFiles); a template's or the library's PDF is shared
 * and stays.
 *
 * WHAT IS NOT TOUCHED: the change journal (audit_row_changes keeps a copy of
 * every erased row, as it does for every delete), the action log (audit_log)
 * and the log of emails already sent — those record what happened, not the
 * document.
 */
import fs from 'fs'
import path from 'path'
import { AppError } from '../middleware/errorHandler'
import { lockLeaseHousehold } from './unwindIssuedLease'
import { lockHousehold } from '../services/moneyPredicates'
import { resolveUploadPath } from './uploadPaths'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

/** Why a document stays on record (null in SQL = it is erased). */
export type DocumentKeptReason =
  | 'completed' | 'all_signed' | 'issued' | 'applied' | 'resident_signed'
  | 'change_applied' | 'sale_started' | 'sublease' | 'roster_changed'
  | 'notice_delivered' | 'home_owned' | 'open_invite' | 'packet_kept'
  // The one-time cleanup only (scripts/oct13_erase_unfinished_documents):
  | 'not_voided' | 'packet_out_for_signature' | 'protected'

/** The cause, in words (the caller says what follows from it). */
export const DOCUMENT_KEPT_REASON_WORDS: Record<DocumentKeptReason, string> = {
  completed: 'Everyone signed it.',
  all_signed: 'Everyone signed it (only building the lease failed).',
  issued: 'It issued a lease and billed the household.',
  applied: 'It already took effect on the lease.',
  resident_signed: 'A resident has signed it.',
  change_applied: 'A rent or fee change from it already reached the bill.',
  sale_started: 'The home sale it papers already started billing.',
  // The sublease row is tied to its agreement the moment the agreement is
  // drafted (services/subleaseDocuments), so this is a request, not a start.
  sublease: 'A tenant\'s sublease request is tied to it.',
  roster_changed: 'Someone was added to or taken off a lease through it.',
  notice_delivered: 'Its notice was already delivered to the tenants.',
  home_owned: 'It recorded who owns a home.',
  open_invite: 'The invite for this household is still open and waiting on this lease.',
  packet_kept: 'Another document in its packet is already in effect.',
  not_voided: 'It is still out for signature.',
  packet_out_for_signature: 'Other documents in its packet are still out for signature.',
  protected: 'It, or a document of its packet, is on the list this cleanup never touches.',
}

function alias(a: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`eraseUnfinishedDocument: "${a}" is not a table alias`)
  return a
}

/**
 * Whether the home sale `k` (a home_sale_contracts alias) ever started: active,
 * paid off, activated once, or any home payment billed from it (paid, owed or
 * voided — a voided one is still the record that somebody was billed). One
 * test for what keeps a document (keptReasonSql) and for what the erase may
 * delete, so the delete can never take a sale the keep test would have kept.
 */
function saleStartedSql(k: string): string {
  k = alias(k)
  return `(${k}.status IN ('active','paid_off') OR ${k}.activated_at IS NOT NULL
           OR COALESCE(${k}.installments_billed, 0) > 0
           OR EXISTS (SELECT 1 FROM home_sale_installments ki
                        JOIN payments kp ON kp.home_sale_installment_id = ki.id
                       WHERE ki.contract_id = ${k}.id))`
}

/**
 * The reason THIS document stays on record, as SQL text (a reason code from
 * DocumentKeptReason), or NULL when nothing keeps it. `a` is the
 * lease_documents alias. A voided document is judged like any other: voiding
 * changed nothing about what it did.
 */
export function keptReasonSql(a = 'd'): string {
  a = alias(a)
  return `CASE
      WHEN ${a}.status = 'completed' THEN 'completed'
      WHEN ${a}.status = 'execution_failed' THEN 'all_signed'
      WHEN ${a}.issued_at IS NOT NULL THEN 'issued'
      WHEN ${a}.finalized_at IS NOT NULL THEN 'applied'
      WHEN EXISTS (SELECT 1 FROM lease_document_signers k
                    WHERE k.document_id = ${a}.id AND k.signed_at IS NOT NULL
                      AND k.role NOT IN ('landlord','witness')) THEN 'resident_signed'
      WHEN EXISTS (SELECT 1 FROM scheduled_lease_changes k
                    WHERE k.source_document_id = ${a}.id AND k.status = 'applied') THEN 'change_applied'
      WHEN EXISTS (SELECT 1 FROM home_sale_contracts k
                    WHERE k.purchase_document_id = ${a}.id AND ${saleStartedSql('k')}) THEN 'sale_started'
      WHEN EXISTS (SELECT 1 FROM subleases k WHERE k.sublease_document_id = ${a}.id) THEN 'sublease'
      WHEN EXISTS (SELECT 1 FROM lease_tenants k
                    WHERE (k.add_document_id = ${a}.id AND k.status NOT IN ('pending_add','void'))
                       OR (k.remove_document_id = ${a}.id AND k.status NOT IN ('pending_remove','active'))
                       OR (k.add_document_id = ${a}.id
                           AND EXISTS (SELECT 1 FROM lease_documents ko
                                        WHERE ko.id <> ${a}.id
                                          AND (ko.target_lease_tenant_id = k.id OR ko.promote_lease_tenant_id = k.id)))) THEN 'roster_changed'
      WHEN EXISTS (SELECT 1 FROM lease_notices k WHERE k.source_document_id = ${a}.id) THEN 'notice_delivered'
      WHEN EXISTS (SELECT 1 FROM home_ownerships k WHERE k.sale_document_id = ${a}.id) THEN 'home_owned'
      WHEN EXISTS (SELECT 1 FROM pending_tenant_intents k
                    WHERE k.draft_document_id = ${a}.id
                      AND k.resolved_at IS NULL AND k.cancelled_at IS NULL) THEN 'open_invite'
      ELSE NULL
    END`
}

/**
 * keptReasonSql, plus the packet: a packet's lease is kept when another
 * document still open in its packet is kept (it would be stranded without its
 * lease). Erased with the lease otherwise.
 */
export function documentKeptReasonSql(a = 'd'): string {
  a = alias(a)
  return `COALESCE(${keptReasonSql(a)},
    CASE WHEN ${a}.document_type = 'original_lease' AND ${a}.package_group_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM lease_documents ps
                           WHERE ps.package_group_id = ${a}.package_group_id AND ps.id <> ${a}.id
                             AND ps.status NOT IN ('completed','voided')
                             AND (${keptReasonSql('ps')}) IS NOT NULL)
         THEN 'packet_kept' END)`
}

/** What the landlord's end-of-life button does, and why it can't delete. */
export interface DocumentEnd {
  /** 'delete' (erased), 'void' (stays on record as voided — or the void route
   *  refuses it, in its own words), or null: no button (completed, or already
   *  voided). */
  end_action: 'delete' | 'void' | null
  /** Why it can't be deleted, in words (only with 'void'). */
  end_reason: string | null
}

/**
 * The button, from the document's status and its documentKeptReasonSql. One
 * test for the GoldSign list, the new-lease window and the route
 * (lib/voidDocument.endDocument), so the button never says Delete for a
 * document the route voids — and when it says Void, it says why.
 */
export function documentEnd(status: string, keptReason: DocumentKeptReason | null): DocumentEnd {
  if (status === 'completed' || status === 'voided') return { end_action: null, end_reason: null }
  if (!keptReason) return { end_action: 'delete', end_reason: null }
  return { end_action: 'void', end_reason: DOCUMENT_KEPT_REASON_WORDS[keptReason] ?? null }
}

export interface ErasedDocument { id: string; title: string; status: string; documentType: string }

export type EraseOutcome =
  | { erased: true; documents: ErasedDocument[]; files: string[] }
  | { erased: false; reason: DocumentKeptReason; words: string }

const kept = (reason: DocumentKeptReason): EraseOutcome =>
  ({ erased: false, reason, words: DOCUMENT_KEPT_REASON_WORDS[reason] })

/**
 * Read-only: what an erase of `documentId` would remove right now, or why it
 * would not. The cleanup script's dry run prints this; eraseUnfinishedDocument
 * re-reads the same thing under its locks before it deletes anything.
 * `onlyVoided` (the one-time cleanup): erase only what is already voided —
 * never a document still out for signature, nor a packet lease whose packet
 * still has one. `protectedIds` (the one-time cleanup): documents never
 * erased — the document itself or one its packet lease would take along.
 */
export interface EraseOptions { onlyVoided?: boolean; protectedIds?: readonly string[] }

export async function planErase(
  q: Q, documentId: string, opts: EraseOptions = {},
): Promise<EraseOutcome> {
  const doc = (await q(
    `SELECT d.id, d.title, d.status, d.document_type, d.package_group_id,
            d.base_pdf_url, d.executed_pdf_url,
            ${documentKeptReasonSql('d')} AS why
       FROM lease_documents d WHERE d.id = $1`, [documentId])).rows[0]
  if (!doc) throw new AppError(404, 'Document not found')
  if (doc.why) return kept(doc.why)
  if (opts.onlyVoided && doc.status !== 'voided') return kept('not_voided')

  // The packet's other unfinished documents go with its lease. Siblings kept
  // for a reason of their own were already caught above (packet_kept) unless
  // they are voided — a kept void stays where it is.
  const siblings = doc.document_type === 'original_lease' && doc.package_group_id
    ? (await q(
        `SELECT s.id, s.title, s.status, s.document_type, s.base_pdf_url, s.executed_pdf_url,
                ${keptReasonSql('s')} AS why
           FROM lease_documents s
          WHERE s.package_group_id = $1 AND s.id <> $2 AND s.status <> 'completed'
          ORDER BY s.id`, [doc.package_group_id, doc.id])).rows.filter((s: any) => !s.why)
    : []
  if (opts.onlyVoided && siblings.some((s: any) => s.status !== 'voided')) return kept('packet_out_for_signature')

  const all = [...siblings, doc]
  if (opts.protectedIds?.length && all.some((r: any) => opts.protectedIds!.includes(r.id))) return kept('protected')
  return {
    erased: true,
    documents: all.map((r: any) => ({ id: r.id, title: r.title, status: r.status, documentType: r.document_type })),
    files: [...new Set(all.flatMap((r: any) => [r.base_pdf_url, r.executed_pdf_url]).filter(Boolean) as string[])],
  }
}

/**
 * Erase `doc` — and, for a packet's lease, its packet's other unfinished
 * documents — when nothing keeps it. Inside the caller's open transaction.
 * Returns { erased: false, reason } with nothing changed when it must stay on
 * record; the void route then voids it as before.
 *
 * Locks in the void's order (S655, lib/voidDocument step 0): the household,
 * the buyer's household for an installment contract, then the document — so
 * a document this keeps goes on to the void holding its locks in the order
 * the void takes them. And the finalize lock buildLeaseFromDocument takes, so a landlord signature issuing
 * this lease at the same moment either commits first — and the re-check below
 * sees it issued and keeps it — or waits for the erase. The rows are locked
 * first and judged by a later statement, so the decision reads what is
 * committed once the locks are held, never the copy the caller read.
 *
 * 10/13 review: ALL of that for every document the erase may take, not only
 * the one pressed. A packet's lease takes its packet's forms, and one of them
 * can be an installment contract whose sale the morning retry
 * (services/homeSale.retryLandlordSignedHomeSaleStarts) starts under the
 * buyer's household lock and the contract's row lock — never the document's.
 * Locking only the lease, an erase that judged the sale "never started" could
 * delete it a moment after it started billing (the delete re-reads the row it
 * waited on and still matches), its installments with it and its home
 * payments left pointing at nothing. Now the buyer is locked first, so the
 * start either committed before the judgment or waits for the erase; and the
 * delete itself only takes a sale that never started (saleStartedSql), and
 * refuses the whole erase if one is left.
 */
export async function eraseUnfinishedDocument(
  q: Q, doc: { id: string; lease_id?: string | null; document_type?: string | null },
  opts: EraseOptions = {},
): Promise<EraseOutcome> {
  if (doc.lease_id) await lockLeaseHousehold(q, doc.lease_id)
  // Every document this erase may take: this one, and for a packet's lease
  // every other document of its packet (read without a lock — only to know
  // what to lock; the judgment comes after).
  const scope = (await q(
    `SELECT s.id FROM lease_documents d
       JOIN lease_documents s
         ON s.id = d.id
         OR (d.document_type = 'original_lease' AND d.package_group_id IS NOT NULL
             AND s.package_group_id = d.package_group_id)
      WHERE d.id = $1
      ORDER BY s.id`, [doc.id])).rows.map((r: any) => r.id as string)
  if (scope.length === 0) throw new AppError(404, 'Document not found')
  // The buyer's household of every home sale among them, before any document
  // lock (the void's order), one household at a time in a fixed order.
  const buyers = (await q(
    `SELECT DISTINCT tenant_id, landlord_id FROM home_sale_contracts
      WHERE purchase_document_id = ANY($1::uuid[]) AND status IN ('pending_signature', 'active', 'paid_off')
      ORDER BY tenant_id, landlord_id`, [scope])).rows
  for (const b of buyers) await lockHousehold({ query: q } as any, b.tenant_id, b.landlord_id)
  for (const id of scope) {
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`esign_finalize:${id}`])
  }
  const live = (await q(
    `SELECT id, document_type, package_group_id FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
  if (!live) throw new AppError(404, 'Document not found')
  if (live.document_type === 'original_lease' && live.package_group_id) {
    await q(
      `SELECT id FROM lease_documents WHERE package_group_id = $1 AND id <> $2 ORDER BY id FOR UPDATE`,
      [live.package_group_id, live.id])
  }
  const plan = await planErase(q, doc.id, opts)
  if (!plan.erased) return plan

  for (const d of plan.documents) {
    // The roster: a person an add-tenant addendum was bringing on never joined;
    // a person a remove-tenant addendum was taking off stays (the void's own
    // cascade, leaseDocCascade).
    await q(
      `DELETE FROM lease_tenants WHERE add_document_id = $1 AND status IN ('pending_add','void')`, [d.id])
    await q(
      `UPDATE lease_tenants SET status = 'active', remove_document_id = NULL, updated_at = NOW()
        WHERE remove_document_id = $1 AND status = 'pending_remove'`, [d.id])
    await q(
      `UPDATE lease_tenants SET remove_document_id = NULL, updated_at = NOW()
        WHERE remove_document_id = $1`, [d.id])
    // Its money changes never reached billing (an applied one keeps it).
    await q(`DELETE FROM scheduled_lease_changes WHERE source_document_id = $1`, [d.id])
    // The home sale it papered never started (a started one keeps it); its
    // installment schedule goes with it (ON DELETE CASCADE). Only a sale that
    // never started — and if one started after all, nothing is erased.
    await q(
      `DELETE FROM home_sale_contracts k WHERE k.purchase_document_id = $1 AND NOT ${saleStartedSql('k')}`, [d.id])
    if ((await q(`SELECT 1 FROM home_sale_contracts WHERE purchase_document_id = $1 LIMIT 1`, [d.id])).rows[0]) {
      throw new AppError(409,
        `The home sale on "${d.title}" started billing a moment ago, so nothing was deleted. ` +
        'Look at the document again: it now stays on record, and the button voids it.')
    }
    // Only a closed invite can still point here (an open one keeps it).
    await q(
      `UPDATE pending_tenant_intents SET draft_document_id = NULL, updated_at = NOW()
        WHERE draft_document_id = $1`, [d.id])
    // The bell notifications that only point at it ("ready for your
    // signature"). Emitters write the id camelCase; a few write snake_case.
    await q(
      `DELETE FROM notifications WHERE data->>'documentId' = $1::text OR data->>'document_id' = $1::text`, [d.id])
    // The document, its boxes and its signers.
    await q(`DELETE FROM lease_documents WHERE id = $1`, [d.id])
  }
  return plan
}

/**
 * After COMMIT: remove each erased document's file from disk when nothing
 * else names it any more — a template's PDF, a library form and another
 * document drafted from the same paper all keep it. Best-effort: a file that
 * cannot be removed is left (and returned in `left`), never a reason to undo
 * the erase. Returns what was removed.
 */
export async function removeOrphanedDocumentFiles(
  q: Q, urls: string[],
  uploadDir: string = path.join(process.cwd(), 'uploads', 'leases'),
): Promise<{ removed: string[]; left: string[] }> {
  const removed: string[] = []
  const left: string[] = []
  for (const url of [...new Set(urls)]) {
    const stillUsed = (await q(
      `SELECT 1 FROM lease_documents WHERE base_pdf_url = $1 OR executed_pdf_url = $1
       UNION ALL SELECT 1 FROM lease_templates WHERE base_pdf_url = $1
       UNION ALL SELECT 1 FROM disclosure_library_documents WHERE base_pdf_url = $1
       LIMIT 1`, [url])).rows[0]
    if (stillUsed) continue
    const file = resolveUploadPath(uploadDir, url)
    try {
      if (file && fs.existsSync(file)) { fs.unlinkSync(file); removed.push(url) }
    } catch {
      left.push(url)
    }
  }
  return { removed, left }
}
