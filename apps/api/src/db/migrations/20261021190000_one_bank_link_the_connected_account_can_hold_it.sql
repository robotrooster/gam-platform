-- ONE BANK LINK. A LANDLORD SHOULD NOT FIND AND LOG INTO THE SAME BANK TWICE.
--
-- 10/20 (Nic): "We need a way to link the bank account once and have it be
-- everything. It needs to do the feed. It needs to do the deposits or whatever
-- one flow needs to be the whole thing and it boggles my mind that Stripe being
-- one of the biggest payment processors in the world has no functionality for
-- that."
--
-- Stripe does have it. GAM was running two Financial Connections flows at the
-- same bank:
--   * Step one (Connect onboarding) collects the payout bank. When Stripe is set
--     to collect it with Financial Connections, that link belongs to the
--     CONNECTED ACCOUNT.
--   * Step two (the Bank page) made a SECOND link, owned by GAM's platform
--     customer, purely so the feed could read transactions.
-- Same bank, same landlord, two bank sign-ins.
--
-- On the morning of 10/20 Nic turned on, in the Stripe Dashboard under
-- Settings > Connect > Payouts > External accounts, collection of bank details
-- with Financial Connections plus the optional financial-data access for
-- balances, account ownership details AND transactions. The intent is that the
-- link a landlord makes in step one can then be READ for transactions, leaving
-- step two nothing to ask.
--
-- NOT YET PROVEN BY A REAL OBJECT, and these columns are shaped so that does
-- not matter. No onboarding has run since the setting changed: measured against
-- live Stripe on 10/20, every Financial Connections link the three live
-- connected accounts hold carries permissions exactly ["payment_method"] with
-- no subscriptions. The code reads `permissions` off each Stripe object and
-- adopts nothing without `transactions`, so if the setting turns out to widen
-- only what the PLATFORM may request rather than what each new link records,
-- every landlord simply keeps doing step two by hand as they do today.
-- A connected account may also hold NO Financial Connections link at all —
-- Mountain View's payout bank was typed in by routing and account number — in
-- which case there is nothing to adopt and step two stays.
--
-- WHY THESE COLUMNS, and this is the part that is easy to get wrong:
--
--   * An onboarding-collected link is INVISIBLE to the platform unless every
--     call carries the connected account id in the Stripe-Account header.
--     Verified against live Stripe on 10/20: retrieving TruBlu Management LLC's
--     link (fca_1USLR9...) without the header is a flat 404 "No such account";
--     with the header it reads fine. So the row has to remember WHICH Stripe
--     account holds it, or the feed cannot read it at all.
--     NULL = held by GAM's platform customer, which is every link that exists
--     today (Mountain View since 09-03, Oak Park since 09-26). Nothing about
--     those changes.
--
--   * Financial Connections permissions are FIXED AT LINK TIME — Stripe: "account
--     data accessible to you is limited to the data you specified in this
--     parameter." A link made before this morning carries payment_method only and
--     can NEVER be read for transactions; asking anyway returns a 400 naming the
--     missing permission (verified live). fc_permissions records what a link
--     actually carries so the Bank page and the fee debit can say what GAM can
--     and cannot do with it without a Stripe round trip per render.
--
--   * source says whether the landlord did a second bank sign-in or not, because
--     the page has to tell the truth either way: a landlord who granted this in
--     onboarding is told their bank is already connected and what GAM can see;
--     one who onboarded before the switch still gets step two, ONCE.
--     Nic, 10/20, about Blu: "he still only has to do step two either way,
--     right?" — yes, and this is what keeps it from being twice.
--
--   * landlords.connect_bank_checked_at is the bound on Stripe calls. GAM asks the
--     connected account what links it holds when there is no linked bank yet, and
--     remembers that it asked. It is not a cache of the answer: the answer is the
--     bank_connections row.
--
-- No backfill, deliberately. The two live feeds are platform-held and correct as
-- they stand (stripe_connect_account_id NULL, source 'landlord_link'), and the
-- onboarding links that exist right now carry payment_method only — Oak Park's
-- (fca_1U5WDs..., inactive) and TruBlu's (fca_1USLR9..., active) — so there is
-- nothing readable to adopt. Adoption happens when a connected account actually
-- holds a transactions-capable link, which is from today's onboardings on.
--
-- Safe drop: this migration only ADDS nullable columns (and one with a default
-- that matches every existing row). Reversing it means dropping them.

ALTER TABLE bank_connections
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS source                    text NOT NULL DEFAULT 'landlord_link',
  ADD COLUMN IF NOT EXISTS fc_permissions            text[];

-- Idempotent on a second apply: a CHECK cannot be added twice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bank_connections'::regclass
       AND conname  = 'bank_connections_source_check'
  ) THEN
    ALTER TABLE bank_connections
      ADD CONSTRAINT bank_connections_source_check
      CHECK (source IN ('landlord_link', 'connect_onboarding'));
  END IF;
END $$;

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS connect_bank_checked_at timestamptz;

COMMENT ON COLUMN bank_connections.stripe_connect_account_id IS
  '10/20: the connected account that HOLDS this Financial Connections link, when the landlord granted it inside Connect onboarding. Every Stripe read of such a link must carry it in the Stripe-Account header or Stripe answers 404. NULL = held by GAM''s platform customer (every link made before 10/20).';

COMMENT ON COLUMN bank_connections.source IS
  '10/20: landlord_link = the landlord signed in to their bank on the Bank page. connect_onboarding = the link came from step one, so step two must not ask again.';

COMMENT ON COLUMN bank_connections.fc_permissions IS
  '10/20: the permissions the link actually carries, as Stripe reported them at link time. Fixed at link time and never widened, so this is what decides whether GAM can read transactions, read a balance, or do neither.';

COMMENT ON COLUMN landlords.connect_bank_checked_at IS
  '10/20: when GAM last asked this landlord''s connected account which bank links it holds. Bounds the Stripe calls — the answer itself is a bank_connections row, not this column.';
