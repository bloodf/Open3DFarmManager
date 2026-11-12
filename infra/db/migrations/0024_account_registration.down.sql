DROP TABLE farm.account_invites;
DROP FUNCTION farm.account_invite_guard();
REVOKE SELECT, INSERT ON farm.session_accounts, farm.password_credentials, farm.farms, farm.memberships FROM farm_account_registration;
DROP ROLE farm_account_registration;
