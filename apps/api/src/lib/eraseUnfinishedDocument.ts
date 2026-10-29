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
 * GoldSign list's Delete/Void label, the automatic voids in jobs/scheduler and
 * the one-time cleanup scripts):
 *   - It COMPLETED, or every signer signed and only the lease build failed
 *     (execution_failed): it came to be.
 *   - A LEASE the landlord's signature issued (issued_at, S647 — or built,
 *     finalized_at) stays only when MONEY touched that lease, or other records
 *     live on it (leaseMoneyTouchedSql, leaseInUseSql below). 10/14 (Nic, #8):
 *     Mountain View RV 09's lease, voided 9/18 with only $0.00 bills — "delete
 *     it". Erased, the lease row goes too, with every row of it nothing paid,
 *     credited or settled (eraseLeaseRows). Any other kind of document the
 *     landlord's signature issued, or that was APPLIED (a tenant added or
 *     removed, terms changed), stays: it already changed a lease.
 *   - A money change from it (scheduled_lease_changes) reached billing.
 *   - The home sale it papers ever started: active, paid off, activated once,
 *     or any home payment billed from it (paid, owed or voided — a voided one
 *     is still the record that somebody was billed).
 *   - It moved someone onto or off a lease, delivered a notice to a tenant,
 *     or recorded who owns a home.
 *   - The sublease it papers STARTED (active, or a sublessor balance was
 *     opened on it). 10/14 (Nic, #3): "Delete an unsigned sublease agreement:
 *     delete the sublease request too" — a request that never started goes
 *     with its agreement; the sublessee's invite stays, canceled (subleasing
 *     is switched off platform-wide; the path stays correct anyway).
 *   - It is a packet's lease and another document still open in that packet
 *     is kept for one of the reasons above (a home sale billing, say): the
 *     lease is voided as today and the packet stays whole.
 *
 * WHAT NO LONGER KEEPS ONE (10/14, Nic's answers):
 *   - #2 "One co-tenant signed, other never, nothing billed: may be deleted."
 *     A resident's signature alone keeps nothing; a lease that billed someone
 *     still stays (its money keeps it, above), and the void still refuses a
 *     tenant-signed document (S558) — a superseding document is the way on.
 *   - #1 "Delete a lease an open invite waits on: cancel the invite too." The
 *     invite is canceled in the same transaction (cancelOpenInvites): the
 *     link stops working, and the hourly re-draft
 *     (householdLeaseDraft.draftAllPendingLeases, open invites only) never
 *     drafts a new one. ONLY the landlord's own Delete does this. 10/14
 *     afternoon (Nic): "thats not how the flow works. invite and signing by
 *     tenant is one flow after landlord has already signed" — GAM ending a
 *     document ON ITS OWN (the 48-hour timeout, a lapsed new lease, the
 *     30-day step, a new invite's stale draft: EraseOptions.onItsOwn) never
 *     cancels an invite. The invite stays open and lets go of the document,
 *     so the household is drafted again.
 *
 * WHAT GOES WITH AN ERASED DOCUMENT, in one transaction: its boxes and signers
 * (ON DELETE CASCADE); the never-joined person an add-tenant addendum put on
 * the lease (pending_add, or void after an earlier void); the person a
 * remove-tenant addendum was taking off goes back to active (the void's own
 * cascade); its money changes that never reached billing; the home sale it
 * papered that never started, with its installment schedule; the sublease
 * request it papered that never started; an OPEN invite waiting on it is
 * canceled by the landlord's own Delete (a closed one, or any invite when GAM
 * ends the document on its own, only lets go of it); the lease it issued,
 * when it issued one, with that lease's $0.00 bills; the bell notifications that only point at it ("Lease
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
import { AppError } from '../middleware/errorHandler'
import { lockLeaseHousehold, paymentTriedSql, unwindIssuedLease } from './unwindIssuedLease'
import { lockHousehold } from '../services/moneyPredicates'
import { storage, uploadKeyFromStored, type StorageDriver } from './storage'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

/** Why a document stays on record (null in SQL = it is erased). */
export type DocumentKeptReason =
  | 'completed' | 'all_signed' | 'issued' | 'applied' | 'lease_money' | 'lease_in_use'
  | 'change_applied' | 'sale_started' | 'sublease' | 'roster_changed'
  | 'notice_delivered' | 'home_owned' | 'packet_kept'
  // The one-time cleanups only (scripts/oct13_erase_unfinished_documents,
  // scripts/oct14_erase_documents):
  | 'not_voided' | 'packet_out_for_signature' | 'protected'

/** The cause, in words (the caller says what follows from it). */
export const DOCUMENT_KEPT_REASON_WORDS: Record<DocumentKeptReason, string> = {
  completed: 'Everyone signed it.',
  all_signed: 'Everyone signed it (only building the lease failed).',
  issued: 'It issued a lease and billed the household.',
  applied: 'It already took effect on the lease.',
  lease_money: 'Money touched the lease it issued: something on it was billed, paid, credited or settled.',
  lease_in_use: 'Other records were made on the lease it issued (another document, a notice, an inspection or a request).',
  change_applied: 'A rent or fee change from it already reached the bill.',
  sale_started: 'The home sale it papers already started billing.',
  sublease: 'The sublease it papers already started.',
  roster_changed: 'Someone was added to or taken off a lease through it.',
  notice_delivered: 'Its notice was already delivered to the tenants.',
  home_owned: 'It recorded who owns a home.',
  packet_kept: 'Another document in its packet is already in effect.',
  not_voided: 'It is still out for signature.',
  packet_out_for_signature: 'Other documents in its packet are still out for signature.',
  protected: 'It, or a document of its packet, is on the list this cleanup never touches.',
}

function alias(a: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`eraseUnfinishedDocument: "${a}" is not a table alias`)
  return a
}

/** A lease id in SQL: `alias.column`, or a `$n` parameter. */
function leaseRef(l: string): string {
  if (!/^([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*|\$\d+)$/i.test(l)) {
    throw new Error(`eraseUnfinishedDocument: "${l}" is not a lease id reference`)
  }
  return l
}

/**
 * 10/14 (Nic, #8): "Mountain View RV 09 (voided 9/18, $0.00 bills): delete
 * it." WHETHER MONEY TOUCHED LEASE `l` — true keeps the lease (and the
 * document that issued it) on record.
 *
 * A $0.00 bill is "no money" ONLY when nothing was ever paid, credited or
 * settled on it. A charge row of the lease, of its bills or of its utility
 * bills is money when ANY of these holds:
 *   - its amount is not $0.00 (any status — a voided $40.00 line is still the
 *     record that somebody was billed $40.00);
 *   - a payment was tried on it (paymentTriedSql: a card or bank attempt, a
 *     receipt applied, account credit set aside or spent, a bank-return log),
 *     it is processing, paid from a deposit, or returned;
 *   - credit came of it or went onto it (an overpayment credit issued, work
 *     trade credited, GAM's share taken), it was settled from a deposit
 *     return, a work-trade period or a FlexPay advance;
 *   - a bank line or a deposit slip was matched to it, a reversal or dispute
 *     names it, GAM charged the landlord on it, the books posted a non-zero
 *     line for it, or any Flex, prepaid, propane, one-off, stay-refund or
 *     termination-fee record points at it.
 * A $0.00 line marked paid by hand ("Recorded as manual cash payment" with
 * $0.00 — RV 09's final electric, meter 362 → 362) has none of these: no
 * dollar moved, and it is no money.
 *
 * And, beside its charge rows: a bill or utility bill of the lease for more
 * than $0.00 — a bill's SUBTOTALS count too: a void before 10/12 deleted a
 * bill's lines and zeroed its total, but its subtotals still name what it
 * charged (review, 10/14: RV 09's move-in bill billed $495.00 rent + $0.42
 * electric on 9/16; the 9/18 void deleted both lines, never paid). One rule
 * for a bill voided before 10/12 and after: a voided $40.00 line and a voided
 * bill's $40.00 subtotal are the same record that somebody was billed. A
 * tenant's report that they paid at the bank (tenant_declared_deposits —
 * deleted with the lease otherwise); a deposit record holding money (anything collected, carried
 * from another lease, FlexDeposit, interest accrued, a return or installment
 * on it); a credit, prepaid credit, credit use, deposit return, FlexPay or
 * On-Time Pay advance, remittance, paid-ahead or shortened-stay choice,
 * one-off charge or propane fill on it; a work-trade period on its bills that
 * settled or credited anything; a books entry or opening item on it; a GAM
 * charge to the landlord for it.
 */
export type MoneyRule = 'billed' | 'paid'

/** The money a charge row's or a bill's own amount shows (see leaseMoneyTouchedSql's `rule`). */
const BILL_SUBTOTALS = `(mi.subtotal_rent + mi.subtotal_fees + mi.subtotal_utilities + mi.subtotal_deposits
                        + mi.subtotal_late_fees + mi.subtotal_home_payments)`

/**
 * `rule` — 'billed' (everywhere): billing somebody is money, voided or not
 * (Nic, 10/13: "a lease the landlord signed that billed someone stays on
 * record"). 'paid': ONLY the one-time cleanup, for a document Nic named after
 * seeing what it billed (scripts/oct14_erase_documents --erase-voided-unpaid):
 * a line or bill VOIDED before anything was paid on it is not money; every
 * other fact above still is.
 */
export function leaseMoneyTouchedSql(l: string, rule: MoneyRule = 'billed'): string {
  l = leaseRef(l)
  const billedLine = rule === 'billed' ? 'mp.amount <> 0' : `(mp.amount <> 0 AND mp.status <> 'voided')`
  const billedBill = rule === 'billed'
    ? `(mi.total_amount <> 0 OR ${BILL_SUBTOTALS} <> 0 OR mi.work_trade_credit_amount <> 0)`
    : `(mi.work_trade_credit_amount <> 0 OR (mi.status <> 'void' AND (mi.total_amount <> 0 OR ${BILL_SUBTOTALS} <> 0)))`
  const onPayment = (t: string, c = 'payment_id') => `EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = mp.id)`
  const onLease = (t: string, c = 'lease_id') => `EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = ${l})`
  return `(EXISTS (SELECT 1 FROM payments mp
             WHERE (mp.lease_id = ${l}
                    OR mp.invoice_id IN (SELECT mi.id FROM invoices mi WHERE mi.lease_id = ${l})
                    OR mp.id IN (SELECT mb.payment_id FROM utility_bills mb
                                  WHERE mb.lease_id = ${l} AND mb.payment_id IS NOT NULL))
               AND (${billedLine}
                    OR mp.status IN ('processing', 'paid_via_deposit', 'returned')
                    OR ${paymentTriedSql('mp')}
                    OR COALESCE(mp.issued_credit_amount, 0) <> 0
                    OR COALESCE(mp.work_trade_credit, 0) <> 0
                    OR COALESCE(mp.gam_supersedence_amount, 0) <> 0
                    OR mp.released_by_deposit_return_id IS NOT NULL
                    OR mp.work_trade_settlement_id IS NOT NULL
                    OR mp.flexpay_advance_id IS NOT NULL
                    OR ${onPayment('bank_transactions', 'matched_payment_id')}
                    OR ${onPayment('bank_deposit_allocations')}
                    OR ${onPayment('payment_reversals')}
                    OR ${onPayment('connect_disputes')}
                    OR ${onPayment('deposit_returns', 'gap_payment_id')}
                    OR ${onPayment('deposit_returns', 'refund_payment_id')}
                    OR ${onPayment('flex_charge_statements')}
                    OR ${onPayment('flex_deposit_custody_charges')}
                    OR ${onPayment('flex_deposit_installments')}
                    OR ${onPayment('flexpay_advances', 'fee_payment_id')}
                    OR ${onPayment('flexpay_advances', 'rent_payment_id')}
                    OR ${onPayment('lease_prepaid_credit_draws')}
                    OR ${onPayment('lease_prepaid_credits', 'source_payment_id')}
                    OR ${onPayment('otp_advances', 'advance_payment_id')}
                    OR ${onPayment('otp_advances', 'reconciled_with_payment_id')}
                    OR ${onPayment('propane_fill_installments')}
                    OR ${onPayment('stay_refund_parts', 'deposit_payment_id')}
                    OR ${onPayment('tenant_one_off_charges')}
                    OR ${onPayment('lease_termination_requests', 'fee_payment_id')}
                    OR ${onPayment('landlord_gam_charges', 'source_id')}
                    OR EXISTS (SELECT 1 FROM ledger_posting_lines x
                                WHERE x.payment_id = mp.id AND (x.debit <> 0 OR x.credit <> 0))))
       OR EXISTS (SELECT 1 FROM invoices mi WHERE mi.lease_id = ${l} AND ${billedBill})
       OR EXISTS (SELECT 1 FROM utility_bills mb WHERE mb.lease_id = ${l} AND COALESCE(mb.charge_amount, 0) <> 0)
       OR EXISTS (SELECT 1 FROM security_deposits ms
                   WHERE (ms.lease_id = ${l} OR ms.portability_target_lease_id = ${l})
                     AND (COALESCE(ms.collected_amount, 0) <> 0
                          OR ms.carried_from_deposit_id IS NOT NULL
                          OR COALESCE(ms.flex_deposit_enabled, FALSE)
                          OR EXISTS (SELECT 1 FROM deposit_returns x WHERE x.security_deposit_id = ms.id)
                          OR EXISTS (SELECT 1 FROM flex_deposit_installments x WHERE x.security_deposit_id = ms.id)
                          OR EXISTS (SELECT 1 FROM security_deposits x WHERE x.carried_from_deposit_id = ms.id)))
       OR ${onLease('security_deposit_interest_accruals')}
       OR ${onLease('tenant_credits')}
       OR ${onLease('lease_prepaid_credits')}
       OR ${onLease('lease_prepaid_credits', 'received_lease_id')}
       OR ${onLease('lease_prepaid_credit_draws')}
       OR ${onLease('credit_uses')}
       OR ${onLease('deposit_returns')}
       OR ${onLease('flexpay_advances')}
       OR ${onLease('otp_advances')}
       OR ${onLease('tenant_remittances')}
       OR ${onLease('tenant_declared_deposits')}
       OR ${onLease('paid_ahead_choices')}
       OR ${onLease('stay_shortened_charge_choices')}
       OR ${onLease('tenant_one_off_charges')}
       OR ${onLease('propane_fills')}
       OR ${onLease('journal_entry_lines')}
       OR ${onLease('books_opening_items')}
       OR ${onLease('landlord_gam_charges', 'source_id')}
       OR EXISTS (SELECT 1 FROM ledger_posting_lines x WHERE x.lease_id = ${l} AND (x.debit <> 0 OR x.credit <> 0))
       OR EXISTS (SELECT 1 FROM work_trade_settlements w
                   WHERE w.invoice_id IN (SELECT mi.id FROM invoices mi WHERE mi.lease_id = ${l})
                     AND (w.status NOT IN ('open', 'voided')
                          OR COALESCE(w.credit_applied, 0) <> 0 OR COALESCE(w.hours_applied, 0) <> 0)))`
}

/**
 * Whether OTHER RECORDS live on lease `l` besides the paperwork being erased
 * (`d`, the lease_documents alias of the document that issued it, and its
 * packet's unfinished forms): another document on it (or a completed form of
 * the packet), a lease that follows it, a sublease or sublessee invite on it,
 * a termination, entry or inspection, a notice, a complaint, an uploaded
 * document, insurance, a stay checkout or a seasonal hold, a renewal request,
 * a bill voided from it, a service agreement it replaced, or a home sale not
 * papered in its own packet. Any of these keeps the lease — and so the
 * document — on record.
 */
export function leaseInUseSql(l: string, d = 'd'): string {
  l = leaseRef(l)
  d = alias(d)
  const onLease = (t: string, c = 'lease_id') => `EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = ${l})`
  return `(EXISTS (SELECT 1 FROM lease_documents o
                    WHERE (o.lease_id = ${l} OR o.renews_lease_id = ${l}) AND o.id <> ${d}.id
                      AND (o.status = 'completed' OR ${d}.package_group_id IS NULL
                           OR o.package_group_id IS DISTINCT FROM ${d}.package_group_id))
       OR ${onLease('leases', 'supersedes_lease_id')}
       OR ${onLease('subleases', 'master_lease_id')}
       OR ${onLease('sublessee_invitations', 'master_lease_id')}
       OR ${onLease('lease_termination_requests')}
       OR ${onLease('unit_entry_requests')}
       OR ${onLease('unit_inspections')}
       OR ${onLease('lease_notices')}
       OR ${onLease('tenant_complaints')}
       OR ${onLease('documents')}
       OR ${onLease('liability_insurance_policies')}
       OR ${onLease('stay_checkout_decisions')}
       OR ${onLease('seasonal_tenancies')}
       OR ${onLease('lease_renewal_requests')}
       OR ${onLease('invoices', 'voided_from_lease_id')}
       OR ${onLease('utility_service_agreements', 'superseded_by_lease_id')}
       OR EXISTS (SELECT 1 FROM home_sale_contracts x
                   WHERE x.lease_id = ${l}
                     AND (${saleStartedSql('x')}
                          OR NOT EXISTS (SELECT 1 FROM lease_documents xd
                                          WHERE xd.id = x.purchase_document_id
                                            AND xd.package_group_id = ${d}.package_group_id))))`
}

/**
 * The lease document `a` ISSUED (the landlord's signature, S647) or built —
 * the lease an erase takes with it. Only an original lease: any other
 * document the landlord's signature put into effect changed a lease that
 * stays.
 */
function issuedLeaseSql(a: string): string {
  return `(${a}.document_type = 'original_lease' AND ${a}.lease_id IS NOT NULL
           AND (${a}.issued_at IS NOT NULL OR ${a}.finalized_at IS NOT NULL))`
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
export function keptReasonSql(a = 'd', rule: MoneyRule = 'billed'): string {
  a = alias(a)
  // 10/14 (Nic, #2): a resident's signature alone no longer keeps a document
  // ("One co-tenant signed, other never, nothing billed: may be deleted").
  // #1: an open invite no longer keeps one — the erase cancels it.
  //
  // Review 10/14: a lease still in force (its document not voided) is taken
  // back the void's own way before it goes (unwindIssuedLease), and the void
  // refuses any charge row marked paid, processing or paid from a deposit —
  // even a $0.00 one. The same row keeps it here, so the button never says
  // Delete for a press the void would refuse.
  return `CASE
      WHEN ${a}.status = 'completed' THEN 'completed'
      WHEN ${a}.status = 'execution_failed' THEN 'all_signed'
      WHEN ${issuedLeaseSql(a)} AND ${leaseMoneyTouchedSql(`${a}.lease_id`, rule)} THEN 'lease_money'
      WHEN ${issuedLeaseSql(a)} AND ${a}.status <> 'voided'
           AND EXISTS (SELECT 1 FROM payments k WHERE k.lease_id = ${a}.lease_id
                         AND k.status IN ('settled', 'processing', 'paid_via_deposit')) THEN 'lease_money'
      WHEN ${issuedLeaseSql(a)} AND ${leaseInUseSql(`${a}.lease_id`, a)} THEN 'lease_in_use'
      WHEN NOT ${issuedLeaseSql(a)} AND ${a}.issued_at IS NOT NULL THEN 'issued'
      WHEN NOT ${issuedLeaseSql(a)} AND ${a}.finalized_at IS NOT NULL THEN 'applied'
      WHEN EXISTS (SELECT 1 FROM scheduled_lease_changes k
                    WHERE k.source_document_id = ${a}.id AND k.status = 'applied') THEN 'change_applied'
      WHEN EXISTS (SELECT 1 FROM home_sale_contracts k
                    WHERE k.purchase_document_id = ${a}.id AND ${saleStartedSql('k')}) THEN 'sale_started'
      WHEN EXISTS (SELECT 1 FROM subleases k WHERE k.sublease_document_id = ${a}.id
                     AND ${subleaseStartedSql('k')}) THEN 'sublease'
      WHEN EXISTS (SELECT 1 FROM lease_tenants k
                    WHERE (k.add_document_id = ${a}.id AND k.status NOT IN ('pending_add','void'))
                       OR (k.remove_document_id = ${a}.id AND k.status NOT IN ('pending_remove','active'))
                       OR (k.add_document_id = ${a}.id
                           AND EXISTS (SELECT 1 FROM lease_documents ko
                                        WHERE ko.id <> ${a}.id
                                          AND (ko.target_lease_tenant_id = k.id OR ko.promote_lease_tenant_id = k.id)))) THEN 'roster_changed'
      WHEN EXISTS (SELECT 1 FROM lease_notices k WHERE k.source_document_id = ${a}.id) THEN 'notice_delivered'
      WHEN EXISTS (SELECT 1 FROM home_ownerships k WHERE k.sale_document_id = ${a}.id) THEN 'home_owned'
      ELSE NULL
    END`
}

/**
 * Whether the sublease `k` (a subleases alias) ever started: active (its
 * agreement completed — services/subleaseDocuments), or a sublessor balance
 * was opened on it. A request still waiting (pending_invite, pending,
 * awaiting_signatures — or canceled before it began) never started. One test
 * for what keeps a document and for what the erase may delete.
 */
function subleaseStartedSql(k: string): string {
  k = alias(k)
  return `(${k}.status = 'active'
           OR EXISTS (SELECT 1 FROM sublessor_credit_balances kb WHERE kb.sublease_id = ${k}.id))`
}

/**
 * keptReasonSql, plus the packet: a packet's lease is kept when another
 * document still open in its packet is kept (it would be stranded without its
 * lease). Erased with the lease otherwise.
 */
export function documentKeptReasonSql(a = 'd', rule: MoneyRule = 'billed'): string {
  a = alias(a)
  return `COALESCE(${keptReasonSql(a, rule)},
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
  | {
      erased: true; documents: ErasedDocument[]; files: string[]
      /** The lease the document issued, erased with it (10/14, #8) — or null. */
      leaseId: string | null
    }
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
export interface EraseOptions {
  onlyVoided?: boolean; protectedIds?: readonly string[]
  /** The one-time cleanup only: documents Nic named after seeing what they
   *  billed, judged by MoneyRule 'paid' (a bill voided unpaid is no money). */
  voidedUnpaidIds?: readonly string[]
  /**
   * 10/14 afternoon (Nic): GAM is ending the document ON ITS OWN — the
   * 48-hour timeout, a lapsed new lease, the 30-day step, the draft a new
   * invite makes stale. "invite and signing by tenant is one flow after
   * landlord has already signed": every invite waiting on it, or reopened by
   * taking back the lease it issued, stays OPEN and lets go of it, to be
   * drafted again. Only the landlord's own Delete closes an invite (#1).
   */
  onItsOwn?: boolean
}

export async function planErase(
  q: Q, documentId: string, opts: EraseOptions = {},
): Promise<EraseOutcome> {
  const doc = (await q(
    `SELECT d.id, d.title, d.status, d.document_type, d.package_group_id,
            d.base_pdf_url, d.executed_pdf_url,
            CASE WHEN ${issuedLeaseSql('d')} THEN d.lease_id END AS issued_lease_id,
            ${documentKeptReasonSql('d', opts.onlyVoided && opts.voidedUnpaidIds?.includes(documentId) ? 'paid' : 'billed')} AS why
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
    leaseId: doc.issued_lease_id ?? null,
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
    `SELECT id, document_type, package_group_id, status, issued_at, lease_id, unit_id
       FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
  if (!live) throw new AppError(404, 'Document not found')
  if (live.document_type === 'original_lease' && live.package_group_id) {
    await q(
      `SELECT id FROM lease_documents WHERE package_group_id = $1 AND id <> $2 ORDER BY id FOR UPDATE`,
      [live.package_group_id, live.id])
  }
  // The lease it issued, last in the void's order (household, document, its
  // rows): every writer of the household's money holds the household lock, so
  // the judgment below reads that lease's money as committed.
  if (live.lease_id) await q(`SELECT id FROM leases WHERE id = $1 FOR UPDATE`, [live.lease_id])
  const plan = await planErase(q, doc.id, opts)
  if (!plan.erased) return plan

  // 10/14 (Nic, #8 and #6): the lease it issued goes too — no money touched it
  // (leaseMoneyTouchedSql). First, inside a savepoint: a record nothing above
  // foresaw that still points at the lease (the database refuses the delete)
  // keeps the lease AND the document, in words, and the caller voids it as
  // before — never a half-erased document.
  if (plan.leaseId) {
    await q('SAVEPOINT erase_issued_lease')
    try {
      await eraseLeaseRows(q, plan.leaseId, live, { onItsOwn: opts.onItsOwn })
      await q('RELEASE SAVEPOINT erase_issued_lease')
    } catch (e: any) {
      await q('ROLLBACK TO SAVEPOINT erase_issued_lease')
      if (e?.code === '23503') return kept('lease_in_use')
      // The void's own refusal while taking the lease back (money it counts
      // that this test did not): the void refuses it the same way.
      if (e instanceof AppError) return kept('lease_money')
      throw e
    }
  }

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
    // 10/14 (Nic, #1): "Delete a lease an open invite waits on: cancel the
    // invite too." Canceled exactly as the landlord's own Cancel does
    // (routes/landlords DELETE /me/pending-tenants/:intentId): stamped, with
    // the same company's screening-waiver row beside it, so the link stops
    // working and the hourly re-draft never drafts a new lease for it. A
    // closed invite only lets go of it. 10/14 afternoon (Nic): only the
    // landlord's own Delete — when GAM ends it on its own (opts.onItsOwn) the
    // invite stays open and only lets go of it, so the hourly re-draft
    // drafts the household again.
    if (!opts.onItsOwn) await cancelOpenInvites(q, d.id)
    await q(
      `UPDATE pending_tenant_intents SET draft_document_id = NULL, updated_at = NOW()
        WHERE draft_document_id = $1`, [d.id])
    // 10/14 (Nic, #3): "Delete an unsigned sublease agreement: delete the
    // sublease request too." The request row goes; the sublessee's invite it
    // came from STAYS (a person and their address — keep-everything), let go
    // of the request and canceled, the way #1 cancels an invite: its link
    // stops working. One statement (each row names the other). A request that
    // started keeps the document (subleaseStartedSql), so none is left here.
    await q(
      `WITH s AS (
         DELETE FROM subleases k WHERE k.sublease_document_id = $1 AND NOT ${subleaseStartedSql('k')}
         RETURNING k.id, k.sublessee_invitation_id)
       UPDATE sublessee_invitations i
          SET sublease_id = NULL, status = 'cancelled', cancelled_at = COALESCE(i.cancelled_at, NOW()), updated_at = NOW()
        WHERE i.id IN (SELECT sublessee_invitation_id FROM s) OR i.sublease_id IN (SELECT id FROM s)`, [d.id])
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
 * Cancel every OPEN invite waiting on document `documentId` (10/14, Nic #1),
 * the landlord's own Cancel exactly: cancelled_at stamped (nothing deleted —
 * the person and their invite stay on record), and the same company's
 * screening-waiver row beside it closed (S639). Returns the invites canceled.
 */
export async function cancelOpenInvites(q: Q, documentId: string): Promise<string[]> {
  const open = (await q(
    `SELECT id FROM pending_tenant_intents
      WHERE draft_document_id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL`, [documentId])).rows
  return cancelInvites(q, open.map((r: any) => r.id as string))
}

/** Cancel these invites if still open — the landlord's own Cancel (see cancelOpenInvites). */
async function cancelInvites(q: Q, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return []
  const ids = (await q(
    `UPDATE pending_tenant_intents
        SET cancelled_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL AND cancelled_at IS NULL
      RETURNING id`, [candidates])).rows.map((r: any) => r.id as string)
  if (ids.length) {
    await q(
      `UPDATE pending_tenant_intents w
          SET cancelled_at = NOW(), updated_at = NOW()
         FROM pending_tenant_intents src
        WHERE src.id = ANY($1::uuid[])
          AND w.tenant_id = src.tenant_id
          AND w.landlord_id = src.landlord_id
          AND w.unit_id IS NULL AND w.screening_waived
          AND w.resolved_at IS NULL AND w.cancelled_at IS NULL`, [ids])
  }
  return ids
}

/**
 * 10/14 (Nic, #8 "delete it"; #6 "delete the paperwork and the never-signed
 * lease record") — ERASE A LEASE NO MONEY TOUCHED, with every row of it.
 * Only after leaseMoneyTouchedSql and leaseInUseSql said so, under the
 * household lock, inside the caller's transaction (the caller's savepoint
 * turns a row nothing foresaw into a refusal).
 *
 *   - Its utility bills ($0.00 — more is money): a held charge released onto
 *     one goes back on hold, as the void does; the bills go.
 *   - `issuedBy`, a document whose landlord signature issued it and that was
 *     never voided: what issuing did is taken back first, the void's own way
 *     (unwindIssuedLease — the household's deposit record and anything that
 *     moved onto a renewal goes back, the work-trade agreement ends, the
 *     space is freed, the invite reopens; the erase then cancels it). One
 *     already voided was taken back then (RV 09, 9/18).
 *     Review 10/14: the invite the unwind reopens is canceled after it (#1),
 *     even one that never pointed at the document (a lease hand-drafted on
 *     GoldSign for an invited household) — otherwise the hourly re-draft
 *     would draft and send a new lease for the lease just deleted. 10/14
 *     afternoon (Nic): only for the landlord's own Delete. GAM ending it on
 *     its own (`opts.onItsOwn`) leaves the reopened invite open, and the
 *     re-draft drafts the household again — that is the flow.
 *   - Its charge rows, all $0.00 with nothing paid, credited or settled; its
 *     bills; a work-trade period on them that never credited anything; a
 *     deposit record that never held a dollar; the bell notifications that
 *     only point at it; the lease row — and with it (ON DELETE CASCADE) its
 *     people, fees, history, occupants, pets, vehicles, rent parts and
 *     utility assignments.
 *   - Review 10/14: the credit-history marks that name it — "signed a lease"
 *     (issuance writes one for the tenant and one for the landlord) and any
 *     mark on its bills or lines — are WITHDRAWN, record kept: each points at
 *     itself, 'withdrawn_no_lease', so it stops counting anywhere. Nic's rule
 *     for a mark whose bill is gone (10/13, "withdrawn: no bill",
 *     scripts/oct12_rerate_late_marks); a lease that never came to be is not
 *     a lease signed. The nightly score run recounts.
 * The person stays (a tenant row is a person, not paperwork), and so does
 * the change journal's copy of every row (audit_row_changes).
 */
export async function eraseLeaseRows(
  q: Q, leaseId: string,
  issuedBy?: { id: string; status: string; issued_at: string | Date | null; unit_id: string | null } | null,
  opts: Pick<EraseOptions, 'onItsOwn'> = {},
): Promise<void> {
  const bills = (await q(
    `SELECT id, payment_id FROM utility_bills WHERE lease_id = $1`, [leaseId])).rows
  const billIds = bills.map((b: any) => b.id as string)
  const billCharges = bills.map((b: any) => b.payment_id).filter(Boolean) as string[]
  if (billIds.length) {
    await q(
      `UPDATE suspended_utility_charges
          SET released_at = NULL, released_bill_id = NULL, updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || 'held again: the lease it was released onto was deleted'
        WHERE released_bill_id = ANY($1::uuid[])`, [billIds])
    await q(`DELETE FROM utility_bills WHERE id = ANY($1::uuid[])`, [billIds])
  }
  if (issuedBy && issuedBy.status !== 'voided' && issuedBy.issued_at) {
    const resolved = (await q(
      `SELECT id FROM pending_tenant_intents WHERE resolved_lease_id = $1 AND cancelled_at IS NULL`,
      [leaseId])).rows.map((r: any) => r.id as string)
    await unwindIssuedLease(q, { id: issuedBy.id, lease_id: leaseId, issued_at: issuedBy.issued_at, unit_id: issuedBy.unit_id })
    if (!opts.onItsOwn) await cancelInvites(q, resolved)
  }
  const invoices = (await q(
    `SELECT id FROM invoices WHERE lease_id = $1`, [leaseId])).rows.map((r: any) => r.id as string)
  const charges = (await q(
    `SELECT id FROM payments WHERE lease_id = $1 OR invoice_id = ANY($2::uuid[]) OR id = ANY($3::uuid[])`,
    [leaseId, invoices, billCharges])).rows.map((r: any) => r.id as string)
  await q(creditMarksOfLeaseSql('UPDATE'), [leaseId, charges, billKeysOf(invoices, charges)])
  if (invoices.length) {
    await q(
      `DELETE FROM work_trade_settlements WHERE invoice_id = ANY($1::uuid[]) AND status IN ('open', 'voided')`, [invoices])
  }
  await q(`DELETE FROM payments WHERE id = ANY($1::uuid[])`, [charges])
  if (invoices.length) await q(`DELETE FROM invoices WHERE id = ANY($1::uuid[])`, [invoices])
  await q(`DELETE FROM security_deposits WHERE lease_id = $1`, [leaseId])
  await q(
    `DELETE FROM notifications WHERE data->>'leaseId' = $1::text OR data->>'lease_id' = $1::text`, [leaseId])
  await q(`DELETE FROM leases WHERE id = $1`, [leaseId])
}

/** A bill mark's key: an invoice's id, or 'row:' + a charge on no invoice (services/creditBillMarks). */
export function billKeysOf(invoices: string[], charges: string[]): string[] {
  return [...invoices, ...charges.map(c => `row:${c}`)]
}

/**
 * The live credit-history marks that name a lease ($1), its charge rows
 * ($2::text[]) or its bills ($3::text[], billKeysOf) — 'SELECT' lists them
 * (the cleanup's dry run), 'UPDATE' withdraws them (eraseLeaseRows).
 */
export function creditMarksOfLeaseSql(op: 'SELECT' | 'UPDATE'): string {
  const where = `superseded_by IS NULL
         AND (event_data->>'lease_id' = $1::text
              OR event_data->>'payment_id' = ANY($2::text[])
              OR event_data->>'bill_key' = ANY($3::text[]))`
  return op === 'SELECT'
    ? `SELECT id, event_type FROM credit_events WHERE ${where} ORDER BY recorded_at, id`
    : `UPDATE credit_events SET superseded_by = id, superseded_reason = 'withdrawn_no_lease' WHERE ${where}`
}

/**
 * After COMMIT: remove each erased document's file from storage when nothing
 * else names it any more — a template's PDF, a library form and another
 * document drafted from the same paper all keep it. Best-effort: a file that
 * cannot be removed is left (and returned in `left`), never a reason to undo
 * the erase. Returns what was removed.
 */
export async function removeOrphanedDocumentFiles(
  q: Q, urls: string[],
  driver: StorageDriver = storage,
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
    const key = uploadKeyFromStored('leases', url)
    try {
      if (key && await driver.exists(key)) { await driver.remove(key); removed.push(url) }
    } catch {
      left.push(url)
    }
  }
  return { removed, left }
}
