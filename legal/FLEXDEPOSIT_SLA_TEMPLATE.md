# FlexDeposit Service-Level Agreement

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Template Version: 1.0
[Effective Date populated by the Platform at signature]

---

> **WHAT THIS IS.** This FlexDeposit Service-Level Agreement
> (the "**SLA**") sets out the terms of a service-level
> accommodation between you (the "**Tenant**") and **Gold
> Asset Management LLC** ("**GAM**") under which GAM advances
> the amount of your security deposit to your Landlord on your
> behalf at move-in, and you make a schedule of service-fee
> installments to GAM in consideration of that accommodation.
>
> **This SLA is not a loan or extension of credit.** GAM is
> not your creditor and you are not GAM's borrower. The
> substantive characterization, no-recourse posture, payment-
> routing authorization, service-tier consequences for non-
> payment, bankruptcy treatment, and recharacterization
> severability are set out in Section 9.1 of GAM's Consumer
> Terms of Service (the "**Consumer ToS**"), which is
> incorporated into this SLA by reference and which governs
> any matter not expressly addressed in this SLA. Capitalized
> terms used here without definition have the meaning given
> in the Consumer ToS.

---

## 1. Parties and Effective Date

This SLA is between:

- **GAM**: Gold Asset Management LLC, a Delaware limited liability company.
- **Tenant**: {{Tenant_Full_Legal_Name}}, the individual identified by the GAM Platform account at {{Tenant_Email}}.

The Effective Date of this SLA is the date Tenant electronically signs below. By electronically signing, Tenant agrees to the terms of this SLA, acknowledges receipt of the Consumer ToS, and authorizes the ACH-pull schedule set out in Section 4.

## 2. Express Characterization and Intent

The parties expressly agree and intend that this SLA is a service-level agreement only. **This SLA is not, and shall not be construed as, a loan, an extension of consumer credit, a "credit transaction" under the Truth in Lending Act (15 U.S.C. § 1601 et seq.) or Regulation Z (12 C.F.R. Part 1026), an extension of credit under the Equal Credit Opportunity Act (15 U.S.C. § 1691 et seq.) or Regulation B (12 C.F.R. Part 1002), a consumer financial product or service under the Consumer Financial Protection Act (12 U.S.C. § 5481 et seq.), a debt under the Fair Debt Collection Practices Act (15 U.S.C. § 1692 et seq.), or a "loan" or "extension of credit" under the consumer-finance, consumer-installment-loan, small-loan, or usury statutes of any state.**

The Advance described in Section 3 is a service-level accommodation, not a loan. The service-fee installments described in Section 4 are consideration for the accommodation, not repayment of principal or interest. **No debt is created by this SLA**, and Tenant has no enforceable obligation to repay any amount to GAM. The parties' rights and obligations are limited to what is expressly set out in this SLA and in Consumer ToS § 9.1.

## 3. The Advance

In consideration of Tenant's agreement to this SLA, GAM, in its sole discretion and as a service-level accommodation, advances **${{Advance_Amount}}** (the "**Advance**") to {{Landlord_Display_Name}}'s pooled-custody account on the Platform on Tenant's behalf, on or before {{Move_In_Date}}, to satisfy the security-deposit obligation associated with Tenant's lease at {{Property_Address}}, Unit {{Unit_Number}}.

The Advance is not a loan to Tenant. GAM does not bill Tenant for principal or interest on the Advance, does not charge a finance charge as that term is defined in 12 C.F.R. § 1026.4, does not record the Advance as a receivable from Tenant on its books, and does not assert a security interest in the Advance, in any deposit refund owed to Tenant, or in any other property of Tenant (subject only to the contractual offset right described in Consumer ToS § 9.1.4(iii)).

## 4. Service-Fee Installments

In consideration of the service-level accommodation, Tenant agrees to a schedule of service-fee installments to GAM as follows:

| Installment | Due Date | Amount |
|---|---|---|
| 1 | {{Installment_1_Date}} | ${{Installment_1_Amount}} |
| 2 | {{Installment_2_Date}} | ${{Installment_2_Amount}} |
| 3 | {{Installment_3_Date}} | ${{Installment_3_Amount}} |
| 4 | {{Installment_4_Date}} | ${{Installment_4_Amount}} |
| 5 | {{Installment_5_Date}} | ${{Installment_5_Amount}} |
| 6 | {{Installment_6_Date}} | ${{Installment_6_Amount}} |
| 7 | {{Installment_7_Date}} | ${{Installment_7_Amount}} |
| 8 | {{Installment_8_Date}} | ${{Installment_8_Amount}} |
| 9 | {{Installment_9_Date}} | ${{Installment_9_Amount}} |
| 10 | {{Installment_10_Date}} | ${{Installment_10_Amount}} |
| 11 | {{Installment_11_Date}} | ${{Installment_11_Amount}} |
| 12 | {{Installment_12_Date}} | ${{Installment_12_Amount}} |
| **Total** | | **${{Total_Installment_Amount}}** |

The service-fee installments are consideration for the service-level accommodation. The total of the service-fee installments may equal, exceed, or fall below the Advance; that relationship does not transform this SLA into a credit transaction.

## 5. ACH-Pull Authorization

Tenant authorizes GAM, acting through Stripe, Inc., to initiate Automated Clearing House (ACH) debits from the bank account Tenant designates on the Platform (the "**Authorized Account**") on each Installment Due Date set forth in Section 4. Each ACH debit will be in the amount of the Installment due on that date.

**Authorized Account information:**

- Bank: {{Bank_Name}}
- Account ending in: {{Account_Last_4}}
- Routing number ending in: {{Routing_Last_4}}

The ACH-pull authorization remains in effect from the Effective Date until the earlier of: (a) the satisfaction of all {{Total_Installments}} scheduled Installments under Section 4; (b) Tenant's revocation of the authorization as described below; (c) termination of this SLA under Section 8; or (d) closure of Tenant's GAM Platform account.

### 5.1 Failed ACH Pull — Retry at the Same Installment Amount, Plus Pass-Through Fees

Because ACH is governed by the National Automated Clearing House Association (Nacha) all-or-nothing rule, a pull either succeeds in full or is rejected in full; banks do not return a partial amount. If a scheduled Installment pull fails (e.g., R01 insufficient funds, R09 uncollected funds, R02 account closed, or other Nacha return code), the Platform will automatically retry the pull on a later calendar date under GAM's standard failed-pull retry policy described in Consumer ToS § 5.4.

**The retry pull is for:**

- **(a)** The **same Installment amount** originally scheduled under Section 4. **The Installment amount does not change based on the retry date** — the schedule in Section 4 is fixed at enrollment and the retry simply attempts to collect the originally-scheduled Installment on a later day; AND
- **(b)** A **Stripe pass-through fee** equal to Stripe's then-current ACH-return / failure fee charged to GAM for the original (failed) pull. Tenant pre-authorizes this pass-through at GAM's actual cost, without markup by GAM, on the same terms as the broader pass-through framework in Consumer ToS § 5.4.

Worked example: Installment #3 is scheduled for the 1st at $200. The pull on the 1st fails for insufficient funds. The Platform retries on the 4th. The retry pulls $200 (the same Installment amount) plus the applicable Stripe ACH-return fee. If the retry on the 4th also fails, a second retry approximately five business days later attempts to collect $200 plus two accumulated Stripe ACH-return fees.

**If all retry attempts fail**, the unpaid Installment plus accumulated Stripe pass-through fees roll into Tenant's GAM-platform-side balance and become subject to the GAM-First payment-routing rules in Consumer ToS § 5.5. Section 7 of this SLA (No Debt / No Recourse) continues to apply: GAM has no legal recourse to collect the unpaid Installment or the accumulated pass-through fees beyond the service-tier consequences in Consumer ToS § 9.1.4.

The pass-through fees described in this Section 5.1 are not GAM service fees and are not a finance charge under Regulation Z. They are the actual cost of payment processing that GAM incurred and that Tenant pre-authorizes to bear because the event causing the fee was attributable to Tenant's payment activity.

### 5.2 Revocation

Tenant may revoke this ACH-pull authorization at any time by notifying GAM in writing at `support@goldassetmanagement.com`, with at least three (3) business days' notice before the next scheduled Installment Due Date. Revocation stops further ACH pulls under this SLA and triggers the consequences in Consumer ToS § 9.1.4 (service-tier consequences). Revocation does not create a debt and does not give GAM any recourse against Tenant beyond the service-tier consequences expressly enumerated in Consumer ToS § 9.1.4.

## 6. Payment Routing Acknowledgment

Tenant acknowledges and authorizes the GAM-first payment routing described in Consumer ToS § 5.5 (Payment Routing — GAM-First Application) as it applies to this SLA. Specifically:

- When Tenant authorizes any ACH or card payment through the Platform — for rent, for any other Landlord-owed amount, or for any other purpose — the Platform applies the payment first to any then-due Installment under this SLA, on a first-in, first-out basis, before settling any remainder to Tenant's Landlord's Connect balance.
- This routing is the operational mechanism by which Installments are satisfied. It is not a debt-collection action.
- Tenant remains responsible to Tenant's Landlord for any rent unpaid because the payment was routed first to an Installment under this SLA. GAM is not liable for any Landlord remedy that arises from the resulting rent shortfall.

## 7. No Debt / No Recourse Acknowledgment

Tenant and GAM acknowledge and agree that this SLA does not create a debt, a credit obligation, or any enforceable obligation to repay any amount to GAM. **Tenant does not "owe" GAM any sum under this SLA.** GAM's sole and exclusive remedies for non-payment of any Installment are the service-tier consequences expressly enumerated in Consumer ToS § 9.1.4:

- **(i)** Suspension of Tenant's eligibility for the On-Time Pay reporting product until this SLA's Installment schedule is brought current.
- **(ii)** Restriction of Tenant's eligibility to enroll in additional FlexSuite products until this SLA's Installment schedule is brought current.
- **(iii)** Contractual offset of any unpaid Installment balance against any deposit refund otherwise payable to Tenant at lease end, after Landlord-itemized deductions, limited to the deposit-refund residual. Any shortfall is absorbed by GAM and is not pursued against Tenant under any theory.

GAM will not, and may not under this SLA: sue Tenant, file an action in any court, or seek a judgment against Tenant; engage any collection agency or third-party debt collector to recover any amount from Tenant; garnish Tenant's wages, place a lien on Tenant's property, or seize any asset of Tenant's; take or assert any security interest in any property of Tenant's (except as expressly set out in the limited contractual offset above); furnish any payment-history data, default, or other negative information about this SLA to any consumer reporting agency; or threaten any of the foregoing. The Collections Partner described in Consumer ToS § 5.6 has no role in this SLA, and GAM does not refer Installment balances under this SLA to the Collections Partner or any other collector.

## 8. Term and Termination

This SLA takes effect on the Effective Date and continues until the earlier of: (a) the satisfaction of all {{Total_Installments}} scheduled Installments under Section 4; (b) Tenant's revocation of the ACH-pull authorization under Section 5 (in which case the SLA continues with the service-tier consequences of Section 7 applying in lieu of further Installment collection); (c) termination by either party under Section 8.1 or 8.2 below; or (d) the events described in Consumer ToS § 9.1.5 (Bankruptcy and Recharacterization), which terminate this SLA on Tenant's commencement of any bankruptcy or insolvency proceeding and forgive any unpaid Installment obligation in that circumstance.

### 8.1 Termination by Tenant

Tenant may terminate this SLA at any time by notifying GAM in writing at `support@goldassetmanagement.com`. Termination does not relieve Tenant of any Installment that has already been satisfied (those payments are non-refundable, consistent with Consumer ToS § 10) but does stop further Installments under Section 4. Termination triggers the service-tier consequences of Section 7 with respect to any unpaid Installments.

### 8.2 Termination by GAM

GAM may terminate this SLA at any time, with or without notice, for: (a) the events described in Consumer ToS § 18.2 (Termination by GAM under the Consumer ToS); (b) Tenant's chargeback or ACH-return pattern on Installments; (c) Tenant's commencement of any bankruptcy or insolvency proceeding (in which case the forgiveness in Consumer ToS § 9.1.5 applies); or (d) operational, security, or regulatory necessity. Termination by GAM forgives any unpaid Installment obligation under Consumer ToS § 9.1.5(d) where the termination is triggered by an unsatisfied regulatory requirement.

## 9. Incorporation of Consumer Terms of Service

The Consumer ToS, including without limitation Section 5 (Payment Processing), Section 5.5 (Payment Routing), Section 5.6 (Unpaid Rent and Collections), Section 9.1 (FlexDeposit), Section 9.5 (Auto-Renewal Disclosures, to the extent applicable), Section 16 (Limitation of Liability), Section 17 (Indemnification), Section 19 (Dispute Resolution; Binding Arbitration; Class Action Waiver), and Section 20 (Governing Law and Venue), is incorporated into this SLA by reference. **In the event of a conflict between this SLA and the Consumer ToS, this SLA prevails for matters expressly addressed in this SLA, and the Consumer ToS prevails for all other matters.**

For the avoidance of doubt: any dispute arising out of or relating to this SLA is subject to the binding-arbitration, class-action-waiver, and public-injunctive carve-out provisions of Consumer ToS § 19, including the thirty-day opt-out window provided in § 19.6.

## 10. Electronic Signature

By clicking [I AGREE] or by otherwise indicating affirmative assent at the Platform's electronic-signature surface, Tenant electronically signs this SLA in accordance with the federal Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and applicable state Uniform Electronic Transactions Acts. Tenant's electronic signature is the legal equivalent of a handwritten signature. The Platform's audit trail records the Tenant's IP address, user-agent, and timestamp of signature; this audit record is admissible evidence of Tenant's agreement to this SLA.

---

## Signature

By electronically signing below, Tenant:

- Confirms that Tenant has read this SLA in its entirety, including the express-characterization paragraph in Section 2 and the no-debt / no-recourse acknowledgment in Section 7.
- Confirms that Tenant has read and agrees to the Consumer ToS, which is incorporated into this SLA by reference under Section 9.
- Authorizes the ACH-pull schedule described in Section 4.
- Acknowledges the payment-routing authorization described in Section 6 and Consumer ToS § 5.5.

| | |
|---|---|
| **Tenant electronic signature:** | {{Tenant_Signature}} |
| **Tenant printed name:** | {{Tenant_Full_Legal_Name}} |
| **Date of signature:** | {{Signature_Date}} |
| **IP address at signature:** | {{Tenant_IP_Address}} |
| **User-agent at signature:** | {{Tenant_User_Agent}} |

**Countersigned by GAM:**

| | |
|---|---|
| **Authorized signer:** | Gold Asset Management LLC, by its automated enrollment system |
| **Date of countersignature:** | {{Signature_Date}} |

---

## Contact

Questions about this SLA? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
Attn: FlexDeposit Service Terms
2843 East Frontage Road
Amado, AZ 85645
