DROP TABLE farm.connector_credential_proofs;
DROP FUNCTION farm.connector_credential_proof_lifecycle();
REVOKE ALL ON farm.connector_enrollments,farm.connector_credentials,farm.connector_revocations FROM farm_connector_credential_acceptor;
REVOKE UPDATE (agent_id) ON farm.connector_enrollments FROM farm_connector_credential_acceptor;
REVOKE UPDATE (jti) ON farm.connector_credentials FROM farm_connector_credential_acceptor;
REVOKE USAGE ON SCHEMA farm FROM farm_connector_credential_acceptor;
DROP ROLE farm_connector_credential_acceptor;
