# Paper bills: hand-delivered, printed before the office opens

Spec from Nic, 10/26. Not built yet. He has a landlord onboarding 25 units who
works this way.

## Why

*"We get a lot of people that still are old school. Landlords that I talk to
still hand deliver bills to the tenants' doors on the first of each month,
especially where utilities are billed back and they don't exactly know what
their bill is going to be."*

## The opt-in

A per-resident choice — **this person prefers to receive a paper bill** — set
during onboarding or at lease signing, so it is captured with everything else
rather than hunted for later. (It belongs beside the other onboarding answers;
see the property settings questionnaire.)

Plus a landlord-level override for the ones who do not want to think about it:
*"maybe there's a quick toggle for landlords that are just like, I'm going to
print them all anyway."*

## The print run

When the monthly bills generate (7am), the ones for residents on the paper list
**print themselves**, to the printer attached to the office machine. Not a
button someone has to find.

*"As soon as the bills generate at 7am, I want it to force print all the bills
that need to be hand delivered. It doesn't need to print all the ones that
aren't opted into that. So on the first, when you come into the office in the
morning, the stack of papers is already ready for you to go. That would be
super killer."*

Only the opted-in ones, unless the landlord set print-everything.

## What is on the page

A one-page summary per resident, and it has to carry the detail that makes a
hand-delivered bill worth delivering:

- The charges and the total owed.
- **Utility usage breakdown** — per utility, with the **previous read** and the
  current read, since the whole reason these landlords deliver by hand is that
  the resident does not know what the utility part will be.
- Any credit applied, and what is still owed.

## Open — needs a decision before building

A browser cannot silently print to a specific printer from a cron job at 7am;
something has to be running on that office machine. The plausible shapes:

1. **A page the office machine leaves open** that wakes at the run and prints
   what is queued. Simplest, no install, but the tab has to stay open and the
   browser still shows its print dialog unless kiosk printing is enabled.
2. **A small local print agent** on the office machine that polls for the day's
   PDFs and sends them to the default printer. Reliable and unattended; it is
   software to install and keep alive.
3. **A queue plus one click** — the stack is generated and waiting, and whoever
   opens the office prints it in one action. Not what he asked for, but it needs
   nothing installed and never silently fails.

This is a new mechanism, so it needs his sign-off and a cost before it is built.
