DROP TABLE farm.account_invites;
DROP FUNCTION farm.account_invite_guard();
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_account_registration;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_account_registration;
REVOKE SELECT, INSERT ON farm.session_accounts, farm.password_credentials, farm.farms, farm.memberships FROM farm_account_registration;
DROP ROLE farm_account_registration;
