-- Owner-issued reset links: the reset role checks that the actor owns the farm and
-- the target is an active member before replacing that member's reset digest.
GRANT SELECT (farm_id, account_id, role, revoked_at) ON farm.memberships TO farm_password_reset;
