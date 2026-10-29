/**
 * Who a third-party PM company's cut is booked to.
 *
 * 10/12 (Nic): PM cuts were booked to the user behind
 * pm_companies.bank_account_id — a row in GAM's old bank catalog. That catalog
 * no longer takes new rows (POST /api/bank-accounts refuses them; payouts run
 * only through Stripe Connect), and both PM companies in production have it
 * NULL. So the first property contracted to a PM company would have failed
 * every rent allocation (webhook, manual settle, credit use, FlexPay), every
 * monthly PM accrual and every lease finalize with a leasing fee — while the
 * PM acceptance step already requires the company's Stripe Connect account.
 *
 * A legacy catalog bank still wins where one is set. Otherwise the cut is
 * booked to the company's active owner (pm_staff), and the transfer goes to
 * the COMPANY's Connect account — see firePmTransfersForReference in
 * services/stripeConnect.ts, which checks the recipient owns that company.
 *
 * SQL expression. Expects `c` = pm_companies and `ba` = the LEFT JOINed
 * user_bank_accounts row for c.bank_account_id.
 */
export const PM_PAYOUT_USER_SQL = `COALESCE(
  ba.user_id,
  (SELECT s.user_id FROM pm_staff s
    WHERE s.pm_company_id = c.id AND s.role = 'owner' AND s.status = 'active'
    ORDER BY s.joined_at NULLS LAST, s.created_at, s.id
    LIMIT 1))`

/** The error when a PM company has neither a legacy catalog bank nor an active owner. */
export function noPmRecipientMessage(pmCompanyId: string): string {
  return `PM company ${pmCompanyId} has no active owner to book its cut to. ` +
    `Add an owner to the PM company (its cut is paid to the company's Stripe Connect account).`
}
