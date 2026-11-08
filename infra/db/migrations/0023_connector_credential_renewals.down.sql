LOCK TABLE farm.connector_credential_renewals IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM farm.connector_credential_renewals) THEN RAISE EXCEPTION 'Retain renewal operations and receipts; disable issuance for operational rollback'; END IF; END $$;
-- RESTRICT is deliberate: dependent objects must never be removed implicitly.
DROP TABLE farm.connector_credential_renewals RESTRICT;
DROP FUNCTION farm.connector_renewal_lifecycle() RESTRICT;
REVOKE SELECT ON farm.connector_enrollments,farm.connector_credentials,farm.connector_credential_successors,farm.connector_revocations FROM farm_connector_credential_renewer;
REVOKE UPDATE(agent_id) ON farm.connector_enrollments FROM farm_connector_credential_renewer;
REVOKE UPDATE(jti) ON farm.connector_credentials,farm.connector_credential_successors FROM farm_connector_credential_renewer;
REVOKE INSERT ON farm.connector_credential_successors FROM farm_connector_credential_renewer;
REVOKE USAGE ON SCHEMA farm FROM farm_connector_credential_renewer;
DROP ROLE farm_connector_credential_renewer;
