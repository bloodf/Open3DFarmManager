DROP TABLE farm.memberships;
DROP TABLE farm.farms;
DROP FUNCTION farm.membership_lifecycle();
REVOKE SELECT ON farm.session_accounts, farm.account_sessions, farm.connector_enrollments FROM farm_enrollment_approver;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_enrollment_approver;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_enrollment_approver;
REVOKE UPDATE (status) ON farm.connector_enrollments FROM farm_enrollment_approver;
REVOKE USAGE ON SCHEMA farm FROM farm_enrollment_approver;
DROP ROLE farm_enrollment_approver;
