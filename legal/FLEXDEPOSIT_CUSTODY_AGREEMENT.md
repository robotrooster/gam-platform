# FlexDeposit Custody Agreement

**Gold Asset Management**
2843 East Frontage Road, Amado, AZ 85645
Template Version: 2.0
[Effective Date populated by the Platform at signature]

---

> **WHAT THIS IS.** This FlexDeposit Custody Agreement (the
> "**Agreement**") sets out the terms under which you (the
> "**Tenant**") fund your own security deposit in installments
> while **Gold Asset Management LLC** ("**GAM**") holds that
> deposit in custody. You fund your deposit; **GAM advances,
> lends, and floats nothing.**
>
> **This Agreement is not a loan or extension of credit.** GAM is
> not your creditor and you are not GAM's borrower. The
> substantive characterization, no-recourse posture, payment-
> routing authorization, service-tier consequences for a missed
> installment, bankruptcy treatment, and recharacterization
> severability are set out in Section 9.1 of GAM's Consumer Terms
> of Service (the "**Consumer ToS**"), which is incorporated into
> this Agreement by reference and which governs any matter not
> expressly addressed here. Capitalized terms used here without
> definition have the meaning given in the Consumer ToS.

---

## 1. Parties and Effective Date

This Agreement is between:

- **GAM**: Gold Asset Management LLC, a Delaware limited liability company.
- **Tenant**: {{Tenant_Full_Legal_Name}}, the individual identified by the GAM Platform account at {{Tenant_Email}}.

The Effective Date of this Agreement is the date Tenant electronically signs below. By electronically signing, Tenant agrees to the terms of this Agreement, acknowledges receipt of the Consumer ToS, and authorizes the ACH-pull schedule set out in Section 4.

## 2. Express Characterization and Intent

The parties expressly agree and intend that this Agreement is a custody-and-installment service only. **This Agreement is not, and shall not be construed as, a loan, an extension of consumer credit, a "credit transaction" under the Truth in Lending Act (15 U.S.C. § 1601 et seq.) or Regulation Z (12 C.F.R. Part 1026), an extension of credit under the Equal Credit Opportunity Act (15 U.S.C. § 1691 et seq.) or Regulation B (12 C.F.R. Part 1002), a consumer financial product or service under the Consumer Financial Protection Act (12 U.S.C. § 5481 et seq.), a debt under the Fair Debt Collection Practices Act (15 U.S.C. § 1692 et seq.), or a "loan" or "extension of credit" under the consumer-finance, consumer-installment-loan, small-loan, or usury statutes of any state.**

The installments described in Section 4 fund **Tenant's own security deposit** — they are not repayment of any advance, loan, or extension of credit, because GAM advances and lends nothing. **No debt is created by this Agreement**, and Tenant has no enforceable obligation to repay any amount to GAM. The custody fee in Section 7 is consideration for the custody service only; it is not principal, not interest, and not a finance charge as defined in 12 C.F.R. § 1026.4.

## 3. Custody of Your Deposit

Tenant's security deposit for the lease at {{Property_Address}}, Unit {{Unit_Number}}, associated with {{Landlord_Display_Name}}, is **${{Deposit_Total}}** (the "**Deposit**"). GAM holds the Deposit in a pooled custody account as Tenant funds it in the installments set out in Section 4.

**GAM does not advance, lend, or float any portion of the Deposit to {{Landlord_Display_Name}} or to anyone else.** {{Landlord_Display_Name}}'s books reflect the Deposit in full as of {{Move_In_Date}}, but the funds are held by GAM in custody and are not paid to {{Landlord_Display_Name}} at move-in. Because GAM does not float the Deposit, the amount actually available to {{Landlord_Display_Name}} and to Tenant at any time is limited to the amount Tenant has actually funded into custody.

## 4. Deposit-Funding Installments

Tenant funds the Deposit into GAM custody on the following schedule of {{Total_Installments}} monthly installments. Installment 1 is collected at move-in alongside Tenant's first rent and any move-in charges; the remaining installments are collected monthly thereafter.

| Installment | Due Date | Amount |
|---|---|---|
| 1 | {{Installment_1_Date}} | ${{Installment_1_Amount}} |
| 2 | {{Installment_2_Date}} | ${{Installment_2_Amount}} |
| 3 | {{Installment_3_Date}} | ${{Installment_3_Amount}} |
| 4 | {{Installment_4_Date}} | ${{Installment_4_Amount}} |
| 5 | {{Installment_5_Date}} | ${{Installment_5_Amount}} |
| 6 | {{Installment_6_Date}} | ${{Installment_6_Amount}} |
| **Total funded into custody** | | **${{Total_Installment_Amount}}** |

The installments fund Tenant's own Deposit. Their total equals the Deposit; no installment is a fee, interest, or charge of any kind.

## 5. ACH-Pull Authorization

Tenant authorizes GAM, acting through Stripe, Inc., to initiate Automated Clearing House (ACH) debits from the bank account Tenant designates on the Platform (the "**Authorized Account**") on each Installment Due Date set forth in Section 4. Each ACH debit will be in the amount of the installment due on that date.

**Authorized Account information:**

- Bank: {{Bank_Name}}
- Account ending in: {{Account_Last_4}}
- Routing number ending in: {{Routing_Last_4}}

The ACH-pull authorization remains in effect from the Effective Date until the earlier of: (a) Tenant having fully funded the Deposit under Section 4; (b) Tenant's revocation of the authorization as described below; (c) termination of this Agreement under Section 9; or (d) closure of Tenant's GAM Platform account.

### 5.1 Failed ACH Pull — Same Installment Amount, Plus Pass-Through Fees

Because ACH is governed by the National Automated Clearing House Association (Nacha) all-or-nothing rule, a pull either succeeds in full or is rejected in full; banks do not return a partial amount. If a scheduled installment pull fails (e.g., R01 insufficient funds, R09 uncollected funds, R02 account closed, or other Nacha return code), the Platform will retry the pull on a later calendar date.

**The retry pull is for:**

- **(a)** The **same installment amount** originally scheduled under Section 4. **The installment amount does not change based on the retry date** — the schedule in Section 4 is fixed at enrollment and the retry simply attempts to collect the originally-scheduled installment on a later day; AND
- **(b)** A **Stripe pass-through fee** equal to Stripe's then-current ACH-return / failure fee charged to GAM for the failed pull, **at GAM's actual cost, without markup**, on the same terms as the broader pass-through framework in Consumer ToS § 5.4.

**If both pull attempts for an installment fail**, that installment is simply not funded that month. Tenant's Deposit is under-funded by that amount; **nothing is accelerated, no balance becomes "due in full," and GAM has no recourse.** Later installments and the GAM-first routing in Section 6 continue to fund the Deposit, and Tenant may voluntarily fund the remaining balance at any time. The consequences of an unfunded installment are limited to those in Section 8 and Consumer ToS § 9.1.5.

The pass-through fees in this Section 5.1 are the actual cost of payment processing GAM incurred and that Tenant pre-authorizes to bear; they are not GAM service fees and not a finance charge under Regulation Z.

### 5.2 Revocation

Tenant may revoke this ACH-pull authorization at any time by notifying GAM in writing at `support@goldassetmanagement.com`, with at least three (3) business days' notice before the next scheduled Installment Due Date. Revocation stops further ACH pulls under this Agreement and leaves the Deposit funded only to the extent Tenant has paid into custody. Revocation does not create a debt and gives GAM no recourse against Tenant beyond the service-tier consequences in Section 8 and Consumer ToS § 9.1.5.

## 6. Payment Routing Acknowledgment

Tenant acknowledges and authorizes the GAM-first payment routing described in Consumer ToS § 5.5 as it applies to this Agreement. When Tenant authorizes any ACH or card payment through the Platform — for rent, for any other Landlord-owed amount, or for any other purpose — the Platform applies the payment first to any then-due installment under this Agreement, on a first-in, first-out basis, before settling any remainder to {{Landlord_Display_Name}}'s Connect balance. **This routing is the operational mechanism by which the Deposit is funded; it is not a debt-collection action.** Tenant remains responsible to {{Landlord_Display_Name}} for any rent unpaid because the payment was routed first to an installment under this Agreement.

## 7. Custody Fee

While GAM holds the Deposit in custody, GAM charges a custody fee of **${{Custody_Fee}} per month** (the "**Custody Fee**"). The Custody Fee is consideration for the custody service only. If Tenant moves to another property on the Platform and the Deposit is forwarded into custody for the new property, the Custody Fee dissolves once the Deposit is marked in the new operator's books, and Tenant will not be charged a further Custody Fee for the forwarded Deposit (Consumer ToS § 9.1.6).

## 8. No Debt / No Recourse Acknowledgment

Tenant and GAM acknowledge and agree that this Agreement does not create a debt, a credit obligation, or any enforceable obligation to repay any amount to GAM. **Tenant does not "owe" GAM any sum under this Agreement.** If Tenant does not fund a scheduled installment, the Deposit is simply under-funded, and GAM's sole and exclusive consequences are those expressly enumerated in Consumer ToS § 9.1.5:

- **(i)** Tenant's eligibility to enroll in other FlexSuite products (FlexPay, FlexCharge, FlexCredit) may be restricted until Tenant's installments are current.
- **(ii)** At lease end, any portion of the Deposit Tenant did not fund is not part of the deposit held for Tenant; {{Landlord_Display_Name}}'s deductions and Tenant's refund are calculated against the amount actually held in custody.

GAM will not, and may not under this Agreement: sue Tenant, file an action in any court, or seek a judgment against Tenant; engage any collection agency or third-party debt collector to recover any amount from Tenant; garnish Tenant's wages, place a lien on Tenant's property, or seize any asset of Tenant's; take or assert any security interest in any property of Tenant's, in any deposit refund, or otherwise; furnish any payment-history data, default, or other negative information about this Agreement to any consumer reporting agency; or threaten any of the foregoing. The Collections Partner described in Consumer ToS § 5.6 is engaged only for landlord-owed unpaid rent and has no role in this Agreement.

## 9. Custody, Return, and Termination

- **At lease end / move-out**, GAM returns the Deposit to Tenant through the deposit-return flow in Consumer ToS § 6, less any deductions {{Landlord_Display_Name}} is entitled to take under the lease and applicable law, and limited to the amount actually held in custody.
- **On Tenant's default under the lease**, {{Landlord_Display_Name}}'s claim is satisfied from the Deposit GAM holds for Tenant, limited to the amount actually funded.
- This Agreement takes effect on the Effective Date and continues until the earlier of: (a) Tenant having fully funded the Deposit; (b) the return or disbursement of the Deposit at lease end; (c) Tenant's revocation under Section 5.2 (in which case the consequences of Section 8 apply); or (d) the bankruptcy events described in Consumer ToS § 9.1.8, on which GAM may terminate this Agreement, asserts no claim against Tenant's bankruptcy estate, and the Deposit remains returnable to Tenant under Consumer ToS § 6.
- Where applicable law requires a security deposit to be held in a separate, escrow, or interest-bearing account, GAM holds it accordingly and pays any required statutory interest.

## 10. Incorporation of Consumer Terms of Service

The Consumer ToS, including without limitation Section 5 (Payment Processing), Section 5.5 (Payment Routing), Section 5.6 (Unpaid Rent and Collections), Section 6 (Security Deposits), Section 9.1 (FlexDeposit), Section 16 (Limitation of Liability), Section 17 (Indemnification), Section 19 (Dispute Resolution; Binding Arbitration; Class Action Waiver), and Section 20 (Governing Law and Venue), is incorporated into this Agreement by reference. **In the event of a conflict between this Agreement and the Consumer ToS, this Agreement prevails for matters expressly addressed here, and the Consumer ToS prevails for all other matters.**

For the avoidance of doubt: any dispute arising out of or relating to this Agreement is subject to the binding-arbitration, class-action-waiver, and public-injunctive carve-out provisions of Consumer ToS § 19, including the thirty-day opt-out window provided in § 19.6.

## 11. Electronic Signature

By clicking [I AGREE] or by otherwise indicating affirmative assent at the Platform's electronic-signature surface, Tenant electronically signs this Agreement in accordance with the federal Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and applicable state Uniform Electronic Transactions Acts. Tenant's electronic signature is the legal equivalent of a handwritten signature. The Platform's audit trail records the Tenant's IP address, user-agent, and timestamp of signature; this audit record is admissible evidence of Tenant's agreement to this Agreement.

---

## Signature

By electronically signing below, Tenant:

- Confirms that Tenant has read this Agreement in its entirety, including the express-characterization paragraph in Section 2 and the no-debt / no-recourse acknowledgment in Section 8.
- Confirms that Tenant has read and agrees to the Consumer ToS, which is incorporated into this Agreement by reference under Section 10.
- Authorizes the ACH-pull schedule described in Section 4 and the Custody Fee in Section 7.
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

Questions about this Agreement? Email `support@goldassetmanagement.com` or write to:

Gold Asset Management LLC
Attn: FlexDeposit Custody Service
2843 East Frontage Road
Amado, AZ 85645
