# The 762 customers — what I need, and what I don't

**The import is not actually blocked.** The importer never merges anybody by
design (merging two strangers welds their histories together with nothing on
screen afterward to show it happened). So all 762 can come in right now as
themselves, and any pair you say is one person gets merged later, by hand, on
purpose.

So there is only **one** question I need before importing, and it is a quick one.

---

## 1. THE ONLY THING I NEED: 16 rows that are not people

Campground Master used the customer list as scratch paper. These would come in
as customers of Mountain View and sit in your list forever:

| Name | Rows |
|---|---|
| Do Not Fill | 3 |
| Out Of Order / out of order | 3 |
| Summer Overload | 3 |
| Park Model | 2 |
| Week | 2 |
| minor2, minor3 | 2 |
| unknown1, Unknown2 | 2 |

**I recommend leaving all 16 behind.** They are site states and placeholders,
not customers. Say the word and they are dropped; say otherwise and they come in.

(Seven more were already refused for having no letters at all: "1 1", "719",
"N A", "ok" ×2, "RJ", "unknown".)

---

## 2. NO RUSH: 10 pairs with the same name twice

Almost certainly one person entered twice. They import as two records either
way; tell me whenever and I will merge them properly.

Ray Artiaga · Nate Harveston · Rosie & Don Jorgensen · Rick Moran ·
Tim Nicolai · AJ Rhoades · Dusty Rhoades · Sue Richards · John Stark ·
Peter Teuber

---

## 3. NO RUSH: 7 pairs sharing a phone number, different names

These are the ones only you can call. My read on each:

| Pair | My read |
|---|---|
| Steve DiEgidio · Steve **TiEgipio** | one person, fat-fingered |
| Leslie Dixwell · Leslie **utah** | one person, the second is a placeholder |
| Susan Christian · Suzanne Christiansen | probably one person |
| Jeremy Ciancanelli · Jeremy J | probably one person |
| Matthew Gomez · Richard Gomez | probably two — father and son on one phone |
| Dalke Tucker · Phil Tucker | probably two |
| Martin Pina · Donald Premus | two different people sharing a number |

## 4. Kent Nielsen · Kent & Kelly Nielsen

One household, two records — the RV 71 pair. Merge when you want.

---

## Also: two customers I need for the checks sitting in the drawer

Both are in this file, so the import brings them in:

- **Donald Hamp** — Chattaroy, WA. Propane $49.25, check **167**. The sale is
  already recorded as cash with nobody attached; it needs Hamp and the tender
  corrected.
- **Mike Prevenas** — propane $23.92, check **1006**. Not recorded yet.

---

# ANSWERED 10/24 — the rules the import now follows

1. **The 16 non-people rows: left behind.** Plus the 7 already refused.
2. **The 10 same-name pairs are EXACT duplicates** — same spelling, same case.
   What differs is completeness: one row carries contact details, its twin is
   blank. So they merge safely and the fuller row wins.
3. **Couples are split into two people.** Nic: *"We don't want couples being on
   there as one customer."* Rosie & Don Jorgensen → Rosie, Don. Kent & Kelly
   Nielsen → Kent, Kelly.
4. **No full last name → not a person.** Drops "Jeremy J" and the blank
   first-name Tucker row.
5. **Same phone = one person**, except **Matthew and Richard Gomez**, who are
   two (father and son on one phone).
6. **"Dalke Tucker" was an error — keep only Phil Tucker.** (Note: a real
   **Dale** Tucker exists on a different phone in Indiana and is a different
   person. Leave him alone.)
7. **Kent and Kelly Nielsen stay as two records.** A FAMILY GROUPING is wanted
   instead of a merge: *"if one person makes the stay and the other person makes
   the stay, it kind of goes on both of their histories."* Its own piece of
   work, also the right answer for the father-and-son pairs.

## Martin Pina and Donald Premus — NOT a new blacklist feature

Nic, 10/24: *"that was my way of saying they left without paying. The archived
invoices from Square that I still have to import are going to show some
outstanding balances from them... There is evidence to back them up."*

So this is **the left-owing flag that already exists**, not a blacklist. It is
the better instrument anyway: the amount is frozen at import, other landlords
see "high risk — owes other people money" with no specifics, and the evidence is
the invoice itself rather than anybody's opinion. Nothing new to build.

They come in as ordinary customers now; the flag arrives with the Square import,
which is still inside the onboarding window the frozen amount requires.

**One thing their own data will produce:** these two SHARE A PHONE NUMBER. If a
Square invoice carries that phone, a name+phone match could reach the wrong man.
The matcher handles it — the name has to agree too, and "same phone, different
name" goes to the admin review queue instead of flagging anybody. Worth watching
when those invoices land.
