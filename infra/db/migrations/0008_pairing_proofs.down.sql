DROP TABLE farm.pairing_proofs;
DROP FUNCTION farm.pairing_proof_lifecycle();
REVOKE ALL ON farm.pairing_requests FROM farm_pairing_proof_runtime;
REVOKE UPDATE (agent_id) ON farm.pairing_requests FROM farm_pairing_proof_runtime;
REVOKE USAGE ON SCHEMA farm FROM farm_pairing_proof_runtime;
DROP ROLE farm_pairing_proof_runtime;
