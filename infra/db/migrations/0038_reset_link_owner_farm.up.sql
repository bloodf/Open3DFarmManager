-- Owner-issued reset links record the issuing farm so redemption can refuse an
-- account that has since joined another farm. NULL marks a self-service token.
ALTER TABLE farm.password_reset_tokens ADD COLUMN owner_farm_id uuid;
