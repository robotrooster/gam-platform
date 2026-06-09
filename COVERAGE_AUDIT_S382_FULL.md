# Route-test coverage audit per file

| File | Mount | Routes | Covered | Uncovered | % | Lines |
|---|---|---:|---:|---:|---:|---:|
| `books.ts` | `/api/books` | 40 | 0 | 40 | 0% | 1331 |
| `background.ts` | `/api/background` | 25 | 0 | 25 | 0% | 1066 |
| `pos.ts` | `/api/pos` | 55 | 32 | 23 | 58% | 1850 |
| `maintenance-portal.ts` | `/api/maint-portal` | 17 | 0 | 17 | 0% | 249 |
| `esign.ts` | `/api/esign` | 25 | 9 | 16 | 36% | 2533 |
| `credit.ts` | `/api/credit` | 16 | 0 | 16 | 0% | 840 |
| `pm.ts` | `/api/pm` | 23 | 9 | 14 | 39% | 1101 |
| `utility.ts` | `/api/utility` | 12 | 0 | 12 | 0% | 388 |
| `properties.ts` | `/api/properties` | 17 | 8 | 9 | 47% | 1031 |
| `units.ts` | `/api/units` | 17 | 8 | 9 | 47% | 540 |
| `landlords.ts` | `/api/landlords` | 55 | 47 | 8 | 85% | 3822 |
| `workTrade.ts` | `/api/work-trade` | 8 | 0 | 8 | 0% | 332 |
| `leases.ts` | `/api/leases` | 15 | 9 | 6 | 60% | 982 |
| `notifications.ts` | `/api/notifications` | 6 | 0 | 6 | 0% | 85 |
| `bulletin.ts` | `/api/bulletin` | 5 | 0 | 5 | 0% | 262 |
| `reports.ts` | `/api/reports` | 5 | 0 | 5 | 0% | 490 |
| `stripe.ts` | `/api/stripe` | 5 | 0 | 5 | 0% | 280 |
| `bankAccounts.ts` | `/api/bank-accounts` | 4 | 0 | 4 | 0% | 130 |
| `payments.ts` | `/api/payments` | 4 | 0 | 4 | 0% | 430 |
| `terminal.ts` | `` | 4 | 0 | 4 | 0% | 67 |
| `auth.ts` | `/api/auth` | 10 | 7 | 3 | 70% | 567 |
| `scopes.ts` | `/api/scopes` | 10 | 7 | 3 | 70% | 746 |
| `posCustomerOnboarding.ts` | `/api/pos-customer-onboarding` | 3 | 0 | 3 | 0% | 254 |
| `inspections.ts` | `/api/inspections` | 9 | 7 | 2 | 77% | 652 |
| `subleases.ts` | `/api/subleases` | 7 | 5 | 2 | 71% | 785 |
| `subleaseInvitations.ts` | `/api/sublease-invitations` | 2 | 0 | 2 | 0% | 270 |
| `withdrawals.ts` | `/api/users` | 2 | 0 | 2 | 0% | 182 |
| `tenants.ts` | `/api/tenants` | 40 | 39 | 1 | 97% | 1364 |
| `maintenance.ts` | `/api/maintenance` | 7 | 6 | 1 | 85% | 391 |
| `entryRequests.ts` | `/api/entry-requests` | 6 | 5 | 1 | 83% | 449 |
| `announcements.ts` | `/api/announcements` | 1 | 0 | 1 | 0% | 21 |
| `disbursements.ts` | `/api/disbursements` | 1 | 0 | 1 | 0% | 46 |
| `documents.ts` | `/api/documents` | 1 | 0 | 1 | 0% | 33 |
| `finances.ts` | `/api/users` | 1 | 0 | 1 | 0% | 139 |
| `admin.ts` | `/api/admin` | 42 | 42 | 0 | 100% | 1530 |
| `totp.ts` | `/api/auth/totp` | 4 | 4 | 0 | 100% | 315 |
| `bookings.ts` | `/api/bookings` | 1 | 1 | 0 | 100% | 105 |
| `webhooks.ts` | `/webhooks` | 1 | 1 | 0 | 100% | 759 |
| `fitness.ts` | `` | 0 | 0 | 0 | 0% | 216 |
| **TOTAL** | — | **506** | **246** | **260** | **48%** | — |

# Uncovered routes per file

## books.ts — 40 uncovered of 40
- `GET   ` `/api/books/accounts`
- `POST  ` `/api/books/accounts`
- `PATCH ` `/api/books/accounts/:id`
- `DELETE` `/api/books/accounts/:id`
- `POST  ` `/api/books/accounts/seed`
- `GET   ` `/api/books/employees`
- `POST  ` `/api/books/employees`
- `PATCH ` `/api/books/employees/:id`
- `GET   ` `/api/books/contractors`
- `POST  ` `/api/books/contractors`
- `PATCH ` `/api/books/contractors/:id`
- `GET   ` `/api/books/vendors`
- `POST  ` `/api/books/vendors`
- `PATCH ` `/api/books/vendors/:id`
- `GET   ` `/api/books/payroll/runs`
- `GET   ` `/api/books/payroll/runs/:id`
- `POST  ` `/api/books/payroll/runs`
- `POST  ` `/api/books/payroll/runs/:id/approve`
- `POST  ` `/api/books/payroll/runs/:id/void`
- `GET   ` `/api/books/bookkeeper/clients`
- `GET   ` `/api/books/bookkeeper/all`
- `POST  ` `/api/books/bookkeeper/invite`
- `POST  ` `/api/books/bookkeeper/assign`
- `DELETE` `/api/books/bookkeeper/revoke`
- `GET   ` `/api/books/journal`
- `GET   ` `/api/books/journal/:id`
- `POST  ` `/api/books/journal`
- `POST  ` `/api/books/journal/:id/void`
- `GET   ` `/api/books/transactions`
- `POST  ` `/api/books/transactions`
- `PATCH ` `/api/books/transactions/:id/reconcile`
- `GET   ` `/api/books/reports/pl`
- `GET   ` `/api/books/reports/balance-sheet`
- `GET   ` `/api/books/bills`
- `POST  ` `/api/books/bills`
- `POST  ` `/api/books/bills/:id/pay`
- `GET   ` `/api/books/reports/cash-flow`
- `GET   ` `/api/books/reports/owner-statements`
- `GET   ` `/api/books/tax/summary`
- `GET   ` `/api/books/rent-roll`

## background.ts — 25 uncovered of 25
- `GET   ` `/api/background/price`
- `POST  ` `/api/background/payment-intent`
- `POST  ` `/api/background/submit`
- `GET   ` `/api/background/status`
- `GET   ` `/api/background/`
- `GET   ` `/api/background/:id`
- `PATCH ` `/api/background/:id/decision`
- `GET   ` `/api/background/:id/adverse-action`
- `POST  ` `/api/background/:id/cancel`
- `POST  ` `/api/background/upload-id`
- `GET   ` `/api/background/id-files/:filename`
- `GET   ` `/api/background/verify-address`
- `GET   ` `/api/background/suggest-address`
- `POST  ` `/api/background/webhook/:providerName`
- `POST  ` `/api/background/dev-mock-webhook`
- `POST  ` `/api/background/dev-reset`
- `POST  ` `/api/background/pool/withdraw`
- `GET   ` `/api/background/pool/search`
- `GET   ` `/api/background/pool/matches`
- `POST  ` `/api/background/pool/:poolId/reach-out`
- `PATCH ` `/api/background/pool/match/:matchId/respond`
- `POST  ` `/api/background/pool/match/:matchId/payment-intent`
- `POST  ` `/api/background/pool/match/:matchId/purchase-report`
- `GET   ` `/api/background/notifications`
- `PATCH ` `/api/background/notifications/:id/read`

## pos.ts — 23 uncovered of 55
- `GET   ` `/api/pos/items`
- `PATCH ` `/api/pos/items/:id`
- `POST  ` `/api/pos/items/:id/adjust-stock`
- `GET   ` `/api/pos/items/:id/shelf-label`
- `GET   ` `/api/pos/transactions/sales`
- `GET   ` `/api/pos/vendors`
- `POST  ` `/api/pos/vendors`
- `PATCH ` `/api/pos/vendors/:id`
- `GET   ` `/api/pos/purchase-orders`
- `GET   ` `/api/pos/low-stock`
- `GET   ` `/api/pos/categories`
- `PATCH ` `/api/pos/categories/:id`
- `GET   ` `/api/pos/items/:id/variants`
- `POST  ` `/api/pos/items/:id/variants`
- `PATCH ` `/api/pos/items/:id/variants/:variantId`
- `GET   ` `/api/pos/tax-rates`
- `POST  ` `/api/pos/tax-rates`
- `PATCH ` `/api/pos/tax-rates/:id`
- `DELETE` `/api/pos/tax-rates/:id`
- `GET   ` `/api/pos/discounts`
- `POST  ` `/api/pos/discounts`
- `PATCH ` `/api/pos/discounts/:id`
- `GET   ` `/api/pos/transactions`

## maintenance-portal.ts — 17 uncovered of 17
- `POST  ` `/api/maint-portal/shifts/clock-in`
- `POST  ` `/api/maint-portal/shifts/clock-out`
- `GET   ` `/api/maint-portal/shifts/active`
- `GET   ` `/api/maint-portal/tasks`
- `POST  ` `/api/maint-portal/tasks`
- `PATCH ` `/api/maint-portal/tasks/:id/complete`
- `GET   ` `/api/maint-portal/parts`
- `POST  ` `/api/maint-portal/parts`
- `PATCH ` `/api/maint-portal/parts/:id`
- `GET   ` `/api/maint-portal/purchases`
- `POST  ` `/api/maint-portal/purchases`
- `PATCH ` `/api/maint-portal/purchases/:id/approve`
- `PATCH ` `/api/maint-portal/purchases/:id/deny`
- `GET   ` `/api/maint-portal/scheduled`
- `POST  ` `/api/maint-portal/scheduled`
- `PATCH ` `/api/maint-portal/scheduled/:id/complete`
- `GET   ` `/api/maint-portal/work-orders`

## esign.ts — 16 uncovered of 25
- `POST  ` `/api/esign/witnesses/provision`
- `GET   ` `/api/esign/templates`
- `POST  ` `/api/esign/templates`
- `GET   ` `/api/esign/templates/:id`
- `PATCH ` `/api/esign/templates/:id`
- `DELETE` `/api/esign/templates/:id`
- `PUT   ` `/api/esign/templates/:id/fields`
- `DELETE` `/api/esign/templates/:id/fields/:fieldId`
- `GET   ` `/api/esign/documents`
- `GET   ` `/api/esign/batches`
- `POST  ` `/api/esign/documents/addendum-add`
- `POST  ` `/api/esign/documents/addendum-remove`
- `POST  ` `/api/esign/documents/addendum-terms/batch`
- `POST  ` `/api/esign/documents/addendum-terms`
- `POST  ` `/api/esign/upload`
- `GET   ` `/api/esign/files/:filename`

## credit.ts — 16 uncovered of 16
- `GET   ` `/api/credit/subject/own`
- `GET   ` `/api/credit/subject/:subjectId`
- `GET   ` `/api/credit/screening-by-tenant/:tenantId`
- `GET   ` `/api/credit/stats/:subjectId`
- `GET   ` `/api/credit/score/:subjectId`
- `POST  ` `/api/credit/score/:subjectId/recompute`
- `POST  ` `/api/credit/attest`
- `GET   ` `/api/credit/disputes/mine`
- `GET   ` `/api/credit/disputes/:id`
- `GET   ` `/api/credit/disputes`
- `POST  ` `/api/credit/dispute`
- `POST  ` `/api/credit/dispute/:id/evidence`
- `POST  ` `/api/credit/dispute/:id/resolve`
- `POST  ` `/api/credit/hardship-context`
- `GET   ` `/api/credit/integrity/anchors`
- `GET   ` `/api/credit/integrity/verify/:subjectId`

## pm.ts — 14 uncovered of 23
- `GET   ` `/api/pm/companies/:id/fee-plans`
- `PATCH ` `/api/pm/companies/:id/fee-plans/:planId`
- `GET   ` `/api/pm/companies/:id/invitations`
- `POST  ` `/api/pm/companies/:id/invitations/:invId/resend`
- `DELETE` `/api/pm/companies/:id/invitations/:invId`
- `GET   ` `/api/pm/companies/:id/payouts`
- `GET   ` `/api/pm/companies/:id/properties/:propertyId/drilldown`
- `POST  ` `/api/pm/companies/:id/property-invitations`
- `GET   ` `/api/pm/companies/:id/property-invitations`
- `POST  ` `/api/pm/companies/:id/property-invitations/:invId/accept`
- `POST  ` `/api/pm/companies/:id/property-invitations/:invId/reject`
- `DELETE` `/api/pm/companies/:id/property-invitations/:invId`
- `POST  ` `/api/pm/companies/:id/connect/onboarding-link`
- `GET   ` `/api/pm/companies/:id/connect/account-status`

## utility.ts — 12 uncovered of 12
- `GET   ` `/api/utility/bills`
- `GET   ` `/api/utility/meters`
- `POST  ` `/api/utility/meters`
- `PATCH ` `/api/utility/meters/:id`
- `DELETE` `/api/utility/meters/:id`
- `POST  ` `/api/utility/meters/:id/units`
- `DELETE` `/api/utility/meters/:id/units/:unitId`
- `GET   ` `/api/utility/meters/:id/readings`
- `POST  ` `/api/utility/meters/:id/readings`
- `POST  ` `/api/utility/generate-bills`
- `POST  ` `/api/utility/bills/:id/finalize`
- `POST  ` `/api/utility/bills/:id/pay`

## properties.ts — 9 uncovered of 17
- `GET   ` `/api/properties/:id/fee-schedule`
- `DELETE` `/api/properties/:id/fee-schedule/:rowId`
- `GET   ` `/api/properties/:id/eligible-managers`
- `GET   ` `/api/properties/units/:id/photos`
- `POST  ` `/api/properties/units/:id/photos`
- `DELETE` `/api/properties/units/:id/photos/:photoId`
- `PATCH ` `/api/properties/units/:id/listing`
- `GET   ` `/api/properties/applications`
- `POST  ` `/api/properties/:id/units/bulk`

## units.ts — 9 uncovered of 17
- `GET   ` `/api/units/`
- `PATCH ` `/api/units/:id/status`
- `POST  ` `/api/units/:id/eviction-mode`
- `GET   ` `/api/units/:id/economics`
- `PATCH ` `/api/units/:id/type`
- `GET   ` `/api/units/:id/availability`
- `PATCH ` `/api/units/:id/bookings/:bookingId/acknowledge`
- `GET   ` `/api/units/schedule/master`
- `POST  ` `/api/units/:id/cancel-scheduled-activation`

## landlords.ts — 8 uncovered of 55
- `GET   ` `/api/landlords/`
- `GET   ` `/api/landlords/flex-charge/accounts`
- `GET   ` `/api/landlords/flex-charge/accounts/:id/statements`
- `GET   ` `/api/landlords/theme`
- `POST  ` `/api/landlords/me/pending-tenants/:intentId/document`
- `GET   ` `/api/landlords/me/pending-tenants/:intentId/document`
- `GET   ` `/api/landlords/me/pending-tenants/:intentId`
- `POST  ` `/api/landlords/me/pending-tenants/:intentId/resolve`

## workTrade.ts — 8 uncovered of 8
- `POST  ` `/api/work-trade/`
- `GET   ` `/api/work-trade/unit/:unitId`
- `GET   ` `/api/work-trade/:id`
- `POST  ` `/api/work-trade/:id/logs`
- `PATCH ` `/api/work-trade/logs/:logId`
- `POST  ` `/api/work-trade/:id/reconcile`
- `GET   ` `/api/work-trade/`
- `PATCH ` `/api/work-trade/:id`

## leases.ts — 6 uncovered of 15
- `GET   ` `/api/leases/:id/addendums`
- `GET   ` `/api/leases/:id/addendum-pdf/:filename`
- `GET   ` `/api/leases/:id/deposit-return`
- `POST  ` `/api/leases/:id/deposit-return`
- `PATCH ` `/api/leases/:id/deposit-return`
- `POST  ` `/api/leases/:id/deposit-return/finalize`

## notifications.ts — 6 uncovered of 6
- `GET   ` `/api/notifications/`
- `PATCH ` `/api/notifications/:id/read`
- `PATCH ` `/api/notifications/read-all`
- `GET   ` `/api/notifications/preferences`
- `PATCH ` `/api/notifications/preferences`
- `POST  ` `/api/notifications/bulk`

## bulletin.ts — 5 uncovered of 5
- `GET   ` `/api/bulletin/`
- `POST  ` `/api/bulletin/`
- `POST  ` `/api/bulletin/:id/vote`
- `GET   ` `/api/bulletin/:id/reveal`
- `GET   ` `/api/bulletin/landlord`

## reports.ts — 5 uncovered of 5
- `GET   ` `/api/reports/summary`
- `GET   ` `/api/reports/monthly-statement`
- `GET   ` `/api/reports/tax-summary`
- `GET   ` `/api/reports/property-pl`
- `GET   ` `/api/reports/work-trade-1099`

## stripe.ts — 5 uncovered of 5
- `POST  ` `/api/stripe/connect/onboarding-session`
- `GET   ` `/api/stripe/connect/status`
- `POST  ` `/api/stripe/tenant/setup`
- `POST  ` `/api/stripe/tenant/confirm-setup`
- `GET   ` `/api/stripe/tenant/payment-methods`

## bankAccounts.ts — 4 uncovered of 4
- `GET   ` `/api/bank-accounts/`
- `POST  ` `/api/bank-accounts/`
- `PATCH ` `/api/bank-accounts/:id`
- `POST  ` `/api/bank-accounts/:id/archive`

## payments.ts — 4 uncovered of 4
- `GET   ` `/api/payments/`
- `POST  ` `/api/payments/initiate-rent-collection`
- `POST  ` `/api/payments/:id/handle-return`
- `POST  ` `/api/payments/:id/pay`

## terminal.ts — 4 uncovered of 4
- `POST  ` `/connection-token`
- `POST  ` `/create-payment-intent`
- `POST  ` `/capture/:id`
- `POST  ` `/cancel/:id`

## auth.ts — 3 uncovered of 10
- `POST  ` `/api/auth/refresh`
- `PATCH ` `/api/auth/me`
- `POST  ` `/api/auth/register-prospect`

## scopes.ts — 3 uncovered of 10
- `GET   ` `/api/scopes/team`
- `GET   ` `/api/scopes/property_manager/:userId/connect-status`
- `GET   ` `/api/scopes/:roleType`

## posCustomerOnboarding.ts — 3 uncovered of 3
- `GET   ` `/api/pos-customer-onboarding/:token`
- `POST  ` `/api/pos-customer-onboarding/:token/start`
- `POST  ` `/api/pos-customer-onboarding/:token/complete`

## inspections.ts — 2 uncovered of 9
- `POST  ` `/api/inspections/:id/photos`
- `GET   ` `/api/inspections/photo-files/:filename`

## subleases.ts — 2 uncovered of 7
- `GET   ` `/api/subleases/me/credit`
- `POST  ` `/api/subleases/me/credit/withdraw`

## subleaseInvitations.ts — 2 uncovered of 2
- `GET   ` `/api/sublease-invitations/:token`
- `POST  ` `/api/sublease-invitations/:token/accept`

## withdrawals.ts — 2 uncovered of 2
- `GET   ` `/api/users/me/withdrawals/preview`
- `POST  ` `/api/users/me/withdrawals`

## tenants.ts — 1 uncovered of 40
- `DELETE` `/api/tenants/flexdeposit`

## maintenance.ts — 1 uncovered of 7
- `GET   ` `/api/maintenance/stats/summary`

## entryRequests.ts — 1 uncovered of 6
- `GET   ` `/api/entry-requests/`

## announcements.ts — 1 uncovered of 1
- `GET   ` `/api/announcements/`

## disbursements.ts — 1 uncovered of 1
- `GET   ` `/api/disbursements/`

## documents.ts — 1 uncovered of 1
- `GET   ` `/api/documents/`

## finances.ts — 1 uncovered of 1
- `GET   ` `/api/users/me/finances`
