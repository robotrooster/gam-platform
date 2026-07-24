---
scope: landlord
title: "Using Point of Sale: Sales, Inventory & Staff Permissions"
---
GAM's Point of Sale runs your on-site store — camp store, laundry, parking, propane counter — with a register, item catalog, and sales history, all per property.

## Ringing sales

On the **Register** tab, the cashier taps catalog items into the cart (or adds a free-form walk-up item with a typed name and price) and takes payment by **cash or card**. Card payments run through a paired Stripe Terminal card reader. Tax is calculated server-side from your tax categories and rates, discounts can be applied (including by code), and each sale is recorded against the property with a receipt. An in-progress cart survives a crash or handoff — you can resume or discard the open tab.

## Refunds, voids, and permissions

Staff access is controlled by per-user permission toggles, enforced on the server:

- **Ring sales** — use the register.
- **Issue refunds** — refunds require their own grant; the cashier records the amount, a reason, and whether it went back as cash or check.
- **Void transactions** — separate from refunds.
- **Apply discounts**, **End-of-day close**, and **Manage inventory** are each their own toggle.

A manager can hold refund and void rights while a new employee only rings sales. Staff locked to specific properties can only ring sales at those properties.

## Stock and purchasing

POS items belong to a property and carry stock counts: stock decrements as items sell, low-stock items are flagged, and selling below your reorder point can auto-draft a **purchase order** to the item's vendor. Receiving a purchase order restocks the items. Items are organized into categories, can have variants, and price changes are logged with who made them.

Note that the separate **Inventory** page in the landlord portal tracks business-use supplies (cleaning products, parts, toiletries) and equipment service schedules — that's not your POS resale stock, which lives in the POS management tabs.

## Sales history

The **History** and sales views show transactions and analytics per property — totals, sales by day and hour, top items, and category breakdowns.
