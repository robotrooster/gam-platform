-- S648: a pay link remembers whether its card fee was added on top when it
-- was sent. That is a snapshot of the property's choice, not a fee setting of
-- its own — fee settings live per property only (payments.test.ts guards it)
-- — so it is a plain flag rather than a second "card_fee_payer" column.
ALTER TABLE pos_pay_links ADD COLUMN card_fee_on_top boolean NOT NULL DEFAULT TRUE;
UPDATE pos_pay_links SET card_fee_on_top = (card_fee_payer = 'customer');
ALTER TABLE pos_pay_links DROP COLUMN card_fee_payer;
