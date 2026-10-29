/**
 * 10/12 (Nic) — the money GAM holds for a landlord, moves to them, and charges
 * them: one definition for each allowed-value set the database CHECKs, so the
 * code lists and the constraints cannot drift (CLAUDE.md, single source of
 * truth). The ledger design's P0 (gam-ledger-design-2026-10-12 §4, §16) reads
 * every one of these as a fact; none of them is display text.
 */

/**
 * held_payout_items.source_type — mirrors held_payout_items_source_type_check.
 *
 * 'deposit_settlement' was allowed by the table since S655 but missing from the
 * code list (it lived in services/heldPayouts.ts), so the move-out writers
 * (depositReturn finalize, depositRefundSend cash parts) wrote it as raw SQL to
 * get past the type. One list now, here, with every value the table allows.
 */
export const HELD_ITEM_SOURCES = [
  'pos_sale', 'booking_deposit', 'business_invoice_payment',
  'business_pos_sale', 'refund', 'dispute', 'platform_fee', 'prepaid_draw',
  'deposit_settlement',
] as const
export type HeldItemSource = typeof HELD_ITEM_SOURCES[number]

/**
 * platform_transfer_intents.purpose — mirrors platform_transfer_intents_purpose_check.
 *
 *   payout              — the weekly batch of owner shares and held items (S580)
 *   deposit_settlement  — the landlord's share of a GAM-held deposit at move-out
 *                         (services/depositReturn), its own transfer
 *   flexcharge_merchant — a store charge account's merchant share (gated, no rows)
 *
 * Every transfer GAM makes to a landlord's Stripe account is written here
 * BEFORE Stripe is asked to make it, so a payout can always say what it carried.
 */
export const PLATFORM_TRANSFER_PURPOSES = ['payout', 'deposit_settlement', 'flexcharge_merchant'] as const
export type PlatformTransferPurpose = typeof PLATFORM_TRANSFER_PURPOSES[number]

/**
 * landlord_gam_charges.void_reason — mirrors landlord_gam_charges_void_reason_check.
 *
 * A charge GAM raised and then took back is VOIDED, never deleted
 * (keep-everything): the row stays, with when and why.
 *
 *   bank_debit_not_made           — the cost line of a bank pull Stripe refused
 *                                   on the spot (services/landlordGamDebit)
 *   screening_payment_taken_back  — a background check the landlord collected
 *                                   for, whose payment was taken back before
 *                                   it was used (services/stayTerms)
 *   bank_debit_failed             — 10/12 (Nic, G1): the $6 price of a bank
 *                                   pull that was made and then failed or came
 *                                   back; what the failure actually cost is
 *                                   billed instead, at cost (kind
 *                                   'bank_debit_failed_cost', services/landlordGamDebit)
 *   dispute_won                   — 10/13 (Nic, "Won GAM pull dispute:
 *                                   AUTOMATIC"): what a disputed pull cost,
 *                                   taken back when Stripe decided the dispute
 *                                   for GAM (what Stripe kept of its fee, if
 *                                   anything, is billed again on its own)
 *   dispute_cost_rebilled         — 10/13 (Nic, "Dispute fee unknown → bill
 *                                   $15"): what a disputed pull cost, replaced
 *                                   by a new charge once Stripe stated its
 *                                   dispute fee in place of the $15
 */
export const LANDLORD_GAM_CHARGE_VOID_REASONS = [
  'bank_debit_not_made', 'screening_payment_taken_back', 'bank_debit_failed', 'dispute_won', 'dispute_cost_rebilled',
] as const
export type LandlordGamChargeVoidReason = typeof LANDLORD_GAM_CHARGE_VOID_REASONS[number]
