-- S652 — THE LANDLORD CHOOSES WHETHER TO REVIEW UTILITY BILLS.
--
-- Nic, after the platform-wide version: "the person reading the meters has
-- nothing to do with the landlord opting into whether or not they want to
-- verify them. It needs to be on the landlord... The landlord toggles whether
-- or not they want to be part of the review process or just trust them to go
-- through... Make it two separate things."
--
-- Who may ENTER readings is a permission per person (Team page; a work-trade
-- agreement's field permissions). Whether the bills WAIT for the landlord's
-- approval is this, per company, off by default — bills go through on their
-- own the way they always did. Country Acres (Blu) is switched on.
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS review_utility_bills boolean NOT NULL DEFAULT false;
UPDATE landlords SET review_utility_bills = true WHERE id = 'e8904104-ab16-4d02-b6f8-cac88d738aae';
