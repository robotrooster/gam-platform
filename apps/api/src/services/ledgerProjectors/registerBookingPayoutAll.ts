/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: THE REGISTER, BOOKING AND PAYOUT-CHAIN SET
 *
 * Everything phase P5 posts, for services/ledgerProjectors.ts
 * (registerProductionLedgerProjectors) to register when the phase goes live,
 * and its nightly tie-outs for services/ledgerCheck (registerLedgerCheck):
 *
 *   pos_sale          registerSale        F1, F2 (+ cost per item sold, Nic L8)
 *   pos_refund        registerRefund      F3 (+ card fees refunded, Nic G10)
 *   pos_held          registerHeld        F5
 *   booking           bookingStay         F6 + stays earned on arrival / month by month (Nic L10)
 *   allocation        payoutAllocation    G1 (+ the cut GAM held too little to pay, Nic L18)
 *   held_item         payoutHeldItem      G4, E2, F4
 *   transfer_intent   payoutTransfer      G2, G2b, H6
 *   disbursement      payoutDisbursement  G3
 *   connect_payout    payoutDisbursement  (a PM company's payout: nothing on a landlord's book)
 *   instant_margin    payoutDisbursement  G3 (GAM's instant-payout margin)
 *   gam_charge        payoutGamCharges    H1, H2, H3 (+ Nic G1 failed-pull cost, G5 uncovered fee)
 *   gam_debit         payoutGamCharges    H5
 *   reader_order      payoutGamCharges    nothing on the landlord's books (10/13, Nic: each piece is
 *                                         a Supplies expense when GAM collects it — design Q11)
 *   property_transfer propertyHandover    G5 (a sale that moved leases or deposits waits for the amounts
 *                                         handed over to be recorded; G6 / Nic L17 is payoutAllocation's)
 *
 * 10/13 (Nic) answered design Q11 for the landlord's books: "Readers on the
 * LANDLORD's books: each $87.50 → SUPPLIES, in the month GAM COLLECTED it."
 * The reader is never equipment the landlord owns (no 1530 / 2085, design
 * H4), so its order posts nothing; each piece is expensed by the batch or
 * pull that collected it (payoutTransfer, payoutGamCharges).
 */
import type { LedgerProjector } from '../ledgerEngine'
import type { LedgerCheck } from '../ledgerCheck'
import { registerSaleProjector } from './registerSale'
import { registerRefundProjector } from './registerRefund'
import { registerHeldProjector } from './registerHeld'
import { bookingStayProjector } from './bookingStay'
import { payoutAllocationProjector } from './payoutAllocation'
import { payoutHeldItemProjector } from './payoutHeldItem'
import { payoutTransferProjector } from './payoutTransfer'
import { payoutDisbursementProjector, payoutConnectPayoutProjector, payoutInstantMarginProjector } from './payoutDisbursement'
import { payoutGamChargeProjector, payoutGamDebitProjector, readerOrderProjector } from './payoutGamCharges'
import { propertyTransferProjector } from './propertyHandover'
import { stripeInTransitCheck, dueToGamCheck } from './payoutChecks'

export const P5_LEDGER_PROJECTORS: readonly LedgerProjector[] = [
  registerSaleProjector,
  registerRefundProjector,
  registerHeldProjector,
  bookingStayProjector,
  payoutAllocationProjector,
  payoutHeldItemProjector,
  payoutTransferProjector,
  payoutDisbursementProjector,
  payoutConnectPayoutProjector,
  payoutInstantMarginProjector,
  payoutGamChargeProjector,
  payoutGamDebitProjector,
  readerOrderProjector,
  propertyTransferProjector,
]

export const P5_LEDGER_CHECKS: readonly LedgerCheck[] = [stripeInTransitCheck, dueToGamCheck]
